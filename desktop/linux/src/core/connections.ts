import { hostOf, isLoopback, sameOrigin } from "./url.ts";

/**
 * The saved Spaces, as the Mac client keeps them (`ConnectionStore.swift`): one JSON file under
 * the user's configuration directory, separate from any workspace. Exactly one is the default
 * while any exist. Removing one changes only this computer, never the server.
 */
export type Connection = {
  id: string;
  name: string;
  /** The panel URL, normalized (`normalizeConnectionUrl`). */
  url: string;
  isDefault: boolean;
};

export const LOCAL_DEFAULT_URL = "http://127.0.0.1:8700/";

export const isLocalConnection = (c: Connection) => isLoopback(hostOf(c.url));

export function displayName(name: string, url: string): string {
  return name.trim() || hostOf(url) || url;
}

/** Reads the saved file; throws when it is not a list of connections, so the caller can set it aside. */
export function decodeConnections(text: string): Connection[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("not a list");
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string" || typeof o.url !== "string") throw new Error("not a connection");
    // Fields this app no longer knows (`managed`, written by the retired Local edition) are dropped,
    // so the next save leaves them out; the Space itself stays saved.
    return { id: o.id, name: o.name, url: o.url, isDefault: o.isDefault === true };
  });
}

export function encodeConnections(list: Connection[]): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

/** The list and its rules; persistence is the caller's (`save` after every change). */
export class ConnectionList {
  constructor(
    public connections: Connection[] = [],
    private readonly newId: () => string,
  ) {
    if (connections.length && !connections.some((c) => c.isDefault)) connections[0]!.isDefault = true;
  }

  get default(): Connection | undefined {
    return this.connections.find((c) => c.isDefault) ?? this.connections[0];
  }

  get(id: string): Connection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  add(name: string, url: string, opts: { makeDefault?: boolean } = {}): Connection {
    const c: Connection = { id: this.newId(), name: displayName(name, url), url, isDefault: Boolean(opts.makeDefault) || this.connections.length === 0 };
    if (c.isDefault) for (const o of this.connections) o.isDefault = false;
    this.connections.push(c);
    return c;
  }

  /** A new name or address. Returns whether the address now names another origin. */
  update(id: string, name: string, url: string): boolean {
    const c = this.get(id);
    if (!c) return false;
    const moved = !sameOrigin(c.url, url);
    c.name = displayName(name, url);
    c.url = url;
    return moved;
  }

  setDefault(id: string): void {
    if (!this.get(id)) return;
    for (const c of this.connections) c.isDefault = c.id === id;
  }

  remove(id: string): void {
    this.connections = this.connections.filter((c) => c.id !== id);
    if (this.connections.length && !this.connections.some((c) => c.isDefault)) this.connections[0]!.isDefault = true;
  }
}
