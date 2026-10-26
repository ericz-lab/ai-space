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
  /** The Space the Local edition installed here: the app signs in with its device credential and manages its service. */
  managed: boolean;
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
    // Saved before the Local edition existed: not managed.
    return { id: o.id, name: o.name, url: o.url, isDefault: o.isDefault === true, managed: o.managed === true };
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

  get managed(): Connection | undefined {
    return this.connections.find((c) => c.managed);
  }

  get(id: string): Connection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  add(name: string, url: string, opts: { makeDefault?: boolean; managed?: boolean } = {}): Connection {
    const c: Connection = { id: this.newId(), name: displayName(name, url), url, isDefault: Boolean(opts.makeDefault) || this.connections.length === 0, managed: Boolean(opts.managed) };
    if (c.isDefault) for (const o of this.connections) o.isDefault = false;
    this.connections.push(c);
    return c;
  }

  /**
   * A new name or address. Returns whether the address now names another origin; the device
   * credential belongs to the Local edition's own address, so such a Space is no longer the app's
   * own (`localToClaim` marks it again when it points back there).
   */
  update(id: string, name: string, url: string): boolean {
    const c = this.get(id);
    if (!c) return false;
    const moved = !sameOrigin(c.url, url);
    c.name = displayName(name, url);
    c.url = url;
    if (moved) c.managed = false;
    return moved;
  }

  setManaged(id: string, url: string, managed = true): void {
    const c = this.get(id);
    if (!c) return;
    c.managed = managed;
    c.url = url;
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

/**
 * The saved Space that is the Local edition's own but not marked so: the Local edition runs this
 * computer's Space (`state` "managed") and no saved Space is marked, but one points at its address,
 * as when it was added by hand, from the welcome screen's suggestion, or before the setup. The app
 * then signs in to it with the device credential instead of asking for an owner password the Local
 * edition never sets.
 */
export function localToClaim(connections: readonly Connection[], local: { state: string; url: string } | undefined): string | undefined {
  if (local?.state !== "managed" || connections.some((c) => c.managed)) return undefined;
  return connections.find((c) => sameOrigin(c.url, local.url))?.id;
}
