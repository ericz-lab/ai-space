/**
 * What the window keeps for each saved Space while another one is shown: its web tabs and its
 * terminal sessions (Windows keeps tabs per Space the same way, `AppModel._tabs`). A Space shown
 * again finds them as it left them. A Space removed, or replaced by a new address (the model makes
 * a new `Space` then), loses them.
 */
export class PerSpace<S, T> {
  private readonly entries = new Map<string, { space: S; value: T }>();

  /** `drop` lets go of one value: its tabs closed, its widget taken away. */
  constructor(private readonly drop: (value: T) => void) {}

  /** The value kept for this Space, made the first time it is asked for, and again for a replaced Space. */
  get(id: string, space: S, make: () => T): T {
    const e = this.entries.get(id);
    if (e && e.space === space) return e.value;
    if (e) {
      this.entries.delete(id);
      this.drop(e.value);
    }
    const value = make();
    this.entries.set(id, { space, value });
    return value;
  }

  /** The value kept for this Space, without making one. */
  peek(id: string, space: S): T | undefined {
    const e = this.entries.get(id);
    return e && e.space === space ? e.value : undefined;
  }

  /** Drops what was kept for Spaces no longer saved (`saved` answers undefined) or replaced since. */
  prune(saved: (id: string) => S | undefined): void {
    for (const [id, e] of [...this.entries]) {
      if (saved(id) === e.space) continue;
      this.entries.delete(id);
      this.drop(e.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
