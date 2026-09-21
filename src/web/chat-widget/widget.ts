/**
 * The chat widget apps embed: one script, mounted into an element of the
 * app's page, talking to the chat service through the app's own proxy
 * (`/space/chat/*` → ai-space `/api/chat/*`). It renders inside a shadow
 * root so the app's stylesheet and its own never collide, while the
 * `--sc-*` tokens set on the mount element style it. What the model reads
 * before the conversation (the note, the calendar) is the app's business:
 * `opts.context()` is called on every turn and its result travels with the
 * message. Answers arrive as server-sent events and are shown as written.
 */
import css from "./widget.css" with { type: "text" };
import { strings, type Strings } from "./i18n.ts";
import { esc, renderMd } from "./md.ts";
import { readSse } from "./sse.ts";

export type Attachment = { id: number; name: string; type: string; size: number; url: string };
export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  error?: string;
  attachments: Attachment[];
  backend?: string;
  costUsd?: number | null;
  model?: string;
  /** Still being written. */
  live?: boolean;
};
export type Thread = { id: number; scope: string; title: string; createdAt: string; updatedAt: string };

export type Context = { system?: string; text?: string; ack?: string; tools?: string[]; model?: string; thinking?: number };

export type Options = {
  /** The proxy prefix on the app; default `/space/chat`. */
  base?: string;
  /** Which conversations this widget shows: an app-defined key such as `note:12`. */
  scope: string;
  /** What the model reads before the conversation, rebuilt on every turn. */
  context?: () => Context | Promise<Context>;
  model?: string;
  tools?: string[];
  thinking?: number;
  timeoutMs?: number;
  /** Chips above the log; `send: false` only fills the box. */
  presets?: { label: string; prompt: string; send?: boolean }[];
  /** Buttons under every answer; "copy" is built in. */
  actions?: { label: string; run: (m: Message, thread: Thread) => void | Promise<void> }[];
  /** Custom rendering of an answer; return nothing for the default Markdown. */
  renderAssistant?: (m: Message) => string | Node | undefined;
  /** After a finished answer. */
  onReply?: (m: Message, thread: Thread) => void;
  onError?: (error: string, m?: Message) => void;
  /** Thread list and new/delete buttons; default on. */
  threads?: boolean;
  /** Paste, drop and attach images; default on. */
  attachments?: boolean;
  theme?: "light" | "dark" | "auto";
  lang?: string;
  placeholder?: string;
  emptyText?: string;
};

export type Widget = {
  send(text: string, files?: File[]): Promise<void>;
  newThread(): Promise<Thread>;
  openThread(id: number): Promise<void>;
  setScope(scope: string): Promise<void>;
  setTheme(theme: "light" | "dark" | "auto"): void;
  stop(): void;
  destroy(): void;
  readonly thread: Thread | null;
  readonly messages: Message[];
};

const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Pending = { id: number | null; file: File; url: string; el: HTMLElement };

