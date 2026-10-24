import type { InstallResult, LocalStatus, ModelOption } from "../../../../src/space/local.ts";

/**
 * The Local edition's service as `space local <verb> --json` reports it (src/space/local.ts,
 * docs/local.md); the shapes are the server's own types. The Linux app carries the release tree
 * in `<app>/space` and runs these commands with the Bun inside it; it never starts the service
 * process itself, systemd does.
 */
export type { InstallResult, LocalStatus, ModelOption };

export type Release = { product?: string; edition: string; version: string; commit: string };

/** A refusal from `space local`: `{ ok: false, code, error, status?, activity? }`. */
export class LocalFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: LocalStatus,
    readonly activity?: { busy: boolean; items: { kind: string; label: string }[] },
  ) {
    super(message);
  }
}

/** A command's JSON: the value on `ok: true`, a `LocalFailure` thrown on `ok: false` or on anything else. */
export function decodeLocal<T>(text: string): T {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const t = text.trim();
    throw new LocalFailure("output", t ? t.slice(-400) : "space local printed nothing");
  }
  if (body.ok === true) return body as T;
  throw new LocalFailure(typeof body.code === "string" ? body.code : "error", typeof body.error === "string" ? body.error : "space local failed", body.status as LocalStatus | undefined, body.activity as LocalFailure["activity"]);
}

/** Whether `a` is a newer version than `b` (x.y.z with an optional pre-release, which sorts before its release). */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, "").split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre > y.pre;
}

/** A keyring entry can outlive a deleted workspace: a fresh setup or takeover always makes a new credential. */
export function needsDeviceCredential(s: LocalStatus, hasStoredToken: boolean): boolean {
  return s.state !== "managed" || !s.workspace.exists || !hasStoredToken;
}

/** Only a newer version is offered automatically; Repair reinstalls explicitly. */
export function updateAvailable(s: LocalStatus): boolean {
  return s.state === "managed" && Boolean(s.bundle && s.installed && newer(s.bundle.version, s.installed.version));
}

/** Whether the service answering is the one this app installed. */
export const ownServiceRunning = (s: LocalStatus) => s.running?.installation === "managed" && s.running?.edition === "local";

/** `--claude <path> --codex <path> --dsh <path>`: the agent CLIs the person chose, for every command. */
export function runtimeArgs(chosen: Record<string, string | undefined>): string[] {
  return (["claude", "codex", "dsh"] as const).flatMap((n) => (chosen[n] ? [`--${n}`, chosen[n]!] : []));
}

/** Whether a stored cookie is the Space's session for that host (the Mac's `LocalManager.hasSession`). */
export function hasSession(cookies: { name: string; domain: string; expires?: number }[], host: string, now = Date.now()): boolean {
  return cookies.some((c) => c.name === "space_session" && (c.domain === host || c.domain === `.${host}`) && (c.expires === undefined || c.expires > now));
}
