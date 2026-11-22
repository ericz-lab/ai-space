import { isOperator } from "../auth.ts";
import { type Connection, type Connections, connectionUrl } from "../packages/connections.ts";
import { mask } from "../setup.ts";
import { adoptHeadersEnv, adoptTokenEnv } from "./adopt.ts";
import { ENV_PREFIX, nameToEnv, parseHeaders } from "./config.ts";
import type { ConnectionPeerState } from "./connection-peers.ts";
import type { PeerHub } from "./hub.ts";
import { commentEnvText, editEnvFile, peerEnvKeys } from "./rename.ts";

/**
 * `space peer migrate` on the hub (docs/peers.md#moving-a-legacy-peer): one `SPACE_PEER_<NAME>` peer moved onto a
 * package connection under the same name, so it keeps what the hub stores under that name (snapshot, cursor,
 * hidden apps, tile order, ledger rows). The steps, each one checked before it is done and skipped when done
 * already, so a re-run after a failure anywhere continues instead of starting over:
 *
 *   1. connection  the hub's connection to the peer's Space (its id from the legacy snapshot), alias = the
 *                  name; created incoming when there is none, its token made anew when the peer is not
 *                  connected yet (a lost token cannot be read back). Two hubs listing each other: the
 *                  connection the other one's migration made is reused, whichever side dialed.
 *   2. peer        automatic: `POST /api/peer/connections/adopt` over the legacy channel (adopt.ts), which
 *                  makes the peer dial back with full trust; a peer without that route (404) is told to use
 *                  `--manual`. Manual: the commands to run on the peer are returned and the run stops;
 *                  `--finish` continues from step 3.
 *   3. verify      within `waitMs`: the channel up, the peer granting the panel scope, and a snapshot answered
 *                  over the channel. Otherwise the legacy peer stays and the answer says why.
 *   4. legacy      unless `keepLegacy`: the `SPACE_PEER_<NAME>*` lines commented out in `.env` (printed with
 *                  the token masked) and dropped from the running environment, the legacy client stopped, and
 *                  the connection peer attached under the name in the running hub. No restart.
 *
 * `dryRun` reports each step as it would go and changes nothing.
 */

export type MigrateMode = "auto" | "manual" | "finish";

export type MigrateRequest = {
  mode?: MigrateMode;
  dryRun?: boolean;
  keepLegacy?: boolean;
  /** The hub's origin as the peer dials it; else the configured one (`SPACE_PANEL_HOST`). */
  hubUrl?: string;
  /** The peer's Space id, when its snapshot sends none (an older peer, or one that is down). */
  peerId?: string;
  /** An access layer's headers in front of the hub, `Name: value; Name: value`, for the peer to send. */
  hubHeaders?: string;
  /** How long to wait for the connection and its snapshot (default 30 s, at most 5 min). */
  waitMs?: number;
};

export type StepStatus = "done" | "skipped" | "would" | "failed";
export type MigrateStep = { step: "connection" | "peer" | "verify" | "legacy"; status: StepStatus; detail: string };

export type MigrateState = "dry-run" | "manual" | "kept" | "migrated" | "already" | "needs-manual" | "unverified" | "refused";

export type MigrateResult = {
  ok: boolean;
  peer: string;
  state: MigrateState;
  steps: MigrateStep[];
  error?: string;
  /** The hub's connection to the peer. */
  connection?: string;
  peerSpaceId?: string;
  hubUrl?: string;
  /** Manual mode: the commands to run on the peer, then `--finish` here. */
  manual?: string[];
  /** The `.env` lines commented out, values of secrets masked: what to restore to go back. */
  removed?: { key: string; value: string }[];
  /** What differs after the move and needs the owner (access layers, refresh, the peer's hub token). */
  warnings: string[];
  /** How to go back. */
  rollback?: string[];
};

