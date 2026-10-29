/**
 * Feedback from app pages (docs/feedback.md): the floating button an app page loads with
 * `/_space/feedback.js`, what it sends, the settings that turn it on, and the rows the space keeps.
 */

/** What happens to a new piece of feedback: the fix engineer starts at once, or it waits for a batch. */
export const MODES = ["auto", "later"] as const;
export type Mode = (typeof MODES)[number];

/** An app's own switch: follow the default, or on / off for this app only. */
export const APP_SWITCHES = ["default", "on", "off"] as const;
export type AppSwitch = (typeof APP_SWITCHES)[number];

/** Claude Code's effort levels the fix engineer may run at (`--effort`). */
export const EFFORTS = ["high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type FeedbackSettings = {
  /** The master switch: off, no app shows the button. */
  enabled: boolean;
  /** Apps with no switch of their own show the button when this is true. */
  appsDefault: boolean;
  /** Per-app overrides; an app missing here follows `appsDefault`. */
  apps: Record<string, "on" | "off">;
  mode: Mode;
  /** Where the fix engineer runs: "" for this machine, else a peer's name. */
  machine: string;
  /** `runtime/model` the fix engineer runs on; "" for the space's default. */
  model: string;
  effort: Effort;
  /** Whether the page sends the last script errors it saw. */
  errors: boolean;
};

export const DEFAULT_SETTINGS: FeedbackSettings = {
  enabled: false,
  appsDefault: true,
  apps: {},
  mode: "auto",
  machine: "",
  model: "claude/intermediate",
  effort: "xhigh",
  errors: true,
};

/**
 * A row's life: `later` waits for a batch the person starts, `queued` waits for the engineer (it
 * starts once the app's current fix ends), `fixing` has a run, `review` waits for the person in
 * ai-todo, `failed` ended without a fix, `skipped` was not an app fix (it needs a person), and
 * `recorded` found no todo app to go to. `accepted` and `dropped` follow the task: the person marked
 * it done, or dropped or deleted it, in ai-todo (synced by FeedbackService.syncTodos).
 */
export const STATUSES = ["later", "queued", "fixing", "review", "failed", "skipped", "recorded", "accepted", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

/** States a row leaves when its task is closed in ai-todo: not while a fix is queued or running. */
export const TODO_SYNCED: readonly Status[] = ["later", "review", "failed", "skipped"];

export type ClientKind = "desktop-browser" | "phone-browser" | "tablet-browser" | "mac-client" | "iphone-client" | "android-client" | "linux-client";
export type ClientInfo = { kind: ClientKind; os: string; browser: string; version?: string };

/** A page element the person picked, as the script describes it. */
export type PickedElement = {
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; w: number; h: number };
};

/** What the page tells about itself; every field is cleaned and bounded on the server. */
export type PageContext = {
  url: string;
  path: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  touch: boolean;
  theme: "light" | "dark";
  lang: string;
  elements: PickedElement[];
  errors: string[];
  tz: string;
};

export type FeedbackImage = { name: string; type: string; bytes: Uint8Array };

export type FeedbackRow = {
  id: number;
  app: string;
  text: string;
  context: PageContext;
  client: ClientInfo;
  status: Status;
  /** The todo in ai-todo, and the peer that holds it ("" here). */
  todoId: number | null;
  todoPeer: string;
  todoUrl: string | null;
  /** Where the person asked the fix to run ("" here, else a peer); null follows Settings. */
  fixMachine: string | null;
  /** The engineer's run, and the machine it ran on ("" here). */
  runId: string | null;
  runMachine: string;
  /** The last thing that went wrong, or the engineer's note. */
  note: string | null;
  createdAt: number;
  updatedAt: number;
};

/** What the page may read back: no context, no run ids. */
export type RecentView = { id: number; text: string; status: Status; todoId: number | null; todoUrl: string | null; createdAt: number };

export const LIMITS = {
  text: 4000,
  title: 200,
  url: 2000,
  elements: 5,
  elementText: 200,
  elementHtml: 2000,
  selector: 300,
  errors: 10,
  errorText: 300,
  images: 2,
  imageBytes: 3 * 1024 * 1024,
  body: 9 * 1024 * 1024,
  /** Per app, in a rolling hour: a stuck key or a loop must not start a hundred runs. */
  perHour: 30,
} as const;
