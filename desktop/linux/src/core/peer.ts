/**
 * Making this computer a peer of a remote Space (docs/peers.md): the hub calls the peer, so this
 * computer's Space needs `SPACE_HUB_TOKEN` (and `SPACE_NAME`) in its workspace `.env`, an address
 * the hub can reach, and the hub needs `SPACE_PEER_<NAME>` and `_TOKEN` in its own `.env`. For a
 * computer behind no tunnel the app keeps an SSH reverse tunnel to the hub's machine as a systemd
 * user service. Everything here is text in, text out; the Settings page writes the files.
 */

/** The peer-name rule of the hub (src/space/peers/config.ts `PEER_NAME_RE`). */
export const PEER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The hub's key for a peer name: `laptop-2` → `SPACE_PEER_LAPTOP_2` (the hub lowercases it and turns `_` back into `-`). */
export const peerEnvKey = (name: string) => `SPACE_PEER_${name.toUpperCase().replace(/[-.]/g, "_")}`;

/**
 * A peer name the hub reads back as the same name: lowercase, and only `-` besides letters and
 * digits (a `.` would come back as `-`, since environment keys hold no dots).
 */
export function suggestPeerName(hostname: string): string {
  const name = hostname.toLowerCase().split(".")[0]!.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return PEER_NAME_RE.test(name) ? name : "computer";
}

export const validPeerName = (name: string) => PEER_NAME_RE.test(name) && !name.includes(".") && !name.includes("_");

/** The workspace `.env` as a map, read as the service reads it (src/space/workspace.ts `readWorkspaceEnv`). */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** Quote a value the way the service reads it back (src/space/setup.ts `quoteEnvValue`). */
export function quoteEnvValue(value: string): string {
  return /[\s#"']/.test(value) || value === "" ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

const HEADER = "# Added by the AI Space app (Settings › Peer)";

/**
 * Apply `updates` to a `.env` text as `space setup` does (src/space/setup.ts `updateEnvText`): a
 * `KEY=` line is replaced in place, a commented `# KEY=` line is uncommented and replaced,
 * anything else is appended under one header. Every other line stays as it is.
 */
export function updateEnvText(text: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  const out: string[] = [];
  for (const raw of lines) {
    const key = /^(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(raw)?.[1];
    if (key && pending.has(key)) {
      out.push(`${key}=${quoteEnvValue(pending.get(key)!)}`);
      pending.delete(key);
    } else out.push(raw);
  }
  if (pending.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(HEADER);
    for (const [k, v] of pending) out.push(`${k}=${quoteEnvValue(v)}`);
  }
  return `${out.join("\n")}\n`;
}

/** What this computer's `.env` says about being a peer. */
export type PeerSide = { enabled: boolean; token: string; name: string; terminal: boolean; port: number };

export function readPeerSide(env: Record<string, string>): PeerSide {
  const port = Number(env.SPACE_PORT ?? 8700);
  return {
    enabled: Boolean(env.SPACE_HUB_TOKEN?.trim()),
    token: env.SPACE_HUB_TOKEN?.trim() ?? "",
    name: env.SPACE_NAME?.trim() ?? "",
    terminal: /^(1|true|yes|on)$/i.test(env.SPACE_TERMINAL_ENABLED?.trim() ?? ""),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8700,
  };
}

/** The `.env` changes for a choice; an empty token turns the hub routes off. */
export function peerSideUpdates(p: { enabled: boolean; token: string; name: string; terminal: boolean }): Record<string, string> {
  return { SPACE_HUB_TOKEN: p.enabled ? p.token : "", SPACE_NAME: p.name, SPACE_TERMINAL_ENABLED: p.terminal ? "1" : "0" };
}

/** A token as the docs ask for one: 32 random bytes, as hex. */
export const tokenHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The lines for the hub's `.env`. */
export function hubLines(name: string, address: string, token: string, headers?: string): string {
  const key = peerEnvKey(name);
  return [`${key}=${quoteEnvValue(address)}`, `${key}_TOKEN=${quoteEnvValue(token)}`, ...(headers?.trim() ? [`${key}_HEADERS=${quoteEnvValue(headers.trim())}`] : [])].join("\n");
}

// The SSH reverse tunnel.

export const TUNNEL_UNIT = "ai-space-peer-tunnel.service";
export const DEFAULT_HUB_PORT = 8711;

/** `user@host` or `host`, optionally `ssh://user@host:port`; nothing ssh could read as an option. */
export function parseSshTarget(raw: string): { dest: string; port?: number } | undefined {
  const t = raw.trim().replace(/^ssh:\/\//, "");
  const m = /^((?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]))(?::(\d{1,5}))?$/.exec(t);
  if (!m || m[1]!.startsWith("-")) return undefined;
  const port = m[2] ? Number(m[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return { dest: m[1]!, ...(port ? { port } : {}) };
}

export const validHubPort = (n: number) => Number.isInteger(n) && n >= 1024 && n <= 65535;

/** The address the hub then uses for this computer: its own loopback end of the tunnel. */
export const tunnelAddress = (hubPort: number) => `http://127.0.0.1:${hubPort}`;

/**
 * A systemd user service that keeps `ssh -R` open: the hub machine's `127.0.0.1:<hubPort>` leads
 * to this computer's Space. Key login only (BatchMode), reconnects after a drop, and fails rather
 * than half-works when the port on the hub is taken (ExitOnForwardFailure).
 */
export function renderTunnelUnit(o: { ssh: string; target: string; hubPort: number; localPort: number }): string {
  const t = parseSshTarget(o.target);
  if (!t) throw new Error(`not an SSH address: ${o.target}`);
  if (!validHubPort(o.hubPort)) throw new Error(`not a port for the hub: ${o.hubPort}`);
  const args = [
    o.ssh,
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    ...(t.port ? ["-p", String(t.port)] : []),
    "-R", `127.0.0.1:${o.hubPort}:127.0.0.1:${o.localPort}`,
    t.dest,
  ];
  return [
    "# Written by the AI Space app (Settings › Peer): this computer's Space, reachable from the hub's machine.",
    "[Unit]",
    "Description=AI Space peer tunnel to " + t.dest,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${args.map((a) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`)).join(" ")}`,
    "Restart=always",
    "RestartSec=15",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Reads back what the app wrote, so the page shows the tunnel it runs. */
export function readTunnelUnit(text: string): { target: string; hubPort: number; localPort: number } | undefined {
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1];
  if (!exec) return undefined;
  const r = /-R\s+127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)/.exec(exec);
  const words = exec.split(/\s+/);
  const p = /-p\s+(\d+)/.exec(exec)?.[1];
  if (!r) return undefined;
  const dest = words[words.length - 1]!;
  return { target: p ? `${dest}:${p}` : dest, hubPort: Number(r[1]), localPort: Number(r[2]) };
}
