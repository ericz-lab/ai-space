import { type Connection, type Connections, connectionUrl } from "../packages/connections.ts";
import { updateEnvText } from "../setup.ts";
import { parseHeaders } from "./config.ts";
import { editEnvFile } from "./rename.ts";

/**
 * The peer side of `space peer migrate` (docs/peers.md#moving-a-legacy-peer): `POST /api/peer/connections/adopt`,
 * by which a hub that reaches this Space over the legacy channel asks it to open a package connection back
 * to the hub. It is served over HTTPS behind `SPACE_HUB_TOKEN` only, never over a connection (scopes.ts
 * `LEGACY_ONLY_ROUTES`): a hub that already has a connection has no use for it.
 *
 *   body   { spaceId, url, token?, headers? }   the calling hub's Space id, the origin this Space dials, the
 *                                               token of the incoming connection the hub made for this one,
 *                                               an access layer's headers in front of the hub
 *   answer { ok, connection: { id, direction, url, tokenEnv, headersEnv, fullTrust, connected }, created, raised, tokenWritten }
 *
 * What it may do, and nothing more:
 *
 * - Only the connection to `spaceId`, the Space the hub says it is. The channel's handshake checks that
 *   claim: the Space at `url` must answer the hello with that id and accept `token`, or no channel opens.
 *   Every other connection is left alone; nothing is disabled, enabled, removed or renamed.
 * - None to that Space yet: create an outgoing one to `url` (HTTPS, or HTTP on loopback, the connection
 *   rule) with the token in `SPACE_CONNECTION_<ID>_TOKEN` (`adoptTokenEnv`) and full trust, which is what
 *   the hub token is worth. A connection's own limits stay on top of that: no terminal unless it is enabled
 *   here, no model answers beyond `SPACE_PEER_MODEL`, no installed package through the peer routes.
 * - One already, made by this route (a re-run): a new token is written to its variable, and it has full trust
 *   again if the owner lowered it; given another address (the first run had the wrong hub URL), it is removed
 *   and made again there. One this route did not make is changed only when this
 *   Space lists the caller as a peer of its own (`isPeer`: two hubs that list each other, where the second
 *   migration finds the connection the first one made and only raises what this side grants); else it is
 *   refused, and the owner grants it by hand. A disabled one is refused: the owner turned it off here.
 *
 * The token goes into the workspace `.env` and into the running service's environment, which the links
 * read on every reconnect (links.ts `connect`), so no restart is needed. The route is idempotent: the same
 * call twice leaves the same state.
 */

export type AdoptOptions = {
  connections: Connections;
  /** Whether a connection's channel is up now, and a nudge to dial the outgoing ones at once. */
  links: { status(): { id: string; connected: boolean }[]; refresh(): void };
  /** The running service's environment, where the links look the token up. */
  env: Record<string, string | undefined>;
  /** The workspace `.env`, where the token is kept for the next start. */
  envFile: string;
  /**
   * Whether this Space lists `spaceId` as a peer of its own (a `SPACE_PEER_*` peer whose snapshot carries that
   * id, or a connection peer bound to it): the one case an existing connection it did not make is raised.
   */
  isPeer?: (spaceId: string) => boolean;
  log?: (line: string) => void;
};

export type AdoptAnswer = {
  ok: true;
  connection: Pick<Connection, "id" | "direction" | "url" | "tokenEnv" | "headersEnv" | "fullTrust"> & { connected: boolean };
  created: boolean;
  raised: boolean;
  tokenWritten: boolean;
  /** The connection this route had made to another address, removed for the new one. */
  replaced?: string;
};

/** The variable this Space keeps the token of the hub `spaceId` in: deterministic, so a re-run finds it. */
export function adoptTokenEnv(spaceId: string): string {
  return `SPACE_CONNECTION_${spaceId.replace(/[^0-9a-f]/gi, "").slice(0, 12).toUpperCase()}_TOKEN`;
}

/** The variable of the access layer's headers in front of the hub `spaceId`, next to its token. */
export function adoptHeadersEnv(spaceId: string): string {
  return adoptTokenEnv(spaceId).replace(/_TOKEN$/, "_HEADERS");
}

