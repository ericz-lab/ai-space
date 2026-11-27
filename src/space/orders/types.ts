/**
 * Orders (docs/orders.md): a sentence the person says or types, sorted into a topic, handled by a
 * turn of the built-in Director (`space/director`) on that topic's session.
 */

/** A topic's state, computed from its runs and the Director's status line (docs/orders.md#state). */
export const TOPIC_STATES = ["working", "needs-you", "done", "failed"] as const;
export type TopicState = (typeof TOPIC_STATES)[number];

/** How an order reached its topic: the model's decision, the fallback when the model gave none, or the person. */
export type RoutedBy = "model" | "fallback" | "person";

export const ORDER_VIA = ["voice", "type", "screenshot", "share", "pick", "paste"] as const;
export type OrderVia = (typeof ORDER_VIA)[number];

export type Topic = {
  id: number;
  title: string;
  /** The Director's session for this topic; null until its first turn reported one. */
  sessionId: string | null;
  /** The newest Director run on this topic (started by the service or by the person in the chat). */
  runId: string | null;
  createdAt: number;
  lastActiveAt: number;
  state: TopicState;
  /** What the Director's last reply said last (status line taken out), for the list and the notification. */
  summary: string;
  archived: boolean;
};

export type Order = {
  id: number;
  /** The client's UUID: a retry with the same one answers the first order. */
  clientId: string;
  topicId: number | null;
  text: string;
  via: OrderVia | null;
  imagePath: string | null;
  imageMime: string | null;
  imageBytes: number | null;
  createdAt: number;
  /** The turn that took it: started with it, or added to while running. Null while it waits. */
  runId: string | null;
  routedBy: RoutedBy | null;
};

export type OrdersSettings = {
  /** How many days back a topic is a candidate for a new order (`orders.topicDays`). */
  topicDays: number;
  /** Where a `needs-you` notification goes: a notify channel, `default`, or `off` (`orders.notify`). */
  notify: string;
};

export const DEFAULT_SETTINGS: OrdersSettings = { topicDays: 3, notify: "default" };
export const MIN_TOPIC_DAYS = 1;
export const MAX_TOPIC_DAYS = 30;

/** The model tag of the sorting call; the basic tier unless Settings → Models overrides it for `space`. */
export const ORDERS_TOPIC_TAG = "orders.topic";
/** ai-space's own model layers, as an app's manifest `model:` section would give them (docs/model.md#app-models). */
export const SPACE_MODEL_SPEC = { tags: { [ORDERS_TOPIC_TAG]: "basic" } };

/** At most this many candidate topics go to the sorting call. */
export const MAX_CANDIDATES = 20;
/** The sorting call's prompt, about. */
export const MAX_SORT_PROMPT = 7_000;
/** The sorting call gives up after this long and the order opens a new topic. */
export const SORT_TIMEOUT_MS = 60_000;
/** The longest order text (as `/api/capture/text` takes). */
export const MAX_ORDER_TEXT = 20_000;
/** A screenshot's bytes at most: the bus's call body cap. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** What an event or a notification carries of a reply or an order, at most. */
export const MAX_SUMMARY = 600;
/** A topic's title, at most. */
export const MAX_TITLE = 80;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** The image type its bytes say, or undefined for anything else. */
export function sniffImage(bytes: Uint8Array): (typeof IMAGE_TYPES)[number] | undefined {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  return undefined;
}

export const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** The label a client shows for an order ("Order #12"). */
export const orderLabel = (id: number) => `Order #${id}`;

/** Where an order opens in the panel (docs/panel.md#panel-links), relative to the Space that keeps it. */
export const orderUrl = (id: number) => `/#order=${id}`;

export class OrdersError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
