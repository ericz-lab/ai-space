import { randomBytes, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { installationKey, mapping, text } from "./contract.ts";

export type Connection = { id: string; remoteSpaceId: string; direction: "incoming" | "outgoing"; url: string | null; tokenEnv: string | null; apps: string[]; enabled: boolean };
type Row = Omit<Connection, "apps" | "enabled"> & { apps: string; enabled: number; token_hash: string | null };

/** Grants describe access to OUR applications. Remote configuration cannot widen them. */
export class Connections {
  private readonly listeners = new Set<(id: string) => void>();
  constructor(private readonly db: Database, readonly spaceId: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS package_connections (
      id TEXT PRIMARY KEY, remoteSpaceId TEXT NOT NULL UNIQUE, direction TEXT NOT NULL,
      url TEXT, tokenEnv TEXT, token_hash TEXT, apps TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1
    )`);
  }

  list(): Connection[] { return (this.db.query("SELECT * FROM package_connections ORDER BY id").all() as Row[]).map(view); }
  get(id: string): Connection | undefined {
    const row = this.db.query("SELECT * FROM package_connections WHERE id=?").get(id) as Row | null;
    return row ? view(row) : undefined;
  }
  onChange(fn: (id: string) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  create(raw: unknown): { connection: Connection; token?: string } {
    const d = mapping(raw, "connection", ["remoteSpaceId", "direction", "url", "tokenEnv", "apps"]);
    const remoteSpaceId = text(d.remoteSpaceId, "remoteSpaceId", 36);
    installationKey(remoteSpaceId, "validation");
    if (remoteSpaceId === this.spaceId) throw new Error("cannot connect a Space to itself");
    if (d.direction !== "incoming" && d.direction !== "outgoing") throw new Error("direction must be incoming or outgoing");
    const apps = appNames(d.apps ?? []);
    let url: string | null = null, tokenEnv: string | null = null;
    if (d.direction === "outgoing") {
      url = connectionUrl(text(d.url, "url", 2048));
      tokenEnv = text(d.tokenEnv, "tokenEnv", 120);
      if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) throw new Error("tokenEnv must name a host environment variable");
    } else if (d.url !== undefined || d.tokenEnv !== undefined) throw new Error("incoming connections do not take url or tokenEnv");
    const id = crypto.randomUUID();
    const token = d.direction === "incoming" ? randomBytes(32).toString("base64url") : undefined;
    this.db.query("INSERT INTO package_connections(id,remoteSpaceId,direction,url,tokenEnv,token_hash,apps) VALUES(?,?,?,?,?,?,?)").run(id, remoteSpaceId, d.direction, url, tokenEnv, token ? digest(token) : null, JSON.stringify(apps));
    this.changed(id);
    return { connection: this.get(id)!, ...(token ? { token } : {}) };
  }

  update(id: string, raw: unknown): Connection {
    if (!this.get(id)) throw new Error("connection not found");
    const d = mapping(raw, "connection patch", ["apps", "enabled"]);
    const apps = d.apps === undefined ? undefined : appNames(d.apps);
    if (d.enabled !== undefined && typeof d.enabled !== "boolean") throw new Error("enabled must be a boolean");
    this.db.transaction(() => {
      if (apps) this.db.query("UPDATE package_connections SET apps=? WHERE id=?").run(JSON.stringify(apps), id);
      if (d.enabled !== undefined) this.db.query("UPDATE package_connections SET enabled=? WHERE id=?").run(d.enabled ? 1 : 0, id);
    })();
    this.changed(id); return this.get(id)!;
  }

  rotate(id: string): string {
    const c = this.get(id);
    if (!c || c.direction !== "incoming") throw new Error("only incoming connection tokens can be rotated here");
    const token = randomBytes(32).toString("base64url");
    this.db.query("UPDATE package_connections SET token_hash=? WHERE id=?").run(digest(token), id);
    this.changed(id); return token;
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

  private changed(id: string): void { for (const fn of this.listeners) fn(id); }
}

function appNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error("apps must be an application ID list (max 1000)");
  const names = raw.map((v) => text(v, "app", 64));
  if (names.some((n) => !/^[a-z0-9][a-z0-9._-]*$/.test(n) || n === "." || n === "..")) throw new Error("apps must name local applications, not remote paths or wildcards");
  if (new Set(names).size !== names.length) throw new Error("duplicate app grant");
  return names.sort();
}

function connectionUrl(raw: string): string {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("connection URL must be an origin without credentials");
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:")) throw new Error("connections require HTTPS except on loopback");
  return u.origin;
}
function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function view({ token_hash: _secret, apps, enabled, ...row }: Row): Connection { return { ...row, apps: JSON.parse(apps), enabled: Boolean(enabled) }; }