export type MigrateDeps = {
  hub: PeerHub;
  connections: Connections;
  links: {
    status(): { id: string; connected: boolean; error?: string }[];
    request(id: string, meta: unknown, body?: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Response>;
    refresh(): void;
  };
  connectionPeers: { sync(): void; status(): ConnectionPeerState[] };
  catalogue: { refresh(): Promise<void> };
  envFile: string;
  /** The running service's environment: the peer's keys are dropped from it too. */
  env: Record<string, string | undefined>;
  /** The hub's public origin from its configuration (`https://<SPACE_PANEL_HOST>`), when there is one. */
  hubUrl?: string;
  /** The router's domain (`SPACE_DOMAIN`), only to suggest `--hub-url` when no panel host is set. */
  domain?: string;
  /** Polling step of the verification; tests shorten it. */
  pollMs?: number;
};

export class MigrateError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 300_000;
const ADOPT_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function migratePeer(d: MigrateDeps, name: string, req: MigrateRequest = {}): Promise<MigrateResult> {
  const mode: MigrateMode = req.mode ?? "auto";
  const dry = Boolean(req.dryRun);
  const steps: MigrateStep[] = [];
  const warnings: string[] = [];
  const step = (s: MigrateStep["step"], status: StepStatus, detail: string) => steps.push({ step: s, status, detail });
  const result = (state: MigrateState, extra: Partial<MigrateResult> = {}): MigrateResult => ({ ok: !["needs-manual", "unverified", "refused"].includes(state) && !steps.some((s) => s.status === "failed"), peer: name, state, steps, warnings, ...extra });

  const client = d.hub.get(name);
  if (!client || client.config.connection) {
    const moved = d.connectionPeers.status().find((s) => s.name === name && s.state === "peer");
    if (moved) {
      step("legacy", "skipped", `${name} is a connection peer already (connection ${moved.connection}); there is no SPACE_PEER_${nameToEnv(name)} left`);
      return result("already", { connection: moved.connection });
    }
    throw new MigrateError(404, `unknown peer: ${name}`);
  }

  const peerSpaceId = (req.peerId ?? client.snapshot?.id ?? "").trim();
  if (!peerSpaceId) throw new MigrateError(409, `peer ${name} has sent no Space id${client.error ? ` (it does not answer: ${client.error})` : " (an older ai-space)"}; pass --peer-id with the id \`space connection ls\` prints on it`);
  if (!UUID_RE.test(peerSpaceId)) throw new MigrateError(400, `the peer's Space id ${JSON.stringify(peerSpaceId)} is not a Space id`);
  if (peerSpaceId === d.connections.spaceId) throw new MigrateError(400, "the peer's Space id is this Space's own");
  if (req.peerId && client.snapshot?.id && client.snapshot.id !== req.peerId) throw new MigrateError(400, `--peer-id ${req.peerId} is not the id peer ${name} sends (${client.snapshot.id})`);

  let hubUrl: string | undefined;
  const rawUrl = req.hubUrl?.trim() || d.hubUrl;
  if (rawUrl) {
    try {
      hubUrl = connectionUrl(rawUrl);
    } catch (e) {
      throw new MigrateError(400, `hub URL ${rawUrl}: ${(e as Error).message}`);
    }
  }
  if (req.hubHeaders) {
    try {
      parseHeaders(req.hubHeaders);
    } catch (e) {
      throw new MigrateError(400, `--hub-headers: ${(e as Error).message}`);
    }
  }
  const waitMs = Math.min(MAX_WAIT_MS, Math.max(1_000, req.waitMs ?? DEFAULT_WAIT_MS));
  // Asked before anything changes: the peer must be told where to dial, and a loopback address is never guessed.
  if (!dry && mode !== "finish" && !hubUrl) throw noHubUrl(d);
  noteDifferences(d, name, client.config.headers, hubUrl, req, warnings);

  // ---- 1. the hub's connection to the peer's Space, under the legacy name.
  let conn: Connection | undefined = d.connections.byRemote(peerSpaceId);
  let token: string | undefined;
  const connected = () => Boolean(conn && d.links.status().find((s) => s.id === conn!.id)?.connected);
  if (conn && !conn.enabled) {
    step("connection", "failed", `connection ${conn.id} to the peer's Space is disabled here`);
    return result("refused", { error: `connection ${conn.id} is disabled on this hub: \`space connection enable ${conn.id}\`, then run this again`, connection: conn.id, peerSpaceId });
  }
  if (!conn) {
    if (mode === "finish") {
      step("connection", "failed", "no connection to the peer's Space here");
      return result("refused", { error: `there is no connection to ${peerSpaceId} on this hub yet: run \`space peer migrate ${name} --manual\` first`, peerSpaceId });
    }
    if (dry) step("connection", "would", `create an incoming connection for ${peerSpaceId} under the alias ${name}`);
    else {
      const made = d.connections.create({ remoteSpaceId: peerSpaceId, direction: "incoming", alias: name });
      conn = made.connection;
      token = made.token;
      step("connection", "done", `created incoming connection ${conn.id} under the alias ${name}`);
    }
  } else {
    const parts: string[] = [];
    let changes = false;
    if (conn.alias !== name) {
      const before = conn.alias ?? conn.remoteName ?? conn.remoteSpaceId.slice(0, 8);
      changes = true;
      if (dry) parts.push(`would set its alias to ${name} (it is ${before} now)`);
      else {
        conn = d.connections.update(conn.id, { alias: name });
        parts.push(`alias set to ${name} (was ${before})`);
      }
    }
    if (conn.direction === "outgoing") parts.push("this hub dials the peer on it already (the peer lists this Space too); one connection serves both directions");
    else if (connected()) parts.push("the peer is connected on it");
    else if (mode !== "finish") {
      changes = true;
      if (dry) parts.push("would make its token anew (the peer is not connected; a token is shown only once)");
      else {
        token = d.connections.rotate(conn.id);
        parts.push("its token made anew (the peer is not connected on it)");
      }
    }
    step("connection", !changes ? "skipped" : dry ? "would" : "done", `connection ${conn.id} (${conn.direction})${parts.length ? `: ${parts.join("; ")}` : ""}`);
  }

  // ---- 2. the peer: the connection back to this hub, granting it full trust.
  const tokenEnv = adoptTokenEnv(d.connections.spaceId);
  if (mode === "finish") step("peer", "skipped", "--finish: the peer was set up by hand");
  else if (dry) {
    if (!hubUrl) {
      step("peer", "failed", "no hub URL the peer can dial");
      warnings.unshift(noHubUrl(d).message);
    } else step("peer", "would", mode === "manual" ? "print the commands to run on the peer" : `ask the peer to dial ${hubUrl} (POST /api/peer/connections/adopt over the legacy channel) with full trust for this hub`);
  } else if (mode === "manual") {
    const manual = manualCommands(d, name, conn!, token, hubUrl!, tokenEnv, req.hubHeaders);
    step("peer", "done", "the commands to run on the peer are below; then run this with --finish");
    return result("manual", { connection: conn!.id, peerSpaceId, hubUrl, manual });
  } else {
    let res: Response;
    try {
      res = await client.request("/api/peer/connections/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceId: d.connections.spaceId, url: hubUrl, ...(token ? { token } : {}), ...(req.hubHeaders ? { headers: req.hubHeaders } : {}) }),
        signal: AbortSignal.timeout(ADOPT_TIMEOUT_MS),
      });
    } catch (e) {
      step("peer", "failed", `the peer did not answer: ${(e as Error).message}`);
      return result("refused", { error: `peer ${name} unreachable over the legacy channel: ${(e as Error).message}; run this again when it answers, or use --manual`, connection: conn!.id, peerSpaceId, hubUrl });
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; created?: boolean; raised?: boolean; connection?: { id?: string } };
    if (res.status === 404) {
      step("peer", "failed", "the peer has no /api/peer/connections/adopt (an older ai-space)");
      return result("needs-manual", { error: `peer ${name} runs an ai-space without the adopt route: upgrade it, or run \`space peer migrate ${name} --manual\` and follow what it prints`, connection: conn!.id, peerSpaceId, hubUrl });
    }
    if (!res.ok) {
      step("peer", "failed", `the peer refused: ${body.error ?? `HTTP ${res.status}`}`);
      return result("refused", { error: `peer ${name} refused the connection: ${res.status === 401 ? "token rejected" : body.error ?? `HTTP ${res.status}`}`, connection: conn!.id, peerSpaceId, hubUrl });
    }
    step("peer", body.created || body.raised || token ? "done" : "skipped", `the peer's connection ${body.connection?.id ?? "?"} to this hub ${body.created ? "created" : "kept"}${body.raised ? ", raised to full trust" : ""}`);
  }

  // ---- 3. verify: the channel up, the panel granted, a snapshot over it.
  if (dry) {
    step("verify", "would", `wait up to ${Math.round(waitMs / 1000)} s for the connection and a snapshot over it`);
  } else {
    const failed = await verify(d, conn!, peerSpaceId, waitMs);
    if (failed) {
      step("verify", "failed", failed);
      return result("unverified", { error: `${failed}; the legacy peer ${name} stays in place. Run this again to continue`, connection: conn!.id, peerSpaceId, hubUrl, rollback: rollbackText(name, conn!.id, tokenEnv, false) });
    }
    step("verify", "done", "the connection is up and the peer answers a snapshot over it");
  }

  // ---- 4. the legacy peer off; the connection takes the name.
  const keys = peerEnvKeys(name);
  const note = `moved to a package connection by \`space peer migrate ${name}\`; remove the "# " of these lines (and restart) to go back`;
  let fileText = "";
  try {
    fileText = await Bun.file(d.envFile).text();
  } catch {
    /* none */
  }
  const commented = commentEnvText(fileText, keys, note);
  if (!commented.found.length) {
    step("legacy", "failed", `${ENV_PREFIX}${nameToEnv(name)} is not in ${d.envFile}`);
    return result("refused", { error: `${ENV_PREFIX}${nameToEnv(name)} is set in the service's environment, not in ${d.envFile}: remove it where it is set and restart; the connection then takes the name`, connection: conn?.id, peerSpaceId, hubUrl });
  }
  const removed = commented.found.map((f) => ({ key: f.key, value: f.key.endsWith("_TOKEN") || f.key.endsWith("_HEADERS") ? mask(unquote(f.value)) : f.value }));
  if (dry) {
    step("legacy", "would", `comment out ${commented.found.map((f) => f.key).join(", ")} in ${d.envFile} and hand the name to the connection`);
    return result("dry-run", { ...(conn ? { connection: conn.id } : {}), peerSpaceId, ...(hubUrl ? { hubUrl } : {}), removed });
  }
  if (req.keepLegacy) {
    step("legacy", "skipped", "--keep-legacy: the legacy peer stays, and wins over the connection, until this runs again without it");
    return result("kept", { connection: conn!.id, peerSpaceId, hubUrl, rollback: rollbackText(name, conn!.id, tokenEnv, false) });
  }
  editEnvFile(d.envFile, (text) => commentEnvText(text, keys, note).text);
  for (const k of keys) delete d.env[k];
  await d.hub.remove(name);
  d.connectionPeers.sync();
  const next = d.hub.get(name);
  if (next?.config.connection !== conn!.id) {
    step("legacy", "failed", `the connection did not take the name ${name}`);
    const why = d.connectionPeers.status().find((s) => s.connection === conn!.id);
    return result("refused", { error: `the legacy lines are commented out, but connection ${conn!.id} is not the peer ${name} here: ${why?.reason ?? why?.state ?? "unknown"}`, connection: conn!.id, peerSpaceId, hubUrl, removed, rollback: rollbackText(name, conn!.id, tokenEnv, true) });
  }
  await next.refresh();
  step("legacy", "done", `commented out ${commented.found.map((f) => f.key).join(", ")} in ${d.envFile}; ${name} is now reached over connection ${conn!.id}`);
  warnings.push(`On the peer, SPACE_HUB_TOKEN is no longer used by this hub; remove it there once no other hub lists it as SPACE_PEER_* (it keeps /api/peer/* open over HTTPS).`);
  return result("migrated", { connection: conn!.id, peerSpaceId, hubUrl, removed, rollback: rollbackText(name, conn!.id, tokenEnv, true) });
}

