/**
 * Telling a real change from the same answer fetched again. The app looks at the Space every
 * 30 seconds and almost always gets back what it already shows; redrawing for nothing costs a
 * whole tree of widgets each time (docs/linux-desktop.md#memory), so views redraw only when what
 * they show is different.
 */

/** A value as text that is the same whenever the value is: object keys sorted, `undefined` left out as JSON does. */
export function signature(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  }) ?? "undefined";
}

/** The last signature seen under each key: `changed` says whether a value differs from the one before. */
export class ChangeGate {
  private readonly last = new Map<string, string>();

  /** True the first time a key is seen and whenever its value is different; records the value either way. */
  changed(key: string, value: unknown): boolean {
    const sig = signature(value);
    if (this.last.get(key) === sig) return false;
    this.last.set(key, sig);
    return true;
  }

  /** The next value under `key` counts as a change (a view was emptied, a Space was removed). */
  forget(key: string): void {
    this.last.delete(key);
  }

  /** Forgets every key `keep` says no to. */
  keepOnly(keep: (key: string) => boolean): void {
    for (const k of [...this.last.keys()]) if (!keep(k)) this.last.delete(k);
  }
}
