# Install or upgrade the AI Space Server edition on Windows from an unpacked release archive
# (docs/release.md):
#
#   tar -xzf ai-space-server-<version>-windows-x64.tar.gz
#   powershell -ExecutionPolicy Bypass -File ai-space-server-<version>-windows-x64\install.ps1
#
# The Windows counterpart of release/install.sh and deploy/install.sh together. The program goes
# to $env:AI_SPACE_PREFIX (default %LOCALAPPDATA%\ai-space) as releases\<version>, with the
# junction `current` pointing at the one that runs; the workspace (SPACE_HOME, default
# %USERPROFILE%\.ai-space) with apps, databases and .env is never touched. Then the workspace is
# initialized, the `space` command is put on the user's Path, the background service (a Task
# Scheduler task started at logon) is written to run from `current`, and the health check is
# waited for. If that fails, `current` goes back to the previous release and its service is
# installed again. The last three releases stay for a manual rollback. It needs no elevation.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
# Windows PowerShell started from PowerShell 7 inherits PSModulePath with 7's modules first, and
# then finds none of its own (Get-FileHash, ConvertFrom-Json): give it back the one it ships with.
if ($PSVersionTable.PSEdition -ne 'Core') {
  $env:PSModulePath = @("$env:USERPROFILE\Documents\WindowsPowerShell\Modules", "$env:ProgramFiles\WindowsPowerShell\Modules", "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules") -join ';'
}

function Fail([string]$Message) {
  [Console]::Error.WriteLine("ai-space install: $Message")
  exit 1
}

$Src = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $Src 'RELEASE.json'))) { Fail 'run this from an unpacked ai-space release (RELEASE.json missing)' }
$Release = Get-Content -LiteralPath (Join-Path $Src 'RELEASE.json') -Raw | ConvertFrom-Json
if ($Release.os -ne 'windows') { Fail "this archive is for $($Release.os); on Windows use the windows archive" }
$Version = [string]$Release.version
$Commit = [string]$Release.commit

$Prefix = if ($env:AI_SPACE_PREFIX) { $env:AI_SPACE_PREFIX } else { Join-Path $env:LOCALAPPDATA 'ai-space' }
$Releases = Join-Path $Prefix 'releases'
$Current = Join-Path $Prefix 'current'
$Dest = Join-Path $Releases $Version
New-Item -ItemType Directory -Force -Path $Releases | Out-Null

# A junction needs no privilege, and removing one never follows it into the release.
function Get-CurrentRelease {
  if (-not (Test-Path -LiteralPath $Current)) { return $null }
  $target = (Get-Item -LiteralPath $Current -Force).Target
  if ($target -is [array]) { $target = $target[0] }
  if (-not $target) { return $null }
  return Split-Path -Leaf $target
}

function Set-CurrentRelease([string]$Name) {
  if (Test-Path -LiteralPath $Current) {
    if (-not (Get-Item -LiteralPath $Current -Force).Target) { Fail "$Current is a real directory, not the link this installer makes; move it away first" }
    [System.IO.Directory]::Delete($Current)
  }
  New-Item -ItemType Junction -Path $Current -Target (Join-Path $Releases $Name) | Out-Null
}

function Invoke-Space([string]$Root, [string[]]$Arguments) {
  $bun = Join-Path $Root 'runtime\bun.exe'
  Push-Location -LiteralPath $Root
  try { & $bun (Join-Path $Root 'src\index.ts') @Arguments } finally { Pop-Location }
}