/** Wait for the channel, then read the grant and a snapshot over it; the reason it failed, or undefined. */
async function verify(d: MigrateDeps, conn: Connection, peerSpaceId: string, waitMs: number): Promise<string | undefined> {
  const until = Date.now() + waitMs;
  const poll = d.pollMs ?? 250;
  const up = () => d.links.status().find((s) => s.id === conn.id);
  while (!up()?.connected && Date.now() < until) {
    d.links.refresh();
    await Bun.sleep(poll);
  }
  if (!up()?.connected) {
    const error = up()?.error;
    return `the peer did not connect within ${Math.round(waitMs / 1000)} s${error ? ` (${error})` : ""}; check that it can reach this hub's /api/connections/channel (an access layer in front of the hub must let it through)`;
  }
  let granted = false;
  for (;;) {
    await d.catalogue.refresh().catch(() => {});
    d.connectionPeers.sync();
    const s = d.connectionPeers.status().find((x) => x.connection === conn.id);
    granted = Boolean(s && (s.granted.fullTrust || s.granted.scopes.includes("panel")));
    if (granted || Date.now() >= until) break;
    await Bun.sleep(poll);
  }
  if (!granted) return "the peer is connected but grants this hub no panel scope (`space connection scopes <id> --full-trust on` on the peer)";
  let res: Response;
  try {
    res = await d.links.request(conn.id, { operation: "peer", method: "GET", path: "/api/peer/snapshot", headers: [["accept", "application/json"]] }, null, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS));
  } catch (e) {
    return `no snapshot over the connection: ${(e as Error).message}`;
  }
  const snap = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string };
  if (!res.ok || snap.ok !== true) return `no snapshot over the connection: ${snap.error ?? `HTTP ${res.status}`}`;
  if (snap.id && snap.id !== peerSpaceId) return `the snapshot over the connection is of Space ${snap.id}, not ${peerSpaceId}`;
  return undefined;
}

