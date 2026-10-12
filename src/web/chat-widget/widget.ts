/**
 * The chat widget apps embed: one script, mounted into an element of the
 * app's page, talking to the chat service through the app's own proxy
 * (`/space/chat/*` → ai-space `/api/chat/*`). It renders inside a shadow
 * root so the app's stylesheet and its own never collide, while the
 * `--sc-*` tokens set on the mount element style it. What the model reads
 * before the conversation (the note, the calendar) is the app's business:
 * `opts.context()` is called on every turn and its result travels with the
 * message. Answers arrive as server-sent events and are shown as written.
 *
 * A turn belongs to the thread it was sent in, not to this page: turning to
 * another scope or thread only stops following it, and coming back finds it
 * still running or finished. Only Stop ends it. Everything asynchronous
 * checks `view`, the count of such turns of the widget, before it touches
 * the page, so a late response never lands in a thread it was not asked for.
 */
import css from "./widget.css" with { type: "text" };
import { Drafts, giveBack, isSendKey, type DraftStorage } from "./compose.ts";
import { strings, type Strings } from "./i18n.ts";
import { esc, renderMd } from "./md.ts";
import { followTurn, newRequestId, turnBody, type Attachment, type Context, type Final, type Message, type Thread } from "./turn.ts";

export type { Attachment, Context, Message, Thread };

export type ModelOption = { value: string; runtime: string; tier: string; model: string };
export type ModelsView = {
  options: ModelOption[];
  /** The person's pick for this app's chat, stored in ai-space; null = follow the app and the space. */
  choice: string | null;
  choiceUnavailable?: boolean;
  appModel: string | null;
  defaultModel: string;
  effective: Effective;
  /** What "default" resolves to: the app's model, else the space's. */
  fallback: Effective;
};
type Effective = { value: string; source: "choice" | "app" | "default"; runtime?: string; model?: string };

/** What `context()` is called with: the turn it is for, which stays the same however the page moves on while it runs. */
export type TurnInfo = { scope: string; thread: Thread; signal: AbortSignal };

export type Options = {
  /** The proxy prefix on the app; default `/space/chat`. */
  base?: string;
  /** Which conversations this widget shows: an app-defined key such as `note:12`. */
  scope: string;
  /**
   * What the model reads before the conversation, rebuilt on every turn. Throwing refuses the turn: nothing is sent or
   * stored, the text goes back into the box and the reason is shown. `signal` aborts when the turn is given up meanwhile.
   */
  context?: (turn: TurnInfo) => Context | Promise<Context>;
  model?: string;
  tools?: string[];
  thinking?: number;
  timeoutMs?: number;
  /** Chips above the log; `send: false` only fills the box. */
  presets?: { label: string; prompt: string; send?: boolean }[];
  /**
   * Buttons under every answer; "copy" is built in. `thread` is the answer's own (its `scope` says what it belongs to).
   * The button is disabled until `run` settles; a string it returns is shown as the confirmation, an error it throws as the failure.
   */
  actions?: { label: string; run: (m: Message, thread: Thread) => void | string | Promise<void | string> }[];
  /** Custom rendering of an answer; return nothing for the default Markdown. */
  renderAssistant?: (m: Message) => string | Node | undefined;
  /** After an answer this widget saw finish. An answer that finished while the widget showed something else is in the thread but is not announced. */
  onReply?: (m: Message, thread: Thread) => void;
  onError?: (error: string, m?: Message) => void;
  /** Thread list and new/delete buttons; default on. */
  threads?: boolean;
  /** The model chip under the box, where the person picks the model for this app's chat; default on. */
  modelPicker?: boolean;
  /** Paste, drop and attach images; default on. */
  attachments?: boolean;
  /** Keep the unsent text of each thread, across thread switches and reloads; default on. */
  drafts?: boolean;
  theme?: "light" | "dark" | "auto";
  lang?: string;
  placeholder?: string;
  emptyText?: string;
};

export type Widget = {
  send(text: string, files?: File[]): Promise<void>;
  /** Put text into the box without sending, and focus it. */
  fill(text: string): void;
  newThread(): Promise<Thread>;
  openThread(id: number): Promise<void>;
  setScope(scope: string): Promise<void>;
  setTheme(theme: "light" | "dark" | "auto"): void;
  /** The person's stop: ends the answer being written, which is stored with what arrived. */
  stop(): void;
  destroy(): void;
  readonly scope: string;
  readonly thread: Thread | null;
  readonly messages: Message[];
  /** A turn is being sent or followed. */
  readonly busy: boolean;
};

