/**
 * Data model of the usage service (docs/usage.md): how often a person opens an
 * app, an agent or one of the panel's own windows, and how long they use it.
 * This is about people using things, not about model tokens (that is the model
 * ledger). Nothing here says who, from where, or what was on the page.
 */

export const KINDS = ["app", "agent", "builtin"] as const;
export type Kind = (typeof KINDS)[number];

/** Where an open came from: a tile on a screen, a library card, or a chat turn. */
export const SOURCES = ["panel", "library", "chat"] as const;
export type Source = (typeof SOURCES)[number];

export const WINDOWS = ["7d", "30d", "90d", "all"] as const;
export type Window = (typeof WINDOWS)[number];
export const WINDOW_MS: Record<Window, number> = { "7d": 7 * 86400_000, "30d": 30 * 86400_000, "90d": 90 * 86400_000, all: Number.POSITIVE_INFINITY };

/** An app (`ai-todo`), an agent (`ai-todo/planner`), a built-in (`settings`); a peer's entries carry `<peer>/` in front. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,2}$/i;
/** The random id the heartbeat script keeps per browser tab. */
export const TAB_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const APP_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** A heartbeat within this long of the segment's last one extends it; a later one starts a new segment. */
export const BEAT_GAP_MS = 90_000;
/** One heartbeat adds at most this much time, whatever the gap. */
export const BEAT_MAX_STEP_MS = 60_000;
/** Heartbeats of a tab closer together than this are dropped. */
export const BEAT_MIN_INTERVAL_MS = 20_000;
/** Agent turns of one conversation closer together than this make one segment. */
export const AGENT_GAP_MS = 10 * 60_000;

/** One entry's usage over a window, as `GET /api/usage` returns it. */
export type UsageRow = {
  kind: Kind;
  key: string;
  opens: number;
  /** Time in use; null when nothing measures it (a built-in, an app without the heartbeat script). */
  activeMs: number | null;
  sessions: number;
  /** The newest open or heartbeat, ISO; null when there is none in the window. */
  lastAt: string | null;
  /** Per UTC day inside the window, oldest first; days without use are left out. */
  daily: { day: string; opens: number; activeMs: number }[];
};

/** What a heartbeat did. */
export type BeatResult = "new" | "extended" | "dropped";
