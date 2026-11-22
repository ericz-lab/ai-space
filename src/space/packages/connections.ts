import { randomBytes, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { PEER_SCOPES, parseScopes, type PeerScope } from "../peers/scopes.ts";
import { installationKey, mapping, text } from "./contract.ts";

/**
 * One connection to another Space, and what THIS Space grants it: `apps` (local apps it may open or call),
 * `scopes` (what it may do through this Space's `/api/peer/*`, peers/scopes.ts) and `fullTrust`, which grants
 * every scope, present and future, unlike the same scopes ticked one by one. `alias` is the name this
 * Space gives the other one as a peer (its `<name>/` prefix and the key of what is kept about it); unset,
 * the name the other Space last gave itself (`remoteName`, learned from its catalogue) or the start of its id.
 */
export type Connection = {
  id: string; remoteSpaceId: string; direction: "incoming" | "outgoing"; url: string | null; tokenEnv: string | null;
  /**
   * An outgoing connection's extra request headers, by the name of a host environment variable holding
   * `Name: value; Name: value` (peers/config.ts `parseHeaders`): an access layer's service credentials in front
   * of the other Space's hostname (Cloudflare Access's `CF-Access-Client-Id` and `-Secret`). Null: none.
   */
  headersEnv: string | null;
  apps: string[]; enabled: boolean; scopes: PeerScope[]; fullTrust: boolean; alias: string | null; remoteName: string | null;
};
type Row = Omit<Connection, "apps" | "enabled" | "scopes" | "fullTrust"> & { apps: string; enabled: number; scopes: string; fullTrust: number; token_hash: string | null };
/**
 * What a change did: `grants` changed only the app list or the scopes (`revoked` names the apps taken off,
 * `revokedScopes` the scopes no longer granted, full trust included), so the channel stays up; `label`
 * changed only the name (`alias`, `remoteName`); `reset` (create, enable or disable, rotation, removal)
 * ends the channel's trust.
 */
export type ConnectionChange = { kind: "grants"; revoked: string[]; revokedScopes: PeerScope[] } | { kind: "label" } | { kind: "reset" };
type Listener = (id: string, change: ConnectionChange) => void;

/** A peer name (peers/config.ts `PEER_NAME_RE`): lowercase, as `SPACE_PEER_<NAME>` makes them. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Grants describe access to OUR applications and API. Remote configuration cannot widen them. */
export class Connections {
  private readonly listeners = new Set<Listener>();
  constructor(private readonly db: Database, readonly spaceId: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS package_connections (
      id TEXT PRIMARY KEY, remoteSpaceId TEXT NOT NULL UNIQUE, direction TEXT NOT NULL,
      url TEXT, tokenEnv TEXT, token_hash TEXT, apps TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1
    )`);
    // Added with peer scopes; a table from before gets them with nothing granted.
    const columns = new Set((db.query("PRAGMA table_info(package_connections)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, decl] of [["scopes", "TEXT NOT NULL DEFAULT '[]'"], ["fullTrust", "INTEGER NOT NULL DEFAULT 0"], ["alias", "TEXT"], ["remoteName", "TEXT"], ["headersEnv", "TEXT"]] as const) {
      if (!columns.has(name)) db.exec(`ALTER TABLE package_connections ADD COLUMN ${name} ${decl}`);
    }
  }

  list(): Connection[] { return (this.db.query("SELECT * FROM package_connections ORDER BY id").all() as Row[]).map(view); }
  get(id: string): Connection | undefined {
    const row = this.db.query("SELECT * FROM package_connections WHERE id=?").get(id) as Row | null;
    return row ? view(row) : undefined;
  }
  onChange(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  create(raw: unknown): { connection: Connection; token?: string } {
    const d = mapping(raw, "connection", ["remoteSpaceId", "direction", "url", "tokenEnv", "headersEnv", "apps", "scopes", "fullTrust", "alias"]);
    const remoteSpaceId = text(d.remoteSpaceId, "remoteSpaceId", 36);
    installationKey(remoteSpaceId, "validation");
    if (remoteSpaceId === this.spaceId) throw new Error("cannot connect a Space to itself");
    if (d.direction !== "incoming" && d.direction !== "outgoing") throw new Error("direction must be incoming or outgoing");
    const apps = appNames(d.apps ?? []);
    const scopes = parseScopes(d.scopes ?? []);
    const fullTrust = flag(d.fullTrust ?? false, "fullTrust");
    const alias = aliasOf(d.alias ?? null);
    let url: string | null = null, tokenEnv: string | null = null, headersEnv: string | null = null;
    if (d.direction === "outgoing") {
      url = connectionUrl(text(d.url, "url", 2048));
      tokenEnv = envName(d.tokenEnv, "tokenEnv");
      if (d.headersEnv !== undefined && d.headersEnv !== null) headersEnv = envName(d.headersEnv, "headersEnv");
    } else if (d.url !== undefined || d.tokenEnv !== undefined || d.headersEnv !== undefined) throw new Error("incoming connections do not take url, tokenEnv or headersEnv");
    const id = crypto.randomUUID();
    const token = d.direction === "incoming" ? randomBytes(32).toString("base64url") : undefined;
    this.db.query("INSERT INTO package_connections(id,remoteSpaceId,direction,url,tokenEnv,headersEnv,token_hash,apps,scopes,fullTrust,alias) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, remoteSpaceId, d.direction, url, tokenEnv, headersEnv, token ? digest(token) : null, JSON.stringify(apps), JSON.stringify(scopes), fullTrust ? 1 : 0, alias);
    this.changed(id);
    return { connection: this.get(id)!, ...(token ? { token } : {}) };
  }

  /**
   * Change what this Space grants (`apps`, `scopes`, `fullTrust`), the connection's `alias` (null clears it)
   * or `enabled`, all or nothing. Only enabling or disabling resets the channel; a narrower grant ends just
   * the streams that needed what was taken away.
   */
  update(id: string, raw: unknown): Connection {
    const before = this.get(id);
    if (!before) throw new Error("connection not found");
    const d = mapping(raw, "connection patch", ["apps", "enabled", "scopes", "fullTrust", "alias"]);
    const apps = d.apps === undefined ? undefined : appNames(d.apps);
    const scopes = d.scopes === undefined ? undefined : parseScopes(d.scopes);
    const fullTrust = d.fullTrust === undefined ? undefined : flag(d.fullTrust, "fullTrust");
    const alias = d.alias === undefined ? undefined : aliasOf(d.alias);
    if (d.enabled !== undefined && typeof d.enabled !== "boolean") throw new Error("enabled must be a boolean");
    this.db.transaction(() => {
      if (apps) this.db.query("UPDATE package_connections SET apps=? WHERE id=?").run(JSON.stringify(apps), id);
      if (scopes) this.db.query("UPDATE package_connections SET scopes=? WHERE id=?").run(JSON.stringify(scopes), id);
      if (fullTrust !== undefined) this.db.query("UPDATE package_connections SET fullTrust=? WHERE id=?").run(fullTrust ? 1 : 0, id);
      if (alias !== undefined) this.db.query("UPDATE package_connections SET alias=? WHERE id=?").run(alias, id);
      if (d.enabled !== undefined) this.db.query("UPDATE package_connections SET enabled=? WHERE id=?").run(d.enabled ? 1 : 0, id);
    })();
    const after = this.get(id)!;
    if (after.enabled !== before.enabled) this.changed(id, { kind: "reset" });
    else {
      const granted = new Set(grantedScopes(after));
      const revokedScopes = grantedScopes(before).filter((s) => !granted.has(s));
      // Any patch but a rename alone reports its grants, as one that changed nothing always has.
      if (apps || scopes || fullTrust !== undefined || alias === undefined) this.changed(id, { kind: "grants", revoked: before.apps.filter((a) => !after.apps.includes(a)), revokedScopes });
      if (after.alias !== before.alias) this.changed(id, { kind: "label" });
    }
    return after;
  }

  /** The name the other Space gave itself, from its catalogue; kept so its peer keeps that name across restarts. */
  setRemoteName(id: string, name: string | undefined): void {
    const c = this.get(id);
    const next = name && NAME_RE.test(name.toLowerCase()) ? name.toLowerCase() : null;
    if (!c || c.remoteName === next || next === null) return;
    this.db.query("UPDATE package_connections SET remoteName=? WHERE id=?").run(next, id);
    this.changed(id, { kind: "label" });
  }

  rotate(id: string): string {
    const c = this.get(id);
    if (!c || c.direction !== "incoming") throw new Error("only incoming connection tokens can be rotated here");
    const token = randomBytes(32).toString("base64url");
    this.db.query("UPDATE package_connections SET token_hash=? WHERE id=?").run(digest(token), id);
    this.changed(id); return token;
  }

  /** The connection to one other Space, whichever side dialed: there is at most one (`remoteSpaceId` is unique). */
  byRemote(remoteSpaceId: string): Connection | undefined {
    const row = this.db.query("SELECT * FROM package_connections WHERE remoteSpaceId=?").get(remoteSpaceId) as Row | null;
    return row ? view(row) : undefined;
  }

  /** Forget a connection and its grants, for one made with a wrong endpoint, credential name or identity. */
  remove(id: string): Connection {
    const c = this.get(id);
    if (!c) throw new Error("connection not found");
    this.db.query("DELETE FROM package_connections WHERE id=?").run(id);
    this.changed(id); return c;
  }

  authenticate(token: string, remoteSpaceId: string): Connection | undefined {
    if (!token || token.length > 256) return undefined;
    const row = this.db.query("SELECT * FROM package_connections WHERE direction='incoming' AND enabled=1 AND token_hash=? AND remoteSpaceId=?").get(digest(token), remoteSpaceId) as Row | null;
    return row ? view(row) : undefined;
  }

  allows(id: string, app: string): boolean {
    const c = this.get(id);
    return Boolean(c?.enabled && c.apps.includes(app));
  }

  /** Whether the other Space may use `scope` here now: an enabled connection that grants it or trusts fully. */
  allowsScope(id: string, scope: PeerScope): boolean {
    const c = this.get(id);
    return Boolean(c?.enabled && grantedScopes(c).includes(scope));
  }

  private changed(id: string, change: ConnectionChange = { kind: "reset" }): void { for (const fn of this.listeners) fn(id, change); }
}

/** Every scope a connection grants now: all of them under full trust, else the ones ticked. */
export function grantedScopes(c: Pick<Connection, "scopes" | "fullTrust">): PeerScope[] { return c.fullTrust ? [...PEER_SCOPES] : c.scopes; }

/** What the other Space is called here as a peer: the alias, else the name it gave itself, else the start of its id. */
export function peerLabel(c: Pick<Connection, "alias" | "remoteName" | "remoteSpaceId">): string { return c.alias ?? c.remoteName ?? c.remoteSpaceId.slice(0, 8); }

function appNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error("apps must be an application ID list (max 1000)");
  const names = raw.map((v) => text(v, "app", 64));
  if (names.some((n) => !/^[a-z0-9][a-z0-9._-]*$/.test(n) || n === "." || n === "..")) throw new Error("apps must name local applications, not remote paths or wildcards");
  if (new Set(names).size !== names.length) throw new Error("duplicate app grant");
  return names.sort();
}
function flag(raw: unknown, name: string): boolean {
  if (typeof raw !== "boolean") throw new Error(`${name} must be a boolean`);
  return raw;
}
function aliasOf(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !NAME_RE.test(raw)) throw new Error("alias must be a peer name: lowercase letters, digits, '.', '_' or '-', at most 64, or null");
  return raw;
}

function envName(raw: unknown, name: string): string {
  const v = text(raw, name, 120);
  if (!/^[A-Z][A-Z0-9_]*$/.test(v)) throw new Error(`${name} must name a host environment variable`);
  return v;
}

/** An outgoing connection's endpoint: an origin without credentials, HTTPS except on loopback. */
export function connectionUrl(raw: string): string {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("connection URL must be an origin without credentials");
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:")) throw new Error("connections require HTTPS except on loopback");
  return u.origin;
}
function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function view({ token_hash: _secret, apps, enabled, scopes, fullTrust, ...row }: Row): Connection {
  return { ...row, apps: JSON.parse(apps), enabled: Boolean(enabled), scopes: parseScopes(JSON.parse(scopes)), fullTrust: Boolean(fullTrust), alias: row.alias ?? null, remoteName: row.remoteName ?? null, headersEnv: row.headersEnv ?? null };
}