function mount(host: HTMLElement, opts: Options): Widget {
  const t: Strings = strings(opts.lang ?? document.documentElement.lang);
  const base = (opts.base ?? "/space/chat").replace(/\/$/, "");
  let scope = opts.scope;
  let thread: Thread | null = null;
  let messages: Message[] = [];
  let threads: Thread[] = [];
  let pending: Pending[] = [];
  let aborter: AbortController | null = null;
  let stick = true;
  let destroyed = false;

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
    <div class="sc-log" role="log" aria-live="polite"></div>
    <form class="sc-composer" autocomplete="off">
      <div class="sc-previews"></div>
      <div class="sc-row">
        <button class="sc-icon sc-attach ${opts.attachments === false ? "sc-hidden" : ""}" type="button" aria-label="${esc(t.attach)}" title="${esc(t.attach)}">＋</button>
        <textarea class="sc-input" rows="2" placeholder="${esc(opts.placeholder ?? t.placeholder)}"></textarea>
        <button class="sc-btn sc-primary sc-send" type="submit">${esc(t.send)}</button>
      </div>
      <input class="sc-file sc-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>
    </form>`;
  root.appendChild(ui);
  const $ = <T extends HTMLElement>(sel: string): T => ui.querySelector(sel) as T;
  const els = {
    select: $<HTMLSelectElement>(".sc-threads"), newBtn: $<HTMLButtonElement>(".sc-new"), delBtn: $<HTMLButtonElement>(".sc-del"),
    presets: $<HTMLDivElement>(".sc-presets"), log: $<HTMLDivElement>(".sc-log"), form: $<HTMLFormElement>(".sc-composer"),
    previews: $<HTMLDivElement>(".sc-previews"), attach: $<HTMLButtonElement>(".sc-attach"), input: $<HTMLTextAreaElement>(".sc-input"),
    send: $<HTMLButtonElement>(".sc-send"), file: $<HTMLInputElement>(".sc-file"),
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
  const scrollDown = () => {
    if (stick) els.log.scrollTop = els.log.scrollHeight;
  };
  els.log.addEventListener("scroll", () => {
    stick = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40;
  });
  const busy = () => aborter !== null;
  const untitled = (th: Thread) => th.title || t.untitled;

  // ---------------------------------------------------------------- rendering
  const thumbs = (list: Attachment[]): string =>
    list.length ? `<div class="sc-thumbs">${list.map((a) => `<a href="${esc(base + a.url.replace(/^\/api\/chat/, ""))}" target="_blank" rel="noopener"><img src="${esc(base + a.url.replace(/^\/api\/chat/, ""))}" alt="${esc(a.name)}" loading="lazy"></a>`).join("")}</div>` : "";

  const renderMessage = (m: Message): HTMLElement => {
    const el = document.createElement("div");
    el.className = `sc-msg sc-${m.role}${m.live ? " sc-live" : ""}`;
    el.dataset.id = String(m.id);
    if (m.role === "user") {
      el.innerHTML = `${thumbs(m.attachments)}${esc(m.content)}`;
      return el;
    }
    const md = document.createElement("div");
    md.className = "sc-md";
    const custom = !m.live && opts.renderAssistant ? opts.renderAssistant(m) : undefined;
    if (custom === undefined) md.innerHTML = m.content ? renderMd(m.content) : m.live ? "" : "";
    else if (typeof custom === "string") md.innerHTML = custom;
    else md.appendChild(custom);
    el.appendChild(md);
    if (m.error) {
      const err = document.createElement("div");
      err.className = "sc-err";
      err.textContent = `${t.failed}: ${m.error}`;
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
      for (const a of opts.actions ?? []) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.onclick = () => void Promise.resolve(a.run(m, thread!)).catch((e) => toast((e as Error).message));
        acts.appendChild(b);
      }
      el.appendChild(acts);
    }
    return el;
  };

  const renderLog = () => {
    els.log.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "sc-empty";
      empty.textContent = opts.emptyText ?? t.empty;
      els.log.appendChild(empty);
      return;
    }
    for (const m of messages) els.log.appendChild(renderMessage(m));
    stick = true;
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
    els.delBtn.disabled = !thread;
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
          els.input.focus();
        } else void send(p.prompt);
      };
      els.presets.appendChild(b);
    }
  };

  // ---------------------------------------------------------------- threads
  const loadThreads = async () => {
    const r = await api<{ threads: Thread[] }>(`/threads?scope=${encodeURIComponent(scope)}`);
    threads = r.threads;
  };
  const openThread = async (id: number) => {
    const r = await api<{ thread: Thread; messages: Message[] }>(`/threads/${id}`);
    thread = r.thread;
    messages = r.messages;
    renderThreads();
    renderLog();
  };
  const newThread = async (): Promise<Thread> => {
    const r = await api<{ thread: Thread }>("/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });
    threads = [r.thread, ...threads];
    thread = r.thread;
    messages = [];
    renderThreads();
    renderLog();
    return r.thread;
  };
  const load = async () => {
    stop();
    thread = null;
    messages = [];
    await loadThreads();
    if (threads.length) await openThread(threads[0]!.id);
    else {
      renderThreads();
      renderLog();
    }
  };

  // ---------------------------------------------------------------- attachments
  const clearPending = () => {
    for (const p of pending) URL.revokeObjectURL(p.url);
    pending = [];
    els.previews.replaceChildren();
  };
  const addFiles = async (files: File[]) => {
    if (opts.attachments === false || !thread && !files.length) return;
    for (const file of files) {
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
        if (!thread) await newThread();
        const form = new FormData();
        form.set("file", file, file.name);
        const r = await api<{ attachment: Attachment }>(`/threads/${thread!.id}/attachments`, { method: "POST", body: form });
        p.id = r.attachment.id;
        el.classList.remove("sc-uploading");
      } catch (e) {
        toast(`${t.uploadFailed}: ${(e as Error).message}`);
        pending = pending.filter((x) => x !== p);
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
  const setBusy = (on: boolean) => {
    els.send.textContent = on ? t.stop : t.send;
    els.send.type = on ? "button" : "submit";
    els.newBtn.disabled = on;
    els.delBtn.disabled = on || !thread;
  };

  const send = async (text: string, files?: File[]) => {
    if (busy()) { toast(t.busy); return; }
    if (files?.length) await addFiles(files);
    if (pending.some((p) => p.id === null)) { toast(t.uploadFailed); return; }
    const message = text.trim();
    if (!message) return;
    if (!thread) await newThread();
    const th = thread!;
    const attachments = pending.map((p) => p.id!);
    const previews = pending.map((p) => ({ id: p.id!, name: p.file.name, type: p.file.type, size: p.file.size, url: `/api/chat/attachments/${p.id}` }));
    clearPending();
    els.input.value = "";

    const user: Message = { id: -1, role: "user", content: message, createdAt: new Date().toISOString(), attachments: previews };
    const assistant: Message = { id: -2, role: "assistant", content: "", createdAt: new Date().toISOString(), attachments: [], live: true };
    if (!messages.length) els.log.replaceChildren();
    messages.push(user, assistant);
    els.log.appendChild(renderMessage(user));
    const liveEl = renderMessage(assistant);
    els.log.appendChild(liveEl);
    stick = true;
    scrollDown();

    aborter = new AbortController();
    setBusy(true);
    let painted = false;
    const paint = () => {
      if (painted) return;
      painted = true;
      requestAnimationFrame(() => {
        painted = false;
        liveEl.querySelector(".sc-md")!.innerHTML = renderMd(assistant.content);
        scrollDown();
      });
    };
    let final: { ok: boolean; error?: string; user?: Message; assistant?: Message; thread?: Thread } | null = null;
    try {
      const ctx = opts.context ? await opts.context() : {};
      const body = {
        message, attachments,
        context: { ...(ctx.system ? { system: ctx.system } : {}), ...(ctx.text !== undefined ? { text: ctx.text } : {}), ...(ctx.ack ? { ack: ctx.ack } : {}) },
        ...((ctx.model ?? opts.model) ? { model: ctx.model ?? opts.model } : {}),
        ...((ctx.tools ?? opts.tools)?.length ? { tools: ctx.tools ?? opts.tools } : {}),
        ...((ctx.thinking ?? opts.thinking) !== undefined ? { thinking: ctx.thinking ?? opts.thinking } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      };
      const res = await fetch(`${base}/threads/${th.id}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: aborter.signal });
      if (!res.ok || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      for await (const ev of readSse(res.body!)) {
        if (ev.event === "delta") {
          assistant.content += (JSON.parse(ev.data) as { text: string }).text;
          paint();
        } else if (ev.event === "done" || ev.event === "error") final = JSON.parse(ev.data);
      }
      if (!final) throw new Error(aborter.signal.aborted ? "stopped" : "the stream ended without an answer");
    } catch (e) {
      final = { ok: false, error: aborter?.signal.aborted ? "stopped" : (e as Error).message };
    } finally {
      aborter = null;
      setBusy(false);
    }
    // The stored rows replace the optimistic ones; a failure that never reached the server keeps the local ones with the reason.
    const f = final!;
    const idx = messages.indexOf(user);
    if (f.user && f.assistant) messages.splice(idx, 2, f.user, f.assistant);
    else {
      assistant.live = false;
      assistant.error = f.error ?? t.failed;
    }
    if (f.thread) {
      thread = f.thread;
      threads = threads.map((x) => (x.id === f.thread!.id ? f.thread! : x));
      renderThreads();
    }
    const doneMsg = messages[idx + 1]!;
    liveEl.replaceWith(renderMessage(doneMsg));
    els.log.querySelector(`[data-id="-1"]`)?.replaceWith(renderMessage(messages[idx]!));
    scrollDown();
    if (f.ok) opts.onReply?.(doneMsg, thread!);
    else opts.onError?.(f.error ?? t.failed, doneMsg);
    els.input.focus();
  };

  const stop = () => {
    aborter?.abort();
  };

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
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send(els.input.value);
    } else if (e.key === "Escape" && busy()) stop();
  });
  els.select.addEventListener("change", () => {
    const id = Number(els.select.value);
    if (id) void openThread(id);
  });
  els.newBtn.addEventListener("click", () => void newThread());
  els.delBtn.addEventListener("click", () => {
    if (!thread || busy() || !window.confirm(t.confirmDelete)) return;
    const id = thread.id;
    void api(`/threads/${id}`, { method: "DELETE" }).then(load).catch((e) => toast((e as Error).message));
  });
  renderPresets();
  renderThreads();
  renderLog();
  void load().catch((e) => toast((e as Error).message));

  return {
    send,
    newThread,
    openThread,
    async setScope(next: string) {
      scope = next;
      clearPending();
      await load();
    },
    setTheme(next) {
      theme = next;
      applyTheme();
    },
    stop,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      observer.disconnect();
      media.removeEventListener("change", applyTheme);
      clearPending();
      root.replaceChildren();
    },
    get thread() {
      return thread;
    },
    get messages() {
      return messages;
    },
  };
}

declare global {
  interface Window {
    SpaceChat: { mount: typeof mount; renderMd: typeof renderMd; esc: typeof esc };
  }
}
window.SpaceChat = { mount, renderMd, esc };
