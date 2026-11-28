import { RunStateError, type RunInfo, type RunRegistry } from "../agents/runs.ts";
import type { ChatImage } from "../agents/images.ts";
import { finalText } from "../feedback/prompt.ts";
import { PERMISSION_MODE, type TeamStore } from "../team/store.ts";
import { transcriptPrompt } from "./import.ts";
import { DIRECTOR_AGENT, turnMessage } from "./prompt.ts";
import { type Candidate, SORT_SYSTEM, fallbackTitle, parseDecision, sortPrompt } from "./sort.ts";
import { lastWords, parseStatus, stripStatus } from "./status.ts";
import type { NewOrder, OrdersStore } from "./store.ts";
import {
  MAX_CANDIDATES,
  MAX_IMAGE_BYTES,
  MAX_ORDER_TEXT,
  MAX_SUMMARY,
  MAX_TITLE,
  MAX_TOPIC_DAYS,
  MIN_TOPIC_DAYS,
  ORDER_VIA,
  type Order,
  type OrderVia,
  type OrdersSettings,
  OrdersError,
  type RoutedBy,
  SORT_TIMEOUT_MS,
  type Topic,
  type TopicState,
  orderUrl,
  sniffImage,
} from "./types.ts";

/**
 * The orders service (docs/orders.md): stores an order, sorts it into a topic with one model call,
 * and starts a turn of the built-in Director (`space/director`) on the topic's session, in process
 * through the agents' own chat route as the feedback service starts the Fix Engineer. A topic's
 * state is computed from its runs and the Director's status line; each change is published as
 * `space/order.state`, and a topic that starts waiting for the person is notified once.
 *
 * An order for a topic whose turn is running is added to that turn (`steer`); when the runtime
 * cannot take it, or the turn has just ended, it waits and starts the next turn when this one ends.
 * Orders of one topic are handled one at a time, in order; sorting is one order at a time too.
 */

export const DIRECTOR_ID = `space/${DIRECTOR_AGENT}`;

type ChatHandler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

export type OrdersServiceOptions = {
  store: OrdersStore;
  team: TeamStore;
  runs: RunRegistry;
  /** The agents' chat route (`POST /api/agents/:app/:agent/chat`), called in process. */
  chat: ChatHandler;
  /** The sorting call: the model's answer, or undefined when it failed. */
  decide: (prompt: string, system: string, signal: AbortSignal) => Promise<string | undefined>;
  /** A topic's conversation, for the sorting prompt: the Director session's messages, oldest first. */
  messages?: (sessionId: string) => Promise<{ role: string; text: string }[]>;
  /** Publish a `space/<name>` event on the bus. */
  publish?: (name: string, data: Record<string, unknown>) => void;
  /** Send the `needs-you` notification; `channel` undefined is the default channel. */
  notify?: (n: { title: string; text: string; url: string; key: string; channel?: string }) => Promise<void>;
  /** The panel's address for the notification's link (`https://panel.example`); empty: a path. */
  panelBase?: string;
  /** The notify channels that exist, for the setting's check. */
  channels?: () => string[];
  /**
   * The delegations of the Director's sessions (docs/orders.md#state): a topic is `working` while one
   * of its delegations runs and `needs-you` while a delegate waits for the person.
   */
  delegations?: {
    activity: (session: string) => { running: boolean; waiting: boolean; asking: string[]; full: boolean };
    onChange: (fn: (d: { id: number; label: string; from: { session: string | null }; to: { title: string; role: string }; state: string; asking: string[] }) => void) => () => void;
    onHeld: (fn: (d: { id: number; label: string; from: { session: string | null }; to: { title: string; role: string } }) => void) => () => void;
  };
  sortTimeoutMs?: number;
  log?: (line: string) => void;
  now?: () => number;
};

