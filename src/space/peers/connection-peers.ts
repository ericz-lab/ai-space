import type { RemotePeerGrant } from "../packages/catalogue.ts";
import type { Connections } from "../packages/connections.ts";
import { DEFAULT_REFRESH_MS, PEER_NAME_RE } from "./config.ts";
import type { PeerHub } from "./hub.ts";

/**
 * The hub side of the connection transport (docs/peers.md#adding-a-peer): every package connection whose
 * other Space grants this one the `panel` scope (or trusts it fully) is a peer in `PeerHub`, reached over
 * the connection's channel instead of HTTPS. Everything above the client (the merged lists, the
 * `/api/peers/<peer>/...` routes, model adapters, ledgers, the event mirror, bus calls, the terminal bridge)
 * is the same for both kinds of peer.
 *
 * The peer's name is the connection's label (connections.ts `peerLabel`: its alias, else the name the other
 * Space gives itself, else the start of its id), and the hub keeps everything under that name as it does
 * for `SPACE_PEER_<NAME>`: give the connection the old name as its alias and a machine that moves from a
 * legacy peer to a connection keeps its snapshot, cursor, hidden apps, tile order and ledger rows.
 *
 * One machine is shown once. A legacy peer wins over a connection of the same name, and over a connection
 * to the Space its snapshot names as its id; two connections with one label: the first by id wins. A name
 * a local app has is not taken. The others are listed here with the reason (`status`).
 */

export type ConnectionPeerState = {
  connection: string;
  name: string;
  /** `peer`: in the hub now; else why not. */
  state: "peer" | "no-panel" | "shadowed" | "reserved" | "invalid-name";
  reason?: string;
  /** What the other Space lets this one do through its `/api/peer/*`, as its last catalogue said. */
  granted: RemotePeerGrant;
};

type Catalogue = {
  peerGrants(): { connection: string; spaceId: string; label: string; grant: RemotePeerGrant; ok: boolean }[];
  onUpdate(fn: () => void): () => void;
};

export class ConnectionPeers {
  private states: ConnectionPeerState[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: {
    hub: PeerHub;
    catalogue: Catalogue;
    connections: Connections;
    /** A name a local app has (`<name>/` would be ambiguous on the panel). */
    reserved?: (name: string) => boolean;
    refreshMs?: number;
  }) {
    this.unsubscribe = opts.catalogue.onUpdate(() => this.sync());
  }

  /** Make the hub's connection peers what the connections and their last catalogues say. */
  sync(): void {
    const { hub } = this.opts;
    const legacy = hub.names().map((n) => hub.get(n)!).filter((c) => !c.config.connection);
    const legacyNames = new Set(legacy.map((c) => c.name));
    const legacyIds = new Map(legacy.flatMap((c) => (c.snapshot?.id ? [[c.snapshot.id, c.name] as const] : [])));
    const states: ConnectionPeerState[] = [];
    const wanted = new Map<string, string>(); // name -> connection
    for (const g of [...this.opts.catalogue.peerGrants()].sort((a, b) => a.connection.localeCompare(b.connection))) {
      const c = this.opts.connections.get(g.connection);
      if (!c?.enabled) continue;
      const name = g.label;
      const state = (s: ConnectionPeerState["state"], reason?: string) => states.push({ connection: g.connection, name, state: s, ...(reason ? { reason } : {}), granted: g.grant });
      if (!g.grant.fullTrust && !g.grant.scopes.includes("panel")) { state("no-panel", "the other Space grants this one no panel scope"); continue; }
      if (!PEER_NAME_RE.test(name) || name === "model") { state("invalid-name", `"${name}" is not a peer name; set an alias`); continue; }
      if (legacyNames.has(name)) { state("shadowed", `SPACE_PEER_${name.toUpperCase().replace(/-/g, "_")} names a peer of the same name, which wins`); continue; }
      const sameSpace = legacyIds.get(g.spaceId);
      if (sameSpace) { state("shadowed", `the legacy peer ${sameSpace} is the same Space, and wins`); continue; }
      if (wanted.has(name)) { state("shadowed", `connection ${wanted.get(name)} has the same name; set an alias`); continue; }
      if (this.opts.reserved?.(name)) { state("reserved", `"${name}" is the name of a local app; set an alias`); continue; }
      wanted.set(name, g.connection);
      state("peer");
    }
    for (const name of hub.names()) {
      const c = hub.get(name)!;
      if (c.config.connection && wanted.get(name) !== c.config.connection) hub.detach(name);
    }
    for (const [name, connection] of wanted) {
      if (hub.get(name)) continue;
      hub.attach({ name, url: `connection:${connection}`, token: "", headers: {}, refreshMs: this.opts.refreshMs ?? DEFAULT_REFRESH_MS, connection, spaceId: this.opts.connections.get(connection)!.remoteSpaceId });
    }
    this.states = states;
  }

  /** Each connection the catalogue knows, and whether it is a peer here or why not. */
  status(): ConnectionPeerState[] { return this.states; }

  close(): void {
    this.unsubscribe();
    for (const name of this.opts.hub.names()) if (this.opts.hub.get(name)?.config.connection) this.opts.hub.detach(name);
  }
}
