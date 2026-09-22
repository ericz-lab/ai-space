import type { Database } from "bun:sqlite";
import type { PeerSnapshot } from "./client.ts";

/**
 * The last good snapshot per peer, kept in ai-space's own database so a hub
 * that restarts while a peer is down still lists that peer's apps (muted).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peer_snapshots (
  peer  TEXT PRIMARY KEY,
  json  TEXT NOT NULL,
  as_of TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_cursors (
  peer           TEXT PRIMARY KEY,
  last_event_id  INTEGER NOT NULL
);
`;

export class PeerStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  get(peer: string): PeerSnapshot | undefined {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM peer_snapshots WHERE peer = ?").get(peer);
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as PeerSnapshot;
    } catch {
      return undefined;
    }
  }

  set(peer: string, snapshot: PeerSnapshot): void {
    this.db.query("INSERT INTO peer_snapshots (peer, json, as_of) VALUES (?, ?, ?) ON CONFLICT(peer) DO UPDATE SET json = excluded.json, as_of = excluded.as_of").run(peer, JSON.stringify(snapshot), snapshot.asOf);
  }

  /** The id of the last event mirrored from the peer (docs/events.md); 0 = nothing yet. */
  cursor(peer: string): number {
    return this.db.query<{ last_event_id: number }, [string]>("SELECT last_event_id FROM peer_cursors WHERE peer = ?").get(peer)?.last_event_id ?? 0;
  }

  setCursor(peer: string, lastEventId: number): void {
    this.db.query("INSERT INTO peer_cursors (peer, last_event_id) VALUES (?, ?) ON CONFLICT(peer) DO UPDATE SET last_event_id = excluded.last_event_id").run(peer, lastEventId);
  }

  /** Drop snapshots and cursors of peers that are no longer configured. */
  prune(keep: string[]): void {
    const names = new Set(keep);
    for (const table of ["peer_snapshots", "peer_cursors"]) {
      for (const { peer } of this.db.query<{ peer: string }, []>(`SELECT peer FROM ${table}`).all()) {
        if (!names.has(peer)) this.db.query(`DELETE FROM ${table} WHERE peer = ?`).run(peer);
      }
    }
  }
}