export type SubmitInput = {
  clientId?: string;
  text: string;
  via?: string;
  image?: { bytes: Uint8Array; mime?: string };
  /** The person filed it under this topic themselves (the page's box in a topic). */
  topicId?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The chat route's longest message (agents/api.ts MAX_MESSAGE). */
const MAX_TURN_MESSAGE = 20_000;

export class OrdersService {
  private readonly store: OrdersStore;
  private readonly runs: RunRegistry;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private sorting: Promise<void> = Promise.resolve();
  private readonly locks = new Map<number, Promise<void>>();
  /** Runs whose events are followed, by run id: the topic and the approvals it waits on. */
  private readonly followed = new Map<string, { topicId: number; asking: Map<string, string> }>();
  private unwatch: (() => void) | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly opts: OrdersServiceOptions) {
    this.store = opts.store;
    this.runs = opts.runs;
    this.log = opts.log ?? ((l) => console.log(`[orders] ${l}`));
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * After a restart: a topic whose turn did not live to its end shows `failed` (the run was marked
   * interrupted), a session reported before the end is kept, orders stored but not sorted are
   * sorted, and orders sorted but not taken start their topic's next turn.
   */
  start(): void {
    for (const t of [...this.store.topics(), ...this.store.topics({ archived: true })]) {
      if (!t.runId || (t.state !== "working" && t.state !== "needs-you")) continue;
      const run = this.runs.get(t.runId);
      if (run?.status === "running") {
        this.follow(run.id, t.id);
        continue;
      }
      const sid = run?.sid ?? run?.sessionId ?? null;
      if (sid && sid !== t.sessionId) this.store.patchTopic(t.id, { sessionId: sid });
      // needs-you from the status line of a turn that ended is still true; one from an approval is not.
      if (t.state === "needs-you" && run && (run.status === "done" || run.status === "stopped")) continue;
      this.setState(t.id, !run || run.status === "error" || run.status === "timeout" || run.status === "interrupted" ? "failed" : "done", run?.error ? clip(run.error, MAX_SUMMARY) : t.summary);
    }
    // A turn the person starts on a topic's session from the chat is part of the topic too.
    this.unwatch = this.runs.watch((news) => {
      if (news.type !== "run" || news.run.agent !== DIRECTOR_ID || news.run.status !== "running" || this.followed.has(news.run.id)) return;
      const topic = (news.run.sessionId ? this.store.topicOfSession(news.run.sessionId) : undefined) ?? this.store.topicOfRun(news.run.id);
      if (!topic) return;
      this.store.patchTopic(topic.id, { runId: news.run.id });
      this.store.touch(topic.id);
      this.follow(news.run.id, topic.id);
      this.refresh(topic.id);
    });
    // A delegation of a topic's session moves the topic's state; a result held at the limit asks the person.
    if (this.opts.delegations) {
      this.offs.push(this.opts.delegations.onChange((d) => {
        const topic = d.from.session ? this.store.topicOfSession(d.from.session) : undefined;
        if (topic) this.refresh(topic.id, d.asking[0] ? `${d.to.title || d.to.role}: ${d.asking[0]}` : undefined);
      }));
      this.offs.push(this.opts.delegations.onHeld((d) => {
        const topic = d.from.session ? this.store.topicOfSession(d.from.session) : undefined;
        if (!topic) return;
        this.lastReportedNeedsYou.add(topic.id);
        this.setState(topic.id, "needs-you", `${d.label} (${d.to.title || d.to.role}) came back after several results in a row; the Director waits for you to look.`);
      }));
    }
    this.kickSort();
    for (const id of this.store.topicsWaiting()) void this.dispatch(id);
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** A topic's delegations now: running, waiting for the person, and under full permission. */
  private delegationActivity(topic: Topic): { running: boolean; waiting: boolean; asking: string[]; full: boolean } {
    return topic.sessionId && this.opts.delegations ? this.opts.delegations.activity(topic.sessionId) : { running: false, waiting: false, asking: [], full: false };
  }

  /**
   * The state of a topic from what runs now: something waits for the person (the Director's run or
   * a delegate), something works (either), or, when nothing runs any more, the end of the work.
   */
  private refresh(topicId: number, asked?: string): void {
    const topic = this.store.topic(topicId);
    if (!topic) return;
    const act = this.delegationActivity(topic);
    const director = this.running(topic);
    const directorAsking = director ? (this.followed.get(director.id)?.asking.size ?? 0) > 0 : false;
    if (directorAsking || act.waiting) this.setState(topicId, "needs-you", undefined, asked ?? act.asking[0]);
    else if (director || act.running) this.setState(topicId, "working");
    else if (topic.state === "working") this.setState(topicId, "done");
    else if (topic.state === "needs-you" && !this.lastReportedNeedsYou.has(topicId)) this.setState(topicId, "done");
  }

  /** Topics whose `needs-you` comes from the Director's own status line (not from an approval that is answered now). */
  private readonly lastReportedNeedsYou = new Set<number>();

  /** Resolves once the sorting queue and every topic's dispatch have settled (tests, shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const sorting = this.sorting;
      await Promise.all([sorting, ...this.locks.values()]);
      await Bun.sleep(0);
      if (sorting === this.sorting && this.locks.size === 0) return;
    }
  }

  // ---------------------------------------------------------------- settings

  settings(): OrdersSettings {
    return this.store.settings();
  }

  setSettings(raw: unknown): OrdersSettings {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OrdersError(400, "body must be { topicDays?, notify? }");
    const b = raw as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => k !== "topicDays" && k !== "notify");
    if (extra.length) throw new OrdersError(400, `unknown setting ${extra.join(", ")}`);
    const patch: Partial<OrdersSettings> = {};
    if (b.topicDays !== undefined) {
      if (typeof b.topicDays !== "number" || !Number.isInteger(b.topicDays) || b.topicDays < MIN_TOPIC_DAYS || b.topicDays > MAX_TOPIC_DAYS) throw new OrdersError(400, `topicDays must be a whole number of days from ${MIN_TOPIC_DAYS} to ${MAX_TOPIC_DAYS}`);
      patch.topicDays = b.topicDays;
    }
    if (b.notify !== undefined) {
      const channels = this.opts.channels?.() ?? [];
      if (typeof b.notify !== "string" || !(b.notify === "off" || b.notify === "default" || channels.includes(b.notify))) throw new OrdersError(400, `notify must be off, default${channels.length ? ` or a channel (${channels.join(", ")})` : ""}`);
      patch.notify = b.notify;
    }
    return this.store.setSettings(patch);
  }

  // ---------------------------------------------------------------- orders in

  /**
   * Take an order. A repeated client id answers the first order and does nothing else. A new one
   * is stored, published as `space/order.issued`, then sorted (or filed under the topic the person
   * named) and handed to the Director; the answer does not wait for either.
   */
  async submit(input: SubmitInput): Promise<{ order: Order; created: boolean }> {
    const clientId = input.clientId ?? crypto.randomUUID();
    if (!UUID.test(clientId)) throw new OrdersError(400, "id must be a UUID, the same on every retry");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new OrdersError(400, input.image ? "a picture needs the words of the order with it" : "text is empty");
    if (text.length > MAX_ORDER_TEXT) throw new OrdersError(413, `text is ${text.length} characters; the limit is ${MAX_ORDER_TEXT}`);
    if (input.via !== undefined && !(ORDER_VIA as readonly string[]).includes(input.via)) throw new OrdersError(400, `via must be one of ${ORDER_VIA.join(", ")}`);
    const repeat = this.store.byClientId(clientId);
    if (repeat) return { order: repeat, created: false };
    if (input.topicId !== undefined && !this.store.topic(input.topicId)) throw new OrdersError(404, `unknown topic ${input.topicId}`);
    let image: NewOrder["image"];
    if (input.image) {
      if (input.image.bytes.byteLength > MAX_IMAGE_BYTES) throw new OrdersError(413, `the picture is ${input.image.bytes.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES}`);
      const mime = sniffImage(input.image.bytes);
      if (!mime) throw new OrdersError(400, "the picture must be a PNG, JPEG, WebP or GIF");
      image = { bytes: input.image.bytes, mime };
    }
    // Published the moment the row exists, so `order.issued` always comes before the order's sorting.
    const { order, created } = await this.store.add({ clientId, text, ...(input.via ? { via: input.via as OrderVia } : {}), ...(image ? { image } : {}) }, (o) => {
      this.publish("order.issued", {
        id: o.id,
        text: clip(o.text, MAX_SUMMARY),
        via: o.via,
        ...(o.imageMime ? { image: { mime: o.imageMime, bytes: o.imageBytes } } : {}),
        createdAt: new Date(o.createdAt).toISOString(),
        url: orderUrl(o.id),
      });
      // Filed by the person before the sorting can see it.
      if (input.topicId !== undefined) this.file(o, this.store.topic(input.topicId)!, false, "person");
    });
    if (!created) return { order, created };
    if (input.topicId !== undefined) void this.dispatch(input.topicId);
    else this.kickSort();
    return { order: this.store.get(order.id) ?? order, created };
  }

  /** The person moves an order to another topic, or to a new one; nothing is started. */
  move(orderId: number, to: { topicId?: number; title?: string }): Order {
    const order = this.store.get(orderId);
    if (!order) throw new OrdersError(404, `unknown order ${orderId}`);
    let topic: Topic | undefined;
    if (to.topicId !== undefined) {
      topic = this.store.topic(to.topicId);
      if (!topic) throw new OrdersError(404, `unknown topic ${to.topicId}`);
    } else {
      const title = to.title?.trim() ?? "";
      if (!title) throw new OrdersError(400, "name the topic, or give the new topic's title");
      topic = this.store.addTopic(clip(title, MAX_TITLE));
      this.setState(topic.id, "done");
    }
    this.file(order, topic, to.topicId === undefined, "person");
    return this.store.get(orderId)!;
  }

  /** Send an order to its topic's Director again (after a failed turn): it waits for the next turn. */
  resend(orderId: number): void {
    const order = this.store.get(orderId);
    if (!order) throw new OrdersError(404, `unknown order ${orderId}`);
    if (order.topicId === null) throw new OrdersError(409, "the order is still being sorted");
    this.store.taken([order.id], null);
    void this.dispatch(order.topicId);
  }

  renameTopic(id: number, patch: { title?: unknown; archived?: unknown }): Topic {
    const topic = this.store.topic(id);
    if (!topic) throw new OrdersError(404, `unknown topic ${id}`);
    const out: Partial<Topic> = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || !patch.title.trim()) throw new OrdersError(400, "title must be a non-empty string");
      out.title = clip(patch.title.trim(), MAX_TITLE);
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== "boolean") throw new OrdersError(400, "archived must be true or false");
      out.archived = patch.archived;
    }
    return this.store.patchTopic(id, out)!;
  }

  // ---------------------------------------------------------------- sorting

  private kickSort(): void {
    this.sorting = this.sorting.then(() => this.sortAll()).catch((e) => this.log(`sorting failed: ${(e as Error).message}`));
  }

  private async sortAll(): Promise<void> {
    for (const order of this.store.unsorted()) {
      const { topic, created, by } = await this.decide(order);
      // Moved by the person while the model was deciding: theirs stands.
      if (this.store.get(order.id)?.topicId !== null) continue;
      this.file(order, topic, created, by);
      // A new topic starts working at once: say so, as for any later change.
      if (created) this.publish("order.state", { topic: { id: topic.id, title: topic.title }, state: "working", order: order.id });
      void this.dispatch(topic.id);
    }
  }

  private file(order: Order, topic: Topic, created: boolean, by: RoutedBy): void {
    this.store.sort(order.id, topic.id, by);
    this.store.touch(topic.id);
    this.publish("order.sorted", { id: order.id, topic: { id: topic.id, title: topic.title, new: created }, by });
  }

  /** The topic for an order: the model's choice among the recent topics, else a new one. */
  private async decide(order: Order): Promise<{ topic: Topic; created: boolean; by: RoutedBy }> {
    const since = this.now() - this.settings().topicDays * 86_400_000;
    const topics = this.store.topics({ since, limit: MAX_CANDIDATES });
    const candidates: Candidate[] = await Promise.all(topics.map(async (t) => ({
      id: t.id,
      title: t.title,
      lastActiveAt: t.lastActiveAt,
      waiting: t.state === "needs-you",
      orders: this.store.ofTopic(t.id).slice(-3).map((o) => o.text),
      messages: await this.recentMessages(t),
    })));
    let answer: string | undefined;
    const ctrl = new AbortController();
    const timeoutMs = this.opts.sortTimeoutMs ?? SORT_TIMEOUT_MS;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      answer = await Promise.race([
        this.opts.decide(sortPrompt({ text: order.text, image: Boolean(order.imagePath) }, candidates, this.now()), SORT_SYSTEM, ctrl.signal),
        new Promise<undefined>((resolve) => ctrl.signal.addEventListener("abort", () => resolve(undefined))),
      ]);
    } catch (e) {
      this.log(`order #${order.id}: the topic call failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const decision = answer === undefined ? undefined : parseDecision(answer, candidates.map((c) => c.id));
    if (decision?.kind === "continue") return { topic: this.store.topic(decision.topicId)!, created: false, by: "model" };
    if (decision?.kind === "new") return { topic: this.store.addTopic(decision.title), created: true, by: "model" };
    this.log(`order #${order.id}: no usable topic decision (${answer === undefined ? "no answer" : JSON.stringify(clip(answer, 120))}); a new topic`);
    return { topic: this.store.addTopic(fallbackTitle(order.text)), created: true, by: "fallback" };
  }

  private async recentMessages(t: Topic): Promise<string[]> {
    if (!t.sessionId || !this.opts.messages) return [];
    try {
      const all = await this.opts.messages(t.sessionId);
      return all.slice(-3).map((m) => `${m.role === "user" ? "person" : "director"}: ${m.role === "user" ? m.text : stripStatus(m.text)}`);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- turns

  /** Hand a topic's waiting orders to the Director, one topic at a time. */
  private dispatch(topicId: number): Promise<void> {
    const prev = this.locks.get(topicId) ?? Promise.resolve();
    const next = prev.then(() => this.deliver(topicId)).catch((e) => this.log(`topic ${topicId}: ${(e as Error).message}`));
    this.locks.set(topicId, next);
    void next.finally(() => {
      if (this.locks.get(topicId) === next) this.locks.delete(topicId);
    });
    return next;
  }

  /** The Director's turn on the topic's session that is running now, if any. */
  private running(topic: Topic): RunInfo | undefined {
    const known = topic.runId ? this.runs.get(topic.runId) : null;
    if (known?.status === "running") return known;
    if (!topic.sessionId) return undefined;
    return this.runs.running().find((r) => r.agent === DIRECTOR_ID && (r.sessionId === topic.sessionId || r.sid === topic.sessionId));
  }

  private async deliver(topicId: number): Promise<void> {
    // Three rounds at most: a turn that ends between the busy answer and the steer is followed by a start.
    for (let round = 0; round < 3; round++) {
      const waiting = this.store.waiting(topicId);
      const topic = this.store.topic(topicId);
      if (!waiting.length || !topic) return;
      const message = turnMessage(waiting);
      const images = await this.images(waiting);
      const run = this.running(topic);
      if (run) {
        try {
          await this.runs.steer(run.id, { message, images });
          this.store.taken(waiting.map((o) => o.id), run.id);
          this.store.touch(topicId);
          this.log(`topic ${topicId}: order${waiting.length > 1 ? "s" : ""} ${waiting.map((o) => `#${o.id}`).join(", ")} added to the running turn`);
          this.setState(topicId, this.followed.get(run.id)?.asking.size ? "needs-you" : "working");
          return;
        } catch (e) {
          if (!(e instanceof RunStateError)) throw e;
          // The runtime cannot take a message now: the orders wait for this turn's end, which dispatches again.
          if (this.runs.get(run.id)?.status === "running") {
            this.follow(run.id, topicId);
            this.log(`topic ${topicId}: the running turn cannot take the order (${e.message}); it waits for the turn's end`);
            return;
          }
          continue; // it ended just now: start the next turn
        }
      }
      const director = this.opts.team.director();
      const permissionMode = PERMISSION_MODE[director.permission];
      // An imported topic's first turn: the old room's conversation goes before the orders, trimmed to what the chat takes.
      const imported = topic.sessionId ? undefined : this.store.transcript(topicId);
      const room = imported && imported.givenAt === null && imported.lines.length ? Math.min(12_000, MAX_TURN_MESSAGE - message.length - 400) : 0;
      const body = {
        message: room >= 1_000 ? `${transcriptPrompt(imported!.source, imported!.lines, room)}\n\n${message}` : message,
        ...(images.length ? { images } : {}),
        ...(topic.sessionId ? { sessionId: topic.sessionId } : director.model ? { model: director.model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        interactive: true,
      };
      const req = Object.assign(new Request(`http://space.local/api/agents/space/${DIRECTOR_AGENT}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: { app: "space", agent: DIRECTOR_AGENT } });
      const res = await this.opts.chat(req);
      if (res.status === 409) {
        // Another turn on the session is running (one the person started in the chat): add to it next round.
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const runId = res.headers.get("x-run-id");
      if (!res.ok || !runId) {
        const text = await res.text().catch(() => "");
        let reason = text;
        try {
          reason = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch { /* plain text */ }
        reason = clip(reason || `HTTP ${res.status}`, MAX_SUMMARY);
        this.log(`topic ${topicId}: the Director's turn did not start: ${reason}`);
        // The orders stay waiting: the next order, or a resend from the page, tries again.
        this.setState(topicId, "failed", `The Director's turn did not start: ${reason}`);
        return;
      }
      await res.body?.cancel().catch(() => {});
      this.store.taken(waiting.map((o) => o.id), runId);
      if (room >= 1_000) this.store.transcriptGiven(topicId);
      this.store.patchTopic(topicId, { runId });
      this.store.touch(topicId);
      this.setState(topicId, "working");
      this.follow(runId, topicId);
      return;
    }
    this.log(`topic ${topicId}: the session stayed busy; the orders wait for its turn's end`);
  }

  /** The waiting orders' screenshots as chat images; one that cannot be read is left out. */
  private async images(orders: Order[]): Promise<ChatImage[]> {
    const out: ChatImage[] = [];
    for (const o of orders) {
      if (!o.imagePath || !o.imageMime || out.length >= 4) continue;
      try {
        const bytes = new Uint8Array(await Bun.file(o.imagePath).arrayBuffer());
        out.push({ name: `order-${o.id}.${o.imageMime.split("/")[1]}`, mediaType: o.imageMime, data: Buffer.from(bytes).toString("base64") });
      } catch (e) {
        this.log(`order #${o.id}: screenshot not read: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** Follow a Director run of a topic: its approvals while it runs, its end. */
  private follow(runId: string, topicId: number): void {
    if (this.followed.has(runId)) return;
    const entry = { topicId, asking: new Map<string, string>() };
    this.followed.set(runId, entry);
    const lines: string[] = [];
    const off = this.runs.subscribe(runId, 0, {
      onEvent: (ev) => {
        lines.push(ev.line);
        const kind = /^\s*\{\s*"type"\s*:\s*"(approval_request|approval_resolved)"/.exec(ev.line)?.[1];
        if (!kind) return;
        let parsed: { id?: unknown; title?: unknown; tool?: unknown; questions?: { question?: unknown }[] };
        try {
          parsed = JSON.parse(ev.line) as typeof parsed;
        } catch {
          return;
        }
        if (typeof parsed.id !== "string") return;
        if (kind === "approval_request") {
          const asked = typeof parsed.questions?.[0]?.question === "string" ? parsed.questions[0].question : typeof parsed.title === "string" ? parsed.title : `Approve ${String(parsed.tool ?? "a step")}`;
          entry.asking.set(parsed.id, clip(String(asked), 200));
          this.setState(entry.topicId, "needs-you", [...entry.asking.values()].pop());
        } else {
          entry.asking.delete(parsed.id);
          if (!entry.asking.size && this.runs.get(runId)?.status === "running") this.refresh(entry.topicId);
        }
      },
      onEnd: (run) => {
        this.followed.delete(runId);
        this.ended(entry.topicId, run, lines);
      },
    });
    if (!off) this.followed.delete(runId);
  }

  /** A Director turn of the topic ended: its session, state and summary; then the orders that waited for it. */
  private ended(topicId: number, run: RunInfo, lines: string[]): void {
    const topic = this.store.topic(topicId);
    if (!topic) return;
    const sid = run.sid ?? run.sessionId;
    if (sid && sid !== topic.sessionId) this.store.patchTopic(topicId, { sessionId: sid });
    // A later turn of the topic took over: its own end decides the state.
    if (topic.runId && topic.runId !== run.id && this.runs.get(topic.runId)?.status === "running") return;
    const text = finalText(lines);
    const reply = stripStatus(text).trim();
    let state: TopicState;
    let summary: string;
    if (run.status === "error" || run.status === "timeout" || run.status === "interrupted") {
      state = "failed";
      summary = clip(run.error || reply || run.status, MAX_SUMMARY);
    } else {
      const reported = parseStatus(text);
      state = run.status === "stopped" ? "done" : reported === "needs-you" ? "needs-you" : reported === "failed" ? "failed" : "done";
      summary = clip(reply, MAX_SUMMARY);
    }
    if (state === "needs-you") this.lastReportedNeedsYou.add(topicId);
    else this.lastReportedNeedsYou.delete(topicId);
    // A delegation of the topic still running keeps it working; one waiting for the person makes it wait.
    const act = this.delegationActivity(this.store.topic(topicId) ?? topic);
    if (act.waiting) state = "needs-you";
    else if (act.running && state === "done") state = "working";
    this.store.touch(topicId);
    this.setState(topicId, state, summary, state === "needs-you" ? lastWords(text) : undefined);
    if (this.store.waiting(topicId).length) void this.dispatch(topicId);
  }

  /** Record a topic's state; a change is published, and a new `needs-you` is notified once. */
  private setState(topicId: number, state: TopicState, summary?: string, asked?: string): void {
    const before = this.store.topic(topicId);
    if (!before) return;
    const changed = before.state !== state;
    const topic = this.store.patchTopic(topicId, { state, ...(summary !== undefined ? { summary } : {}) })!;
    if (!changed) return;
    const last = this.store.ofTopic(topicId).pop();
    this.publish("order.state", { topic: { id: topic.id, title: topic.title }, state, ...(last ? { order: last.id } : {}), ...(topic.summary && state !== "working" ? { summary: clip(topic.summary, MAX_SUMMARY) } : {}) });
    if (state === "needs-you") void this.notifyWaiting(topic, asked ?? summary ?? topic.summary, last);
  }

  private async notifyWaiting(topic: Topic, asked: string, last: Order | undefined): Promise<void> {
    const setting = this.settings().notify;
    if (setting === "off" || !this.opts.notify) return;
    const url = `${this.opts.panelBase ?? ""}${last ? orderUrl(last.id) : `/#orders=${topic.id}`}`;
    try {
      await this.opts.notify({ title: `Waiting for you: ${topic.title}`, text: clip(asked.replace(/\s+/g, " ").trim() || "The Director asks you something.", 300), url, key: `orders:${topic.id}`, ...(setting !== "default" ? { channel: setting } : {}) });
    } catch (e) {
      this.log(`topic ${topic.id}: notification not sent: ${(e as Error).message}`);
    }
  }

  private publish(name: string, data: Record<string, unknown>): void {
    try {
      this.opts.publish?.(name, data);
    } catch (e) {
      this.log(`space/${name} not published: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- views

  /** The number of orders stored and not sorted yet. */
  sortingCount(): number {
    return this.store.unsorted().length;
  }

  /** What a topic's runs wait on now: the Director's approvals and questions, then its delegates'. */
  asking(topic: Topic): string[] {
    const own: string[] = [];
    for (const [, f] of this.followed) if (f.topicId === topic.id) own.push(...f.asking.values());
    return [...own, ...this.delegationActivity(topic).asking];
  }

  /** Whether full permission is in force on a topic: the Director's, or a delegation of it that runs with it. */
  full(topic: Topic): boolean {
    return this.opts.team.director().permission === "full" || this.delegationActivity(topic).full;
  }
}