function Get-SpacePort([string]$Workspace) {
  if ($env:SPACE_PORT) { return $env:SPACE_PORT }
  $envFile = Join-Path $Workspace '.env'
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^SPACE_PORT=' } | Select-Object -First 1
    if ($line) { return ($line -replace '^SPACE_PORT=', '').Trim(" `t`"'") }
  }
  return '8700'
}

# The `space` command: a small file beside the program that runs whatever `current` points at.
function Install-Command {
  $bin = Join-Path $Prefix 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $shim = "@echo off`r`nrem Written by the ai-space installer. Runs the release that `current` points at.`r`n`"%~dp0..\current\runtime\bun.exe`" `"%~dp0..\current\src\index.ts`" %*`r`n"
  [System.IO.File]::WriteAllText((Join-Path $bin 'space.cmd'), $shim, (New-Object System.Text.ASCIIEncoding))
  if ($env:AI_SPACE_NO_PATH) { return }
  # The user's own Path, read and written in the registry as it stands (its kind, its %VAR%
  # references), and only when the directory is missing; src/space/service.ts takes it off the same way.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $kind = if ($raw) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $parts = @($raw.Split(';'))
  if ($parts -notcontains $bin) {
    $key.SetValue('Path', ((@($parts | Where-Object { $_ }) + $bin) -join ';'), $kind)
    # A registry write alone tells no running program; setting and clearing a variable does.
    [Environment]::SetEnvironmentVariable('AI_SPACE_PATH_CHANGED', '1', 'User')
    [Environment]::SetEnvironmentVariable('AI_SPACE_PATH_CHANGED', $null, 'User')
    Write-Output "the space command is $bin\space.cmd; it is on your Path in terminals opened from now on"
  }
}

# Brings `current` up: workspace, command, background service, health check. True when it answers.
# What the steps print goes to the host, so the function returns only its answer.
function Start-Current {
  $root = $Current
  $workspace = (Invoke-Space $root @('service', 'workspace') | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or -not $workspace) { return $false }
  Invoke-Space $root @('init') | Out-Host
  if ($LASTEXITCODE -ne 0) { return $false }
  $port = Get-SpacePort $workspace
  Install-Command | Out-Host
  Invoke-Space $root @('service', 'install', '--root', $root, '--bun', (Join-Path $root 'runtime\bun.exe')) | Out-Host
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$port/healthz"
      if ($r.StatusCode -eq 200) {
        Write-Host "ai-space core: installed, answering on 127.0.0.1:$port (workspace $workspace)"
        return $true
      }
    } catch { }
  }
  Invoke-Space $root @('service', 'status') | Out-Host
  [Console]::Error.WriteLine("ai-space is not answering on 127.0.0.1:$port; its log is named above")
  return $false
}

$Prev = Get-CurrentRelease

# Copy the release into place unless this very build is already there.
$destCommit = $null
if (Test-Path -LiteralPath (Join-Path $Dest 'RELEASE.json')) { $destCommit = (Get-Content -LiteralPath (Join-Path $Dest 'RELEASE.json') -Raw | ConvertFrom-Json).commit }
if (($Src.TrimEnd('\') -ne $Dest.TrimEnd('\')) -and ($destCommit -ne $Commit)) {
  if (Test-Path -LiteralPath $Dest) {
    # Another build of this version is there, and a running service holds its files open.
    if ($Prev -eq $Version) { Invoke-Space $Current @('service', 'stop') | Out-Null }
    Remove-Item -LiteralPath $Dest -Recurse -Force
  }
  if (Test-Path -LiteralPath "$Dest.new") { Remove-Item -LiteralPath "$Dest.new" -Recurse -Force }
  Copy-Item -LiteralPath $Src -Destination "$Dest.new" -Recurse
  Rename-Item -LiteralPath "$Dest.new" -NewName $Version
}

Set-CurrentRelease $Version
Write-Output "ai-space $Version ($Commit) in $Dest"

if (Start-Current) {
  # Keep the three newest releases, and always the one that runs and the one before it.
  $keep = @(Get-ChildItem -LiteralPath $Releases -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object { $_.Name }) + $Version
  if ($Prev) { $keep += $Prev }
  Get-ChildItem -LiteralPath $Releases -Directory | Where-Object { $keep -notcontains $_.Name -and $_.Name -notlike '*.new' } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  exit 0
}

[Console]::Error.WriteLine("ai-space $Version did not come up")
if ($Prev -and ($Prev -ne $Version) -and (Test-Path -LiteralPath (Join-Path $Releases $Prev))) {
  [Console]::Error.WriteLine("rolling back to $Prev")
  Set-CurrentRelease $Prev
  Start-Current | Out-Null
  [Console]::Error.WriteLine("rolled back to $Prev; the program changed back, the workspace data was not touched. If $Version migrated a database, see docs/release.md#rollback")
}
exit 1