/** What changes for the owner, said before anything is done. */
function noteDifferences(d: MigrateDeps, name: string, headers: Record<string, string>, hubUrl: string | undefined, req: MigrateRequest, warnings: string[]): void {
  const key = `${ENV_PREFIX}${nameToEnv(name)}`;
  const channel = `${hubUrl ?? "<hub>"}/api/connections/channel`;
  if (Object.keys(headers).length) {
    warnings.push(`${key}_HEADERS (${Object.keys(headers).join(", ")}) is for an access layer in front of the peer; the hub no longer calls the peer, so it is not needed after the move. The peer now dials ${channel}: an access layer in front of the hub must let that path through (it checks its own bearer token), or the peer must send the layer's service token: pass it with --hub-headers "CF-Access-Client-Id: …; CF-Access-Client-Secret: …".`);
  } else if (!req.hubHeaders) {
    warnings.push(`The peer now dials ${channel}. If an access layer (Cloudflare Access) is in front of the hub's hostname, it must let that path through, or pass its service token with --hub-headers.`);
  }
  if (d.env[`${key}_REFRESH`]?.trim()) warnings.push(`${key}_REFRESH=${d.env[`${key}_REFRESH`]!.trim()} is not carried over: a connection peer refreshes every 30 s.`);
  for (const k of ["SPACE_CHAT_MODEL", "SPACE_MODEL_DEFAULT"]) {
    if (d.env[k]?.trim().replace(/^["']/, "").startsWith(`${name}:`)) warnings.push(`${k}=${d.env[k]!.trim()} names ${name} as its machine; it keeps working, since the connection keeps the name.`);
  }
}

/** The commands for `--manual`: what the automatic mode has the peer do, typed there by the owner. */
function manualCommands(d: MigrateDeps, name: string, conn: Connection, token: string | undefined, hubUrl: string, tokenEnv: string, hubHeaders?: string): string[] {
  const hubId = d.connections.spaceId;
  const lines = [`# On the peer (${name}), as the owner of its ai-space:`];
  if (conn.direction === "outgoing" || !token) {
    lines.push(
      `# It has a connection to this hub already (${conn.direction === "outgoing" ? "this hub dials it" : "it is connected"}); grant this hub full trust on it:`,
      `space connection ls                       # the connection whose remote is ${hubId}`,
      `space connection scopes <that id> --full-trust on --yes`,
    );
  } else {
    lines.push(
      `# 1. The token for this hub, in its workspace .env (shown once; running this again makes a new one):`,
      `${tokenEnv}=${token}`,
      ...(hubHeaders ? [`${adoptHeadersEnv(hubId)}="${hubHeaders.replace(/(["\\])/g, "\\$1")}"`] : []),
      `# 2. Restart it, so the running service reads the token:`,
      `space service restart`,
      `# 3. The connection to this hub, granting it full trust (what SPACE_HUB_TOKEN gave it):`,
      `space connection create outgoing ${hubId} --endpoint ${hubUrl} --token-env ${tokenEnv}${hubHeaders ? ` --headers-env ${adoptHeadersEnv(hubId)}` : ""} --full-trust --yes`,
      `#    (or --scopes panel,agents,events,model,tasks,terminal,apps,manage to grant scopes one by one)`,
    );
  }
  lines.push(`# Then on this hub:`, `space peer migrate ${name} --finish`);
  return lines;
}

function rollbackText(name: string, connection: string, tokenEnv: string, legacyRemoved: boolean): string[] {
  const key = `${ENV_PREFIX}${nameToEnv(name)}`;
  return [
    ...(legacyRemoved ? [`On this hub: remove the "# " in front of the ${key}* lines in .env, then \`space service restart\` (a legacy peer is read at start; while both exist it wins over the connection).`] : []),
    `On this hub: \`space connection rm ${connection}\` drops the connection (the stored snapshot and the rest stay under ${name}).`,
    `On the peer: \`space connection rm <its connection to this hub>\` and delete ${tokenEnv} from its .env.`,
  ];
}

function noHubUrl(d: MigrateDeps): MigrateError {
  const hint = d.domain ? ` (with the router's domain ${d.domain}, that is usually https://space.${d.domain})` : "";
  return new MigrateError(400, `this hub has no public address the peer can dial: SPACE_PANEL_HOST is not set. Pass --hub-url https://<the hub's panel hostname>${hint}`);
}

function unquote(v: string): string {
  return v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;
}

type Req = Request & { params: Record<string, string> };

/** `POST /api/peers/:peer/migrate` (owner, with the operator token): one peer; the CLI's `--all` calls it per peer. */
export function createMigrateRoutes(o: { deps: MigrateDeps; token: string }): Record<string, Record<string, (req: Req) => Promise<Response>>> {
  return {
    "/api/peers/:peer/migrate": {
      POST: async (req) => {
        if (!isOperator(req, o.token)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const bad = Object.keys(body).find((k) => !["mode", "dryRun", "keepLegacy", "hubUrl", "peerId", "hubHeaders", "waitMs"].includes(k));
        if (bad) return Response.json({ ok: false, error: `unknown field ${bad}` }, { status: 400 });
        if (body.mode !== undefined && !["auto", "manual", "finish"].includes(body.mode as string)) return Response.json({ ok: false, error: "mode must be auto, manual or finish" }, { status: 400 });
        for (const k of ["hubUrl", "peerId", "hubHeaders"]) if (body[k] !== undefined && typeof body[k] !== "string") return Response.json({ ok: false, error: `${k} must be a string` }, { status: 400 });
        if (body.waitMs !== undefined && (typeof body.waitMs !== "number" || !Number.isFinite(body.waitMs))) return Response.json({ ok: false, error: "waitMs must be a number" }, { status: 400 });
        try {
          const r = await migratePeer(o.deps, req.params.peer ?? "", body as MigrateRequest);
          return Response.json(r, { status: r.ok ? 200 : 409, headers: { "cache-control": "no-store" } });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: e instanceof MigrateError ? e.status : 500 });
        }
      },
    },
  };
}
