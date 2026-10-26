import GLib from "gi://GLib";
import system from "system";
import { readTextSync } from "./env.ts";

/**
 * Memory upkeep for a window that stays open for days (docs/linux-desktop.md#memory). GJS starts
 * a garbage collection by the size of its own heap and cannot see what its objects hold outside it
 * (widgets, Pango layouts, textures, the bytes of an answer): a tree of widgets dropped from the
 * screen weighs a few kilobytes to the collector and megabytes to the process. After the app drops
 * many widgets, or reads the Space again, it asks for a collection itself once things settle.
 */

let pending = 0;

/** A full collection a little later; asking again meanwhile does not add one. */
export function collectSoon(ms = 2000): void {
  if (pending) return;
  pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, ms, () => {
    pending = 0;
    system.gc();
    return GLib.SOURCE_REMOVE;
  });
}

/** `AISPACE_MEMSTAT=<seconds>`: every so often, the process's RSS and threads on stderr. */
export function startMemoryStats(): void {
  const every = Number(GLib.getenv("AISPACE_MEMSTAT") ?? "0");
  if (!(every > 0)) return;
  GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, every, () => {
    const status = readTextSync("/proc/self/status") ?? "";
    const field = (name: string) => new RegExp(`^${name}:\\s*(\\d+)`, "m").exec(status)?.[1] ?? "?";
    printerr(`[ai-space] memstat rss=${field("VmRSS")}kB threads=${field("Threads")}`);
    return GLib.SOURCE_CONTINUE;
  });
}
