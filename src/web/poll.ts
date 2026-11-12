/**
 * Calls `tick` every `ms` while the page is visible: a hidden tab stops asking, and becoming visible
 * again calls `tick` at once and restarts the period. The first call is the caller's, as before.
 * Returns the cleanup for a `useEffect`.
 */
export function pollWhileVisible(tick: () => unknown, ms: number, doc: Document = document): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer === undefined) timer = setInterval(tick, ms);
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const sync = () => {
    if (doc.hidden) return stop();
    if (timer !== undefined) return;
    void tick();
    start();
  };
  if (!doc.hidden) start();
  doc.addEventListener("visibilitychange", sync);
  return () => {
    stop();
    doc.removeEventListener("visibilitychange", sync);
  };
}
