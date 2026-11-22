# Install ai-space on Windows with one command (docs/release.md#one-command-install):
#
#   irm https://ai-space.me/install.ps1 | iex
#
# The Windows counterpart of release/get.sh, published with a release as `install.ps1`. It picks
# the Windows Server archive of the same release, checks it against the release's SHA256SUMS,
# unpacks it and runs the archive's own install.ps1: the program under %LOCALAPPDATA%\ai-space,
# the workspace %USERPROFILE%\.ai-space, a background service of this user on 127.0.0.1:8700 (a
# Task Scheduler task started at logon). It asks nothing and needs no elevation, Bun or account;
# then the panel opens in a browser. One agent CLI signed in on this machine (Claude Code or
# Codex) is what ai-space needs to work, and it never installs one for you.
#
# Settings, all optional (environment variables):
#   AI_SPACE_VERSION=0.2.0     that release instead of the latest
#   AI_SPACE_PREFIX=<dir>      where the program goes (default %LOCALAPPDATA%\ai-space)
#   SPACE_HOME=<dir>           where the workspace goes (default %USERPROFILE%\.ai-space)
#   AI_SPACE_DOWNLOAD=<url>    where the release's files are (a mirror, or a directory for tests)
#   AI_SPACE_NO_OPEN=1         do not open a browser at the end
#   AI_SPACE_NO_PATH=1         do not add the space command's directory to the user's Path

# All of it in one function, so a download cut short runs nothing.
function Install-AISpace {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell started from PowerShell 7 inherits PSModulePath with 7's modules first, and
  # then finds none of its own (Get-FileHash, ConvertFrom-Json): give it back the one it ships with.
  if ($PSVersionTable.PSEdition -ne 'Core') {
    $env:PSModulePath = @("$env:USERPROFILE\Documents\WindowsPowerShell\Modules", "$env:ProgramFiles\WindowsPowerShell\Modules", "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules") -join ';'
  }
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell draws a progress bar that slows a download many times over
  $repo = 'ericz-lab/ai-space'

  function Fail([string]$Message) { throw "ai-space install: $Message" }

  # A mirror is an address, or a directory on this machine (what the tests use).
  function Get-ReleaseFile([string]$Base, [string]$Name, [string]$To) {
    if ($Base -match '^https?://') { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name" -OutFile $To }
    else { Copy-Item -LiteralPath (Join-Path ($Base -replace '^file:///?', '') $Name) -Destination $To }
  }

  function Find-Cli([string]$Name) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return $true }
    foreach ($dir in @("$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.claude\local", "$env:USERPROFILE\.bun\bin", "$env:APPDATA\npm")) {
      foreach ($ext in @('.exe', '.cmd')) { if (Test-Path -LiteralPath (Join-Path $dir "$Name$ext")) { return $true } }
    }
    return $false
  }

  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'this installer is for Windows; on Linux and macOS: curl -fsSL https://ai-space.me/install.sh | bash' }
  if (-not [Environment]::Is64BitOperatingSystem) { Fail '32-bit Windows is not supported; there is an archive for x64' }
  # The x64 archive also runs on Windows on Arm, under the system's emulation.
  $plat = 'windows'; $arch = 'x64'
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar)) { Fail 'tar.exe is not part of this Windows (it is from Windows 10 version 1803 on), so the archive cannot be unpacked' }
  $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
  & $schtasks /Query /TN '\' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'the Task Scheduler does not answer (schtasks /Query): ai-space runs as a task started when you log on' }

  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  $version = if ($env:AI_SPACE_VERSION) { $env:AI_SPACE_VERSION -replace '^v', '' } else { 'latest' }
  if ($env:AI_SPACE_DOWNLOAD) { $base = $env:AI_SPACE_DOWNLOAD.TrimEnd('/', '\') }
  elseif ($version -eq 'latest') { $base = "https://github.com/$repo/releases/latest/download" }
  else { $base = "https://github.com/$repo/releases/download/v$version" }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ai-space-install." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $what = if ($version -eq 'latest') { 'latest release' } else { "release $version" }
    Write-Host "ai-space: looking for the $what for $plat-$arch"
    try { Get-ReleaseFile $base 'SHA256SUMS' (Join-Path $tmp 'SHA256SUMS') } catch { Fail "could not download $base/SHA256SUMS" }
    $wanted = if ($version -eq 'latest') { '[0-9][^ ]*' } else { [regex]::Escape($version) }
    # ai-space-<version>-windows-<arch>.tar.gz; releases up to 0.2.1 named it ai-space-server-<version>-...
    $line = Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-fA-F]{64})  (ai-space-(?:server-)?$wanted-$plat-$arch\.tar\.gz)$" } | Select-Object -First 1
    if (-not $line) { Fail "the release has no Server archive for $plat-$arch" }
    $want = $line.Substring(0, 64).ToLower()
    $name = $line.Substring(66)

    Write-Host "ai-space: downloading $name"
    $archive = Join-Path $tmp $name
    try { Get-ReleaseFile $base $name $archive } catch { Fail "could not download $base/$name" }
    # .NET's own hash, so the check depends on no module being found.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($archive)
    try { $got = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose(); $sha.Dispose() }
    if ($got -ne $want) { Fail "$name does not match the release's SHA256SUMS (expected $want, got $got); nothing was installed" }

    & $tar -xzf $archive -C $tmp
    if ($LASTEXITCODE -ne 0) { Fail "could not unpack $name" }
    $dir = Join-Path $tmp ($name -replace '\.tar\.gz$', '')
    if (-not ((Test-Path -LiteralPath (Join-Path $dir 'install.ps1')) -and (Test-Path -LiteralPath (Join-Path $dir 'RELEASE.json')))) { Fail "$name is not an ai-space Server archive for Windows" }
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'install.ps1')
    if ($LASTEXITCODE -ne 0) { Fail 'the release did not come up; what it printed above says why' }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $workspace = if ($env:SPACE_HOME) { $env:SPACE_HOME } else { Join-Path $env:USERPROFILE '.ai-space' }
  $port = $env:SPACE_PORT
  $envFile = Join-Path $workspace '.env'
  if (-not $port -and (Test-Path -LiteralPath $envFile)) {
    $portLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^SPACE_PORT=' } | Select-Object -First 1
    if ($portLine) { $port = ($portLine -replace '^SPACE_PORT=', '').Trim(" `t`"'") }
  }
  if (-not $port) { $port = '8700' }
  $url = "http://127.0.0.1:$port/"

  Write-Host ''
  Write-Host "ai-space is running. Open the panel: $url"
  if (-not ((Find-Cli 'claude') -or (Find-Cli 'codex'))) {
    Write-Host ''
    Write-Host 'No agent CLI found yet. ai-space works through one you sign in to on this machine, for example:'
    Write-Host '  Claude Code:  irm https://claude.ai/install.ps1 | iex   then run: claude'
    Write-Host '  Codex:        install the Codex CLI, then run: codex login'
    Write-Host 'The panel finds it once it is installed (Settings, Models).'
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'Git for Windows is not installed. Claude Code needs it, and ai-space runs the build commands of apps in its shell: https://git-scm.com/download/win'
  }
  if (-not $env:AI_SPACE_NO_OPEN) { try { Start-Process $url } catch { } }
  Write-Host ''
  Write-Host 'ai-space runs while you are logged on to this computer. Later: space open (the panel), space service status, space uninstall.'
}

Install-AISpace
