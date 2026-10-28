import Gio from "gi://Gio";

/**
 * The streams over a file descriptor: GioUnix's since GLib 2.80, Gio's before (GJS warns on each
 * use of the old names where the new ones exist). Looked up through `imports.gi`, which throws
 * synchronously for a missing library; a top-level `await import()` would run the app inside a
 * promise job, where GJS runs no other job, so every later `await` would hang.
 */
export function unixStreams(): { InputStream: any; OutputStream: any } {
  try {
    const GioUnix = (globalThis as any).imports.gi.GioUnix;
    if (GioUnix?.InputStream && GioUnix?.OutputStream) return { InputStream: GioUnix.InputStream, OutputStream: GioUnix.OutputStream };
  } catch {
    // GLib before 2.80.
  }
  return { InputStream: (Gio as any).UnixInputStream, OutputStream: (Gio as any).UnixOutputStream };
}