const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Pending = { id: number | null; file: File; url: string; el: HTMLElement };

/** The turn this widget is sending or following. */
type Turn = {
  view: number;
  thread: Thread;
  /** Drops this widget's connection and tells `context()` to give up; it never stops the turn on the server. */
  aborter: AbortController;
  /** Opens the turn's event stream: the post itself (again with the same request id after a loss), or the thread's running turn. */
  open: (() => Promise<Response>) | null;
  /** Posted by this widget (false: found running in a thread it opened). */
  mine: boolean;
  /** The request has left; before that nothing exists on the server and a stop simply takes the message back. */
  posted: boolean;
  /** The service has said the turn exists. */
  started: boolean;
  stopping: boolean;
  /** What was taken from the box, to give back when the turn never starts; empty for a retry, which takes nothing from it. */
  text: string;
  held: Pending[];
  user?: Message;
  userEl?: HTMLElement;
  assistant: Message;
  el: HTMLElement;
};

function storage(): DraftStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function mount(host: HTMLElement, opts: Options): Widget {
  const t: Strings = strings(opts.lang ?? document.documentElement.lang);
  const base = (opts.base ?? "/space/chat").replace(/\/$/, "");
  let scope = opts.scope;
  let thread: Thread | null = null;
  let messages: Message[] = [];
  let threads: Thread[] = [];
  let pending: Pending[] = [];
  /** Bumped whenever the widget turns to another scope or thread; work started under an older value drops its result. */
  let view = 0;
  let turn: Turn | null = null;
  /** The listing or opening in progress; a send waits for it so it never races the thread it is about to land in. */
  let loading: Promise<void> = Promise.resolve();
  let stick = true;
  let destroyed = false;
  let models: ModelsView | null = null;
  /** The model the app asks for: the mount option, then whatever the last `context()` said. */
  let appModel: string | undefined = opts.model;
  const keepDrafts = opts.drafts !== false;
  const drafts = new Drafts(`space-chat-draft:${base}:`, keepDrafts ? storage() : undefined);
  /** What Retry does for an answer that failed on this page without reaching the store. */
  const retries = new WeakMap<Message, () => void>();

  // ---------------------------------------------------------------- DOM
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  root.appendChild(style);
  const ui = document.createElement("div");
  ui.className = "sc";
  ui.innerHTML = `
    <div class="sc-bar ${opts.threads === false ? "sc-hidden" : ""}">
      <select class="sc-threads" aria-label="${esc(t.threads)}"></select>
      <button class="sc-btn sc-new" type="button">${esc(t.newThread)}</button>
      <button class="sc-btn sc-del" type="button" aria-label="${esc(t.deleteThread)}" title="${esc(t.deleteThread)}">✕</button>
    </div>
    <div class="sc-presets ${opts.presets?.length ? "" : "sc-hidden"}"></div>
    <div class="sc-logwrap">
      <div class="sc-log" role="log" aria-live="polite"></div>
      <button class="sc-bottom sc-hidden" type="button" aria-label="${esc(t.toBottom)}" title="${esc(t.toBottom)}">↓</button>
    </div>
    <form class="sc-composer" autocomplete="off">
      <div class="sc-previews"></div>
      <div class="sc-row">
        <button class="sc-icon sc-attach ${opts.attachments === false ? "sc-hidden" : ""}" type="button" aria-label="${esc(t.attach)}" title="${esc(t.attach)}">＋</button>
        <textarea class="sc-input" rows="2" placeholder="${esc(opts.placeholder ?? t.placeholder)}"></textarea>
        <button class="sc-btn sc-primary sc-send" type="submit">${esc(t.send)}</button>
      </div>
      <input class="sc-file sc-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>
      <div class="sc-meta ${opts.modelPicker === false ? "sc-hidden" : ""}">
        <button class="sc-model-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="${esc(t.modelSettings)}"><span aria-hidden="true">⚙</span> <span class="sc-model-name">${esc(t.model)}</span></button>
        <div class="sc-model-menu sc-hidden" role="listbox" aria-label="${esc(t.modelSettings)}"></div>
      </div>
    </form>`;
  root.appendChild(ui);
  const $ = <T extends HTMLElement>(sel: string): T => ui.querySelector(sel) as T;
  const els = {
    select: $<HTMLSelectElement>(".sc-threads"), newBtn: $<HTMLButtonElement>(".sc-new"), delBtn: $<HTMLButtonElement>(".sc-del"),
    presets: $<HTMLDivElement>(".sc-presets"), log: $<HTMLDivElement>(".sc-log"), bottom: $<HTMLButtonElement>(".sc-bottom"), form: $<HTMLFormElement>(".sc-composer"),
    previews: $<HTMLDivElement>(".sc-previews"), attach: $<HTMLButtonElement>(".sc-attach"), input: $<HTMLTextAreaElement>(".sc-input"),
    send: $<HTMLButtonElement>(".sc-send"), file: $<HTMLInputElement>(".sc-file"),
    modelBtn: $<HTMLButtonElement>(".sc-model-btn"), modelName: $<HTMLSpanElement>(".sc-model-name"), modelMenu: $<HTMLDivElement>(".sc-model-menu"),
  };

  // ---------------------------------------------------------------- theme
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = opts.theme ?? "auto";
  const applyTheme = () => {
    const page = document.documentElement.dataset.theme;
    const dark = theme === "dark" || (theme === "auto" && (page ? page === "dark" : media.matches));
    host.dataset.theme = dark ? "dark" : "light";
  };
  const observer = new MutationObserver(applyTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  media.addEventListener("change", applyTheme);
  applyTheme();

  // ---------------------------------------------------------------- helpers
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${base}${path}`, init);
    const body = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (text: string) => {
    ui.querySelector(".sc-toast")?.remove();
    const el = document.createElement("div");
    el.className = "sc-toast";
    el.textContent = text;
    els.log.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2600);
  };
  const setStick = (on: boolean) => {
    stick = on;
    els.bottom.classList.toggle("sc-hidden", on);
  };
  const scrollDown = () => {
    if (stick) els.log.scrollTop = els.log.scrollHeight;
  };
  els.log.addEventListener("scroll", () => setStick(els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40));
  els.bottom.addEventListener("click", () => {
    setStick(true);
    scrollDown();
  });
  const busy = () => turn !== null;
  const untitled = (th: Thread) => th.title || t.untitled;
  const track = (p: Promise<void>): Promise<void> => {
    loading = p.catch(() => {});
    return p;
  };

  // ---------------------------------------------------------------- drafts
  const stashDraft = () => {
    if (keepDrafts) drafts.set(scope, thread?.id ?? null, els.input.value);
  };
  /** The box takes the text kept for what is shown now, unless the person has already typed into it. */
  const restoreDraft = () => {
    if (!keepDrafts) return;
    if (els.input.value.trim()) stashDraft();
    else els.input.value = drafts.get(scope, thread?.id ?? null);
  };
  els.input.addEventListener("input", stashDraft);

  // ---------------------------------------------------------------- rendering
  const thumbs = (list: Attachment[]): string =>
    list.length ? `<div class="sc-thumbs">${list.map((a) => `<a href="${esc(base + a.url.replace(/^\/api\/chat/, ""))}" target="_blank" rel="noopener"><img src="${esc(base + a.url.replace(/^\/api\/chat/, ""))}" alt="${esc(a.name)}" loading="lazy"></a>`).join("")}</div>` : "";

  /** What Retry does for a failed answer: what this page kept for it, else the question before it asked again. */
  const retryOf = (m: Message): (() => void) | undefined => {
    const local = retries.get(m);
    if (local) return local;
    const asked = messages[messages.indexOf(m) - 1];
    return asked?.role === "user" && asked.content.trim() ? () => void submit(asked.content, undefined, true) : undefined;
  };

  const renderMessage = (m: Message): HTMLElement => {
    const el = document.createElement("div");
    el.className = `sc-msg sc-${m.role}${m.live ? " sc-live" : ""}`;
    el.dataset.id = String(m.id);
    if (m.role === "user") {
      el.innerHTML = `${thumbs(m.attachments)}${esc(m.content)}${m.omitted ? `<div class="sc-note">${esc(t.earlierImages(m.omitted))}</div>` : ""}`;
      return el;
    }
    const md = document.createElement("div");
    md.className = "sc-md";
    md.dataset.wait = t.thinking;
    const custom = !m.live && opts.renderAssistant ? opts.renderAssistant(m) : undefined;
    if (custom === undefined) md.innerHTML = m.content ? renderMd(m.content) : "";
    else if (typeof custom === "string") md.innerHTML = custom;
    else md.appendChild(custom);
    el.appendChild(md);
    if (m.live) {
      const status = document.createElement("div");
      status.className = "sc-status";
      el.appendChild(status);
    }
    if (m.error) {
      const err = document.createElement("div");
      err.className = `sc-err${m.state === "stopped" ? " sc-quiet" : ""}`;
      const label = document.createElement("span");
      label.textContent = m.state === "stopped" ? t.stopped : m.state === "interrupted" ? t.interrupted : `${t.failed}: ${m.error}`;
      err.appendChild(label);
      if (retryOf(m)) {
        const again = document.createElement("button");
        again.type = "button";
        again.className = "sc-retry";
        again.textContent = t.retry;
        again.onclick = () => {
          if (busy()) toast(t.busy);
          else retryOf(m)?.();
        };
        err.appendChild(again);
      }
      el.appendChild(err);
    }
    if (!m.live && m.content && !m.error) {
      const acts = document.createElement("div");
      acts.className = "sc-acts";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = t.copy;
      copy.onclick = () => void navigator.clipboard.writeText(m.content).then(() => toast(t.copied));
      acts.appendChild(copy);
      // The thread the answer is rendered in: a click can only come from this rendering, so it is the answer's own.
      const own = thread;
      for (const a of opts.actions ?? []) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.onclick = () => {
          if (b.disabled || !own) return;
          b.disabled = true;
          void Promise.resolve()
            .then(() => a.run(m, own))
            .then((said) => typeof said === "string" && said && toast(said), (e) => toast((e as Error).message || t.failed))
            .finally(() => (b.disabled = false));
        };
        acts.appendChild(b);
      }
      el.appendChild(acts);
    }
    return el;
  };

  const renderLog = () => {
    els.log.replaceChildren();
    setStick(true);
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "sc-empty";
      empty.textContent = opts.emptyText ?? t.empty;
      els.log.appendChild(empty);
      return;
    }
    for (const m of messages) els.log.appendChild(renderMessage(m));
    scrollDown();
  };

  const renderThreads = () => {
    els.select.replaceChildren();
    for (const th of threads) {
      const o = document.createElement("option");
      o.value = String(th.id);
      o.textContent = untitled(th);
      o.selected = thread?.id === th.id;
      els.select.appendChild(o);
    }
    if (!threads.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = t.newThread;
      els.select.appendChild(o);
    }
    els.delBtn.disabled = busy() || !thread;
  };

  const renderPresets = () => {
    els.presets.replaceChildren();
    for (const p of opts.presets ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = p.label;
      b.onclick = () => {
        if (p.send === false) {
          els.input.value = p.prompt;
          stashDraft();
          els.input.focus();
        } else void send(p.prompt);
      };
      els.presets.appendChild(b);
    }
  };

  const setBusy = () => {
    const on = turn !== null;
    els.send.textContent = !on ? t.send : turn!.stopping ? t.stopping : t.stop;
    els.send.type = on ? "button" : "submit";
    els.send.disabled = on && turn!.stopping;
    els.delBtn.disabled = on || !thread;
  };

  // ---------------------------------------------------------------- attachments
  const clearPending = () => {
    for (const p of pending) URL.revokeObjectURL(p.url);
    pending = [];
    els.previews.replaceChildren();
  };
  const addFiles = async (files: File[]) => {
    if (opts.attachments === false || !files.length) return;
    await loading;
    const my = view;
    for (const file of files) {
      if (my !== view) return;
      if (!IMAGE_TYPES.has(file.type)) { toast(t.notImage); continue; }
      if (file.size > MAX_BYTES) { toast(t.tooBig(Math.round(MAX_BYTES / 1024 / 1024))); continue; }
      if (pending.length >= MAX_FILES) { toast(t.tooMany(MAX_FILES)); break; }
      const el = document.createElement("div");
      el.className = "sc-preview sc-uploading";
      const url = URL.createObjectURL(file);
      el.innerHTML = `<img src="${url}" alt="${esc(file.name)}"><button type="button" aria-label="${esc(t.remove)}">✕</button>`;
      const p: Pending = { id: null, file, url, el };
      el.querySelector("button")!.onclick = () => {
        pending = pending.filter((x) => x !== p);
        URL.revokeObjectURL(url);
        el.remove();
      };
      pending.push(p);
      els.previews.appendChild(el);
      try {
        if (!thread) await newThread(true);
        // An upload belongs to one thread: once the widget has turned away, the preview is already gone with the rest.
        if (my !== view) return;
        const form = new FormData();
        form.set("file", file, file.name);
        const r = await api<{ attachment: Attachment }>(`/threads/${thread!.id}/attachments`, { method: "POST", body: form });
        if (my !== view) return;
        p.id = r.attachment.id;
        el.classList.remove("sc-uploading");
      } catch (e) {
        if (my !== view) return;
        toast(`${t.uploadFailed}: ${(e as Error).message}`);
        pending = pending.filter((x) => x !== p);
        URL.revokeObjectURL(url);
        el.remove();
      }
    }
  };
  els.attach.onclick = () => els.file.click();
  els.file.onchange = () => {
    void addFiles(Array.from(els.file.files ?? []));
    els.file.value = "";
  };
  els.input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  });
  els.form.addEventListener("dragover", (e) => {
    if (opts.attachments === false) return;
    e.preventDefault();
    els.form.classList.add("sc-drop");
  });
  els.form.addEventListener("dragleave", () => els.form.classList.remove("sc-drop"));
  els.form.addEventListener("drop", (e) => {
    els.form.classList.remove("sc-drop");
    if (opts.attachments === false) return;
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  });

  // ---------------------------------------------------------------- turns
  const releaseHeld = (tn: Turn) => {
    for (const p of tn.held) URL.revokeObjectURL(p.url);
    tn.held = [];
  };

  /**
   * A turn that never reached the server: nothing was stored, so the message
   * leaves the log and its text goes back to where it was typed, the box when
   * the widget still shows that thread, the thread's draft when it has turned away.
   */
  const abandon = (tn: Turn, why: "left" | "stopped" | "refused", reason?: string) => {
    if (turn === tn) turn = null;
    tn.aborter.abort();
    const back = (now: string) => giveBack(tn.text, now);
    if (why === "left") {
      if (keepDrafts) drafts.set(tn.thread.scope, tn.thread.id, back(drafts.get(tn.thread.scope, tn.thread.id)));
      else els.input.value = back(els.input.value);
      releaseHeld(tn);
      return;
    }
    messages = messages.filter((m) => m !== tn.user && m !== tn.assistant);
    tn.userEl?.remove();
    tn.el.remove();
    if (!messages.length) renderLog();
    els.input.value = back(els.input.value);
    stashDraft();
    pending = [...tn.held, ...pending];
    els.previews.prepend(...tn.held.map((p) => p.el));
    tn.held = [];
    setBusy();
    if (why === "refused") {
      const error = reason || t.failed;
      toast(`${t.notSent}: ${error}`);
      opts.onError?.(error);
    }
    els.input.focus();
  };

  /** Stop following the turn: one not yet sent is taken back, one on the server carries on there. */
  const detach = () => {
    const tn = turn;
    if (!tn) return;
    if (!tn.posted) return abandon(tn, "left");
    turn = null;
    tn.aborter.abort();
    releaseHeld(tn);
    setBusy();
  };

  /** Before the widget turns to another scope or thread: the box's text stays with the thread it was typed for, uploads and the followed turn are let go. */
  const leave = () => {
    stashDraft();
    // With drafts the box is emptied for whatever comes next; without them it is one box for the whole widget, as it always was.
    if (keepDrafts) els.input.value = "";
    detach();
    clearPending();
    view++;
  };

  /** The turn's result takes the place of what was shown while it ran. */
  const settle = (tn: Turn, f: Final) => {
    if (f.thread) {
      const next = f.thread;
      thread = next;
      threads = threads.map((x) => (x.id === next.id ? next : x));
      renderThreads();
    }
    if (f.user && tn.user) {
      messages[messages.indexOf(tn.user)] = f.user;
      tn.userEl?.replaceWith(renderMessage(f.user));
    }
    // A failure that stored nothing keeps the local answer with the reason.
    const done: Message = f.assistant ?? { ...tn.assistant, live: false, error: f.error ?? t.failed };
    messages[messages.indexOf(tn.assistant)] = done;
    tn.el.replaceWith(renderMessage(done));
    scrollDown();
    if (f.ok) opts.onReply?.(done, thread!);
    else opts.onError?.(f.error ?? t.failed, done);
  };

  /** Read the turn's stream to its end and show what it says, as long as the widget still follows this turn. */
  const follow = async (tn: Turn) => {
    const status = () => tn.el.querySelector<HTMLElement>(".sc-status");
    // Repaints are throttled with a timer, not requestAnimationFrame: a background tab gets no frames, and the answer should be there when the person comes back.
    let painted = false;
    const paint = () => {
      if (painted) return;
      painted = true;
      setTimeout(() => {
        painted = false;
        if (turn !== tn) return;
        tn.el.querySelector(".sc-md")!.innerHTML = renderMd(tn.assistant.content);
        scrollDown();
      }, 40);
    };
    const end = await followTurn(tn.open!, tn.aborter.signal, {
      start: (info) => {
        if (turn !== tn) return;
        tn.started = true;
        const s = status();
        if (s) s.textContent = "";
        tn.assistant.content = "";
        if (info.user && tn.user) {
          messages[messages.indexOf(tn.user)] = info.user;
          const el = renderMessage(info.user);
          tn.userEl?.replaceWith(el);
          tn.user = info.user;
          tn.userEl = el;
          releaseHeld(tn);
        }
      },
      text: (full) => {
        if (turn !== tn) return;
        tn.assistant.content = full;
        paint();
      },
      lost: () => {
        const s = turn === tn ? status() : null;
        if (s) s.textContent = t.reconnecting;
      },
    });
    if (turn !== tn) return;
    if (end.kind === "left") return;
    // Refused before it began (the thread is answering someone else, the message is too long): nothing was stored.
    if (end.kind === "refused" && tn.mine && !tn.started) return abandon(tn, "refused", end.error);
    turn = null;
    setBusy();
    if (end.kind === "final") return settle(tn, end.final);
    // The thread is no longer answering (it finished in between) or cannot say: what it stored is the truth.
    if (end.kind === "refused") return void track(show(tn.thread.id, view)).catch((e) => toast((e as Error).message));
    // Lost for good: the turn may have finished or still be running. Retry asks the service, which knows the turn by its id.
    releaseHeld(tn);
    tn.assistant.live = false;
    tn.assistant.error = t.connectionLost;
    retries.set(tn.assistant, () => {
      if (turn || tn.view !== view) return;
      tn.assistant.live = true;
      delete tn.assistant.error;
      tn.aborter = new AbortController();
      tn.stopping = false;
      const el = renderMessage(tn.assistant);
      tn.el.replaceWith(el);
      tn.el = el;
      turn = tn;
      setBusy();
      void follow(tn);
    });
    const el = renderMessage(tn.assistant);
    tn.el.replaceWith(el);
    tn.el = el;
    scrollDown();
    opts.onError?.(t.connectionLost, tn.assistant);
  };

  /**
   * Send a message in what the widget shows when this is called. That view is fixed here, before the first wait:
   * if the widget turns to another scope or thread while the listing, an upload or the new thread is awaited, the
   * message is not sent anywhere (what was typed is still in the box's draft for where it was typed).
   * `retry` asks an earlier question again: the box and the images waiting in it are the person's next message and stay as they are.
   */
  const submit = async (text: string, files?: File[], retry = false) => {
    if (busy()) { toast(t.busy); return; }
    const my = view;
    await loading;
    if (my !== view) return;
    if (files?.length) await addFiles(files);
    if (my !== view) return;
    if (busy()) { toast(t.busy); return; }
    if (!retry && pending.some((p) => p.id === null)) { toast(t.uploading); return; }
    const message = text.trim();
    if (!message) return;
    if (!thread) {
      try {
        await newThread(true);
      } catch (e) {
        if (my === view) toast((e as Error).message);
        return;
      }
    }
    if (my !== view || !thread || busy()) return;
    const th = thread;
    const held = retry ? [] : pending;
    if (!retry) {
      pending = [];
      els.previews.replaceChildren();
      els.input.value = "";
      stashDraft();
    }
    const attachments = held.map((p) => p.id!);
    const previews = held.map((p) => ({ id: p.id!, name: p.file.name, type: p.file.type, size: p.file.size, url: `/api/chat/attachments/${p.id}` }));

    const user: Message = { id: -1, role: "user", content: message, createdAt: new Date().toISOString(), attachments: previews };
    const assistant: Message = { id: -2, role: "assistant", content: "", createdAt: new Date().toISOString(), attachments: [], live: true };
    if (!messages.length) els.log.replaceChildren();
    messages.push(user, assistant);
    const userEl = renderMessage(user);
    const el = renderMessage(assistant);
    els.log.append(userEl, el);
    setStick(true);
    scrollDown();

    const tn: Turn = { view: my, thread: th, aborter: new AbortController(), open: null, mine: true, posted: false, started: false, stopping: false, text: retry ? "" : message, held, user, userEl, assistant, el };
    turn = tn;
    setBusy();
    let ctx: Context;
    try {
      ctx = opts.context ? await opts.context({ scope: th.scope, thread: th, signal: tn.aborter.signal }) : {};
    } catch (e) {
      // The app could not say what the model should read (a save that failed, a page that moved on): the turn is not sent.
      if (turn === tn) abandon(tn, "refused", (e as Error).message);
      return;
    }
    if (turn !== tn) return;
    const asked = ctx.model ?? opts.model;
    if (asked !== appModel) {
      appModel = asked;
      void loadModels().catch(() => {});
    }
    const body = JSON.stringify(turnBody(message, attachments, newRequestId(), ctx, opts));
    tn.open = () => fetch(`${base}/threads/${th.id}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: tn.aborter.signal });
    tn.posted = true;
    await follow(tn);
    if (my === view && !turn) els.input.focus();
  };
  const send = (text: string, files?: File[]) => submit(text, files);

  /** A thread opened while it answers: show the answer so far and follow the rest. */
  const attach = (th: Thread, text: string) => {
    const assistant: Message = { id: -2, role: "assistant", content: text, createdAt: new Date().toISOString(), attachments: [], live: true };
    messages.push(assistant);
    const el = renderMessage(assistant);
    els.log.querySelector(".sc-empty")?.remove();
    els.log.appendChild(el);
    scrollDown();
    const tn: Turn = { view, thread: th, aborter: new AbortController(), open: null, mine: false, posted: true, started: true, stopping: false, text: "", held: [], assistant, el };
    tn.open = () => fetch(`${base}/threads/${th.id}/turn`, { signal: tn.aborter.signal });
    turn = tn;
    setBusy();
    void follow(tn);
  };

  const stop = () => {
    const tn = turn;
    if (!tn || tn.stopping) return;
    if (!tn.posted) return abandon(tn, "stopped");
    tn.stopping = true;
    setBusy();
    const status = tn.el.querySelector<HTMLElement>(".sc-status");
    if (status) status.textContent = t.stopping;
    const again = () => {
      if (turn !== tn) return;
      tn.stopping = false;
      setBusy();
      if (status) status.textContent = "";
    };
    // The stream says how it ended; a stop that found nothing running (the post had not arrived yet) can be pressed again.
    api<{ stopped: boolean }>(`/threads/${tn.thread.id}/stop`, { method: "POST" }).then(
      (r) => void (r.stopped || again()),
      (e) => {
        again();
        toast(`${t.stopFailed}: ${(e as Error).message}`);
      },
    );
  };

  // ---------------------------------------------------------------- threads
  /** Show a thread, for the view it was asked under; a thread that is answering is followed. */
  const show = async (id: number, my: number) => {
    const r = await api<{ thread: Thread; messages: Message[]; turn?: { text?: string } }>(`/threads/${id}`);
    if (my !== view) return;
    thread = r.thread;
    messages = r.messages;
    renderThreads();
    renderLog();
    restoreDraft();
    setBusy();
    if (r.turn && !turn) attach(r.thread, r.turn.text ?? "");
  };
  const openThread = (id: number) => {
    leave();
    return track(show(id, view));
  };
  /** A new thread: asked for by the person (the widget turns to it), or made for the message or image being added (`implicit`: nothing else changes). */
  const newThread = async (implicit = false): Promise<Thread> => {
    if (!implicit) leave();
    const my = view;
    const r = await api<{ thread: Thread }>("/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });
    if (my !== view) throw new Error("the chat moved on before the new thread was ready");
    if (implicit && keepDrafts) drafts.set(scope, null, "");
    threads = [r.thread, ...threads];
    thread = r.thread;
    messages = [];
    renderThreads();
    renderLog();
    if (implicit) stashDraft();
    else restoreDraft();
    setBusy();
    return r.thread;
  };
  /** List the scope's threads and open the newest. The caller has already left the old view. */
  const load = async () => {
    const my = view;
    thread = null;
    messages = [];
    threads = [];
    renderThreads();
    renderLog();
    setBusy();
    const r = await api<{ threads: Thread[] }>(`/threads?scope=${encodeURIComponent(scope)}`);
    if (my !== view) return;
    threads = r.threads;
    if (threads.length) {
      // Typed before the listing arrived, it was kept for the scope: it is for the thread the scope opens with.
      const early = keepDrafts ? drafts.get(scope, null) : "";
      if (early) {
        drafts.set(scope, null, "");
        if (!els.input.value.trim()) els.input.value = early;
      }
      await show(threads[0]!.id, my);
    } else {
      renderThreads();
      restoreDraft();
    }
  };

  // ---------------------------------------------------------------- model picker
  const concrete = (e: ModelsView["effective"]) => (e.runtime && e.model ? `${e.runtime}/${e.model}` : e.value);
  const renderModels = () => {
    if (!models) return;
    const e = models.effective;
    els.modelName.textContent = concrete(e);
    els.modelBtn.title = `${t.modelSettings} · ${t.modelInUse}: ${concrete(e)} (${t.modelFrom[e.source]})`;
    const menu = els.modelMenu;
    menu.replaceChildren();
    const head = document.createElement("div");
    head.className = "sc-model-head";
    head.textContent = `${t.modelInUse}: ${concrete(e)} · ${t.modelFrom[e.source]}`;
    menu.appendChild(head);
    if (models.choiceUnavailable && models.choice) {
      const warn = document.createElement("div");
      warn.className = "sc-model-warn";
      warn.textContent = t.modelUnavailable(models.choice);
      menu.appendChild(warn);
    }
    const item = (value: string | null, label: string, sub: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sc-model-item";
      b.setAttribute("role", "option");
      const selected = (models!.choice ?? null) === value;
      b.setAttribute("aria-selected", String(selected));
      b.innerHTML = `<span class="sc-model-check">${selected ? "✓" : ""}</span><span class="sc-model-label">${esc(label)}</span><span class="sc-model-sub">${esc(sub)}</span>`;
      b.onclick = () => void chooseModel(value);
      menu.appendChild(b);
    };
    item(null, t.modelDefault, concrete(models.fallback));
    for (const o of models.options) item(o.value, `${o.runtime} · ${t.tiers[o.tier] ?? o.tier}`, o.model);
  };
  const modelQuery = () => (appModel ? `?model=${encodeURIComponent(appModel)}` : "");
  const loadModels = async () => {
    if (opts.modelPicker === false) return;
    models = await api<ModelsView>(`/models${modelQuery()}`);
    renderModels();
  };
  const chooseModel = async (value: string | null) => {
    try {
      models = await api<ModelsView>("/model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: value, ...(appModel ? { appModel } : {}) }) });
      renderModels();
      toggleModels(false);
      toast(`${t.modelSaved}: ${concrete(models.effective)}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const toggleModels = (open = els.modelMenu.classList.contains("sc-hidden")) => {
    els.modelMenu.classList.toggle("sc-hidden", !open);
    els.modelBtn.setAttribute("aria-expanded", String(open));
    if (open) void loadModels().catch((e) => toast((e as Error).message));
  };
  els.modelBtn.addEventListener("click", () => toggleModels());
  // A click anywhere outside the chip and its menu closes it; the shadow root retargets page clicks to the host.
  const closeOutside = (e: Event) => {
    if (els.modelMenu.classList.contains("sc-hidden")) return;
    const path = e.composedPath();
    if (!path.includes(els.modelMenu) && !path.includes(els.modelBtn)) toggleModels(false);
  };
  document.addEventListener("click", closeOutside, true);
  els.modelMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      toggleModels(false);
      els.modelBtn.focus();
    }
  });

  // ---------------------------------------------------------------- wiring
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send(els.input.value);
  });
  els.send.addEventListener("click", (e) => {
    if (busy()) {
      e.preventDefault();
      stop();
    }
  });
  els.input.addEventListener("keydown", (e) => {
    if (isSendKey(e)) {
      e.preventDefault();
      void send(els.input.value);
    } else if (e.key === "Escape" && busy()) stop();
  });
  els.select.addEventListener("change", () => {
    const id = Number(els.select.value);
    if (id) void openThread(id).catch((e) => toast((e as Error).message));
  });
  els.newBtn.addEventListener("click", () => void newThread().catch((e) => toast((e as Error).message)));
  els.delBtn.addEventListener("click", () => {
    if (!thread || busy() || !window.confirm(t.confirmDelete)) return;
    const id = thread.id;
    const my = view;
    void api(`/threads/${id}`, { method: "DELETE" })
      .then(() => {
        if (keepDrafts) drafts.set(scope, id, "");
        if (my !== view) return;
        els.input.value = "";
        leave();
        return track(load());
      })
      .catch((e) => toast((e as Error).message));
  });
  renderPresets();
  void track(load()).catch((e) => toast((e as Error).message));
  void loadModels().catch(() => els.modelName.textContent = t.model);

  return {
    send,
    fill(text) {
      els.input.value = text;
      stashDraft();
      els.input.focus();
      els.input.setSelectionRange(text.length, text.length);
    },
    newThread: () => newThread(),
    openThread,
    setScope(next: string) {
      leave();
      scope = next;
      return track(load());
    },
    setTheme(next) {
      theme = next;
      applyTheme();
    },
    stop,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      leave();
      observer.disconnect();
      document.removeEventListener("click", closeOutside, true);
      media.removeEventListener("change", applyTheme);
      root.replaceChildren();
    },
    get scope() {
      return scope;
    },
    get thread() {
      return thread;
    },
    get messages() {
      return messages;
    },
    get busy() {
      return busy();
    },
  };
}

declare global {
  interface Window {
    SpaceChat: { mount: typeof mount; renderMd: typeof renderMd; esc: typeof esc };
  }
}
window.SpaceChat = { mount, renderMd, esc };