export class AdoptError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function adoptConnection(o: AdoptOptions, raw: unknown): AdoptAnswer {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const k of Object.keys(body)) if (!["spaceId", "url", "token", "headers"].includes(k)) throw new AdoptError(400, `unknown field ${k}`);
  const spaceId = typeof body.spaceId === "string" ? body.spaceId.trim() : "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(spaceId)) throw new AdoptError(400, "spaceId must be the calling hub's Space id");
  if (spaceId === o.connections.spaceId) throw new AdoptError(400, "cannot connect a Space to itself");
  if (typeof body.url !== "string") throw new AdoptError(400, "url must be the origin of the calling hub");
  let url: string;
  try {
    url = connectionUrl(body.url);
  } catch (e) {
    throw new AdoptError(400, (e as Error).message);
  }
  const token = body.token === undefined || body.token === null ? undefined : body.token;
  if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(token))) throw new AdoptError(400, "token must be a connection token");
  const headers = body.headers === undefined || body.headers === null || body.headers === "" ? undefined : body.headers;
  if (headers !== undefined) {
    if (typeof headers !== "string" || headers.length > 4096 || /[\r\n]/.test(headers)) throw new AdoptError(400, "headers must be one line: Name: value; Name: value");
    try {
      parseHeaders(headers);
    } catch (e) {
      throw new AdoptError(400, (e as Error).message);
    }
  }

  const tokenEnv = adoptTokenEnv(spaceId);
  const headersEnv = adoptHeadersEnv(spaceId);
  const existing = o.connections.byRemote(spaceId);
  let created = false, raised = false, tokenWritten = false;
  let c: Connection;
  if (!existing) {
    if (!token) throw new AdoptError(400, "token is required: there is no connection to that Space here yet");
    // The credential first, so the first dial already finds it.
    setEnv(o, { [tokenEnv]: token, ...(headers ? { [headersEnv]: headers } : {}) });
    tokenWritten = true;
    c = o.connections.create({ remoteSpaceId: spaceId, direction: "outgoing", url, tokenEnv, ...(headers ? { headersEnv } : {}), fullTrust: true }).connection;
    created = true;
  } else {
    if (!existing.enabled) throw new AdoptError(409, `the connection ${existing.id} to that Space is disabled here; enable it on this machine (space connection enable ${existing.id}) or migrate with --manual`);
    // A connection the owner made for another purpose is the owner's to widen: only one this route made, or one
    // to a Space this one lists as its own peer (two hubs that list each other), is raised here.
    const mine = existing.direction === "outgoing" && existing.tokenEnv === tokenEnv;
    if (!mine && !o.isPeer?.(spaceId)) throw new AdoptError(409, `a connection to that Space (${existing.id}) exists here and was not made by a migration; grant it on this machine (space connection scopes ${existing.id} --full-trust on) and run the migration with --finish`);
    // One this route made to another address (a first run given the wrong hub URL): made again at the new one.
    if (mine && existing.url !== url) {
      if (!token) throw new AdoptError(400, "token is required to point the connection at another address");
      o.connections.remove(existing.id);
      setEnv(o, { [tokenEnv]: token, ...(headers ? { [headersEnv]: headers } : {}) });
      c = o.connections.create({ remoteSpaceId: spaceId, direction: "outgoing", url, tokenEnv, ...(headers || existing.headersEnv ? { headersEnv } : {}), fullTrust: true }).connection;
      return finish(o, c, url, spaceId, { created: true, raised: false, tokenWritten: true, replaced: existing.id });
    }
    // Only the variables this route names: a connection the owner made by hand keeps its own credential.
    const updates: Record<string, string> = {};
    if (existing.direction === "outgoing" && existing.tokenEnv === tokenEnv && token && o.env[tokenEnv] !== token) updates[tokenEnv] = token;
    if (existing.direction === "outgoing" && existing.headersEnv === headersEnv && headers && o.env[headersEnv] !== headers) updates[headersEnv] = headers;
    if (Object.keys(updates).length) {
      setEnv(o, updates);
      tokenWritten = tokenEnv in updates;
    }
    c = existing.fullTrust ? existing : o.connections.update(existing.id, { fullTrust: true });
    raised = !existing.fullTrust;
  }
  return finish(o, c, url, spaceId, { created, raised, tokenWritten });
}

function finish(o: AdoptOptions, c: Connection, url: string, spaceId: string, what: { created: boolean; raised: boolean; tokenWritten: boolean; replaced?: string }): AdoptAnswer {
  o.links.refresh();
  const connected = Boolean(o.links.status().find((s) => s.id === c.id)?.connected);
  o.log?.(`[peers] adopt: hub ${spaceId} at ${url}: connection ${c.id} ${what.replaced ? `made again (was ${what.replaced} at another address)` : what.created ? "created" : "kept"}${what.raised ? ", raised to full trust" : ""}${what.tokenWritten ? `, token in ${c.tokenEnv}` : ""}`);
  return { ok: true, connection: { id: c.id, direction: c.direction, url: c.url, tokenEnv: c.tokenEnv, headersEnv: c.headersEnv, fullTrust: c.fullTrust, connected }, ...what };
}

/** Into the workspace `.env` (setup.ts's line rules) and the running environment, together. */
function setEnv(o: AdoptOptions, updates: Record<string, string>): void {
  editEnvFile(o.envFile, (text) => updateEnvText(text, updates), { create: true });
  Object.assign(o.env, updates);
}

/** The route, for serve.ts `createPeerServeRoutes`, behind the hub token. */
export function createAdoptHandler(o: AdoptOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "the body must be JSON" }, { status: 400 });
    }
    try {
      return Response.json(adoptConnection(o, body), { headers: { "cache-control": "no-store" } });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: e instanceof AdoptError ? e.status : 500, headers: { "cache-control": "no-store" } });
    }
  };
}
