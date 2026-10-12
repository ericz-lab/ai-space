/**
 * The box the person types in, apart from the DOM: the text kept per thread
 * while they look elsewhere, and which key press sends.
 */

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Unsent text, one entry per scope and thread (`null` = the scope before its
 * first thread). Held in memory and, when the page allows it, in the browser's
 * storage, so a reload keeps it; a storage that throws (private mode, quota)
 * is ignored.
 */
export class Drafts {
  private readonly mem = new Map<string, string>();

  constructor(
    private readonly prefix: string,
    private readonly storage?: DraftStorage,
  ) {}

  private key(scope: string, threadId: number | null): string {
    return `${this.prefix}${scope}#${threadId ?? "new"}`;
  }

  get(scope: string, threadId: number | null): string {
    const k = this.key(scope, threadId);
    const held = this.mem.get(k);
    if (held !== undefined) return held;
    try {
      return this.storage?.getItem(k) ?? "";
    } catch {
      return "";
    }
  }

  /** Keep the text, or with nothing but blanks forget the entry. */
  set(scope: string, threadId: number | null, text: string): void {
    const k = this.key(scope, threadId);
    const keep = text.trim() ? text : "";
    this.mem.set(k, keep);
    try {
      if (keep) this.storage?.setItem(k, keep);
      else this.storage?.removeItem(k);
    } catch {
      /* the copy in memory still holds for this page */
    }
  }
}

/**
 * Whether a key press in the box sends the message: Enter alone. Enter that
 * confirms an input method's candidate does not: browsers mark it with
 * `isComposing`, and Safari, which ends the composition first, with key code 229.
 */
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}
