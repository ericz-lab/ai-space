/** Foreground use of the Space client. Native WebViews are counted by their host app. */
export function startDeviceUsage(win: Window = window, doc: Document = document): () => void {
  if (/AISpace(?:Mobile|Desktop)\//.test(win.navigator.userAgent)) return () => {};
  let deviceId: string;
  try {
    const key = "space-usage-device";
    const saved = win.localStorage.getItem(key);
    deviceId = saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved) ? saved : crypto.randomUUID();
    win.localStorage.setItem(key, deviceId);
  } catch { return () => {}; } // No storage means no stable identity; do not invent a new device on every load.
  let session: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const send = (active: boolean) => {
    if (!session) return;
    const body = JSON.stringify({ deviceId, client: "web", session, active });
    try {
      if (!win.navigator.sendBeacon?.("/api/panel/usage/device", new Blob([body], { type: "text/plain" }))) {
        void win.fetch("/api/panel/usage/device", { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch { /* Telemetry must never interrupt navigation. */ }
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    send(false);
    session = null;
  };
  const sync = () => {
    if (doc.visibilityState !== "visible") { stop(); return; }
    if (session) return;
    session = crypto.randomUUID();
    send(true);
    timer = setInterval(() => send(true), 30_000);
  };
  doc.addEventListener("visibilitychange", sync);
  win.addEventListener("pagehide", stop);
  win.addEventListener("pageshow", sync);
  sync();
  return () => {
    stop();
    doc.removeEventListener("visibilitychange", sync);
    win.removeEventListener("pagehide", stop);
    win.removeEventListener("pageshow", sync);
  };
}
