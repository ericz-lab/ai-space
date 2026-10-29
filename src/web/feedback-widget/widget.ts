import { base64Of, clampPosition, describe, pageTheme, type Picked } from "./capture.ts";
import { type Key, type Lang, pageLang, tr } from "./i18n.ts";
import css from "./widget.css";

/**
 * The feedback button an app page loads with `/_space/feedback.js` (docs/feedback.md#the-button).
 * It asks `/_space/feedback/config` whether this app shows it; off, it adds nothing to the page.
 * On, it draws one small button in its own closed shadow root, bottom right, which the person can
 * drag (the spot is kept per app); a click or Alt+Shift+F opens a card: a sentence, picked
 * elements, a screenshot or a picture, "fix now" or "fix later", the machine the fix runs on (when
 * the space has peers), and the page's context shown in
 * one grey line. Everything is sent to `/_space/feedback` on the page's own origin; the router
 * names the app. Colours and language follow the page.
 */

type Config = {
  ok: boolean;
  enabled: boolean;
  mode?: "auto" | "later";
  errors?: boolean;
  app?: { name: string; title: string; zh: string };
  client?: { kind: string; en: string; zh: string };
  shortcut?: string;
  /** Where the fix may run, sent only when the space has peers: "" is the space itself. */
  machine?: string;
  machines?: { value: string; label: string }[];
};
type Recent = { id: number; text: string; status: string; todoId: number | null; todoUrl: string | null };
type Image = { name: string; type: string; data: string; bytes: number };

const BASE = "/_space/feedback";
const MAX_IMAGE = 3 * 1024 * 1024;

const ICONS = {
  // A speech bubble with a small wrench.
  fab: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.3A7.5 7.5 0 1 1 20 11.5Z"/><path d="M13.6 9.1a1.9 1.9 0 0 0-2.5 2.5l-2 2 .9.9 2-2a1.9 1.9 0 0 0 2.5-2.5l-1 1-.9-.9 1-1Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
  shot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4Z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  attach: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11.5-7.6 7.6a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.3-7.3"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "html") e.innerHTML = String(v); // only the static icons above
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k !== null && k !== false) e.append(k);
  return e;
}

function start(): void {
  const w = window as Window & { __spaceFeedback?: boolean };
  if (w.__spaceFeedback || window.top !== window) return;
  w.__spaceFeedback = true;

  // Script errors from now on, kept until the person sends (only when Settings lets them go).
  const errors: string[] = [];
  const keep = (s: string) => {
    errors.push(s.slice(0, 300));
    if (errors.length > 10) errors.shift();
  };
  window.addEventListener("error", (e) => {
    if (e.message) keep(`${e.message}${e.filename ? ` (${e.filename.replace(location.origin, "")}:${e.lineno})` : ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string } | string | undefined;
    keep(`Unhandled rejection: ${typeof r === "string" ? r : r?.message ?? String(r)}`);
  });

  fetch(`${BASE}/config`, { credentials: "same-origin", headers: { accept: "application/json" } })
    .then((r) => (r.ok ? (r.json() as Promise<Config>) : null))
    .then((cfg) => {
      if (cfg?.ok && cfg.enabled && cfg.app) mount(cfg, errors);
    })
    .catch(() => {
      /* no router, an older Space or the page's own rules: no button */
    });
}

function mount(cfg: Config, errors: string[]): void {
  const app = cfg.app!;
  const POS_KEY = `space-feedback.pos.${app.name}`;
  const HIDE_KEY = `space-feedback.hidden.${app.name}`;
  const MACHINE_KEY = `space-feedback.machine.${app.name}`;
  const store = {
    get: (s: Storage | undefined, k: string) => {
      try { return s?.getItem(k) ?? null; } catch { return null; }
    },
    set: (s: Storage | undefined, k: string, v: string | null) => {
      try { if (v === null) s?.removeItem(k); else s?.setItem(k, v); } catch { /* blocked */ }
    },
  };
  const local = (() => { try { return window.localStorage; } catch { return undefined; } })();
  const session = (() => { try { return window.sessionStorage; } catch { return undefined; } })();

  const host = document.createElement("space-feedback");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483000; inset: 0; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.append(el("style", {}, css));
  const root = el("div", { class: "root" });
  shadow.append(root);
  (document.body ?? document.documentElement).append(host);

  let lang: Lang = pageLang(document);
  const t = (k: Key, vars?: Record<string, string | number>) => tr(lang, k, vars);
  const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const narrow = () => window.innerWidth <= 520;

  // ---- state
  let open = false;
  let picking = false;
  let sending = false;
  let mode: "now" | "later" = cfg.mode === "later" ? "later" : "now";
  let picked: Picked[] = [];
  let images: Image[] = [];
  let message: { text: string; ok?: boolean } | null = null;
  let sent: { todoId: number | null; todoUrl: string | null; later: boolean } | null = null;
  let recent: Recent[] = [];
  let hidden = store.get(session, HIDE_KEY) === "1";
  // The machine the fix runs on: the last one picked for this app while the space still has it, else the space's default.
  const machines = cfg.machines && cfg.machines.length > 1 ? cfg.machines : [];
  let machine: string | null = machines.length
    ? (() => {
        const kept = store.get(local, MACHINE_KEY);
        return kept !== null && machines.some((m) => m.value === kept) ? kept : cfg.machine ?? "";
      })()
    : null;

  // ---- the button
  const fab = el("button", { class: "fab", type: "button", html: ICONS.fab });
  root.append(fab);
  const size = () => (coarse() ? 44 : 36);
  const margin = () => (coarse() ? 20 : 16);
  let pos = (() => {
    try {
      const p = JSON.parse(store.get(local, POS_KEY) ?? "null") as { right?: number; bottom?: number } | null;
      if (p && typeof p.right === "number" && typeof p.bottom === "number") return { right: p.right, bottom: p.bottom };
    } catch { /* default */ }
    return null;
  })();
  const place = () => {
    const p = clampPosition(pos ?? { right: margin(), bottom: margin() }, size(), window.innerWidth, window.innerHeight);
    fab.style.right = `${p.right}px`;
    fab.style.bottom = pos ? `${p.bottom}px` : `calc(${p.bottom}px + env(safe-area-inset-bottom))`;
    return p;
  };

  // Drag: a press that moves more than 4 px moves the button; a press that does not is a click.
  let drag: { x: number; y: number; right: number; bottom: number; moved: boolean; id: number } | null = null;
  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = place();
    drag = { x: e.clientX, y: e.clientY, right: p.right, bottom: p.bottom, moved: false, id: e.pointerId };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    fab.classList.add("dragging");
    pos = clampPosition({ right: drag.right - dx, bottom: drag.bottom - dy }, size(), window.innerWidth, window.innerHeight);
    place();
    if (open) placeCard();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    fab.classList.remove("dragging");
    if (moved) store.set(local, POS_KEY, JSON.stringify(pos));
    else toggle();
  };
  fab.addEventListener("pointerup", endDrag);
  fab.addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.id) { drag = null; fab.classList.remove("dragging"); } });
  fab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
  // Double-click puts it back in its corner.
  fab.addEventListener("dblclick", () => { pos = null; store.set(local, POS_KEY, null); place(); });

  // Quiet while the page scrolls.
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("scroll", () => {
    if (open) return;
    fab.classList.add("dim");
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => fab.classList.remove("dim"), 600);
  }, { passive: true, capture: true });

  // ---- the card
  const card = el("div", { class: "card", role: "dialog", "aria-modal": "false" });
  root.append(card);
  const textarea = el("textarea", { rows: 3, maxlength: 4000 });
  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });

  const canCapture = () => !coarse() && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function";

  /** The grey footer: app and theme on one line, page and client on the next. */
  const contextFoot = () => {
    const theme = pageTheme(document, window);
    const client = cfg.client ? (lang === "zh" ? cfg.client.zh : cfg.client.en) : "";
    const page = `${location.pathname}${location.search}`;
    const meta = el(
      "ul",
      { class: "meta" },
      el("li", {}, lang === "zh" ? app.zh : app.title),
      el("li", {}, t(theme)),
      el("li", { title: page }, page.length > 60 ? `${page.slice(0, 59)}…` : page),
      el("li", {}, client),
    );
    return el("div", { class: "foot" }, meta, el("button", { class: "link", type: "button", onclick: () => hideHere() }, t("hide")));
  };

  const placeCard = () => {
    root.classList.toggle("sheet", narrow());
    if (narrow()) { card.style.cssText = ""; return; }
    const p = place();
    const s = size();
    const cw = Math.min(320, window.innerWidth - 16);
    const ch = card.offsetHeight || 300;
    // Above the button when there is room, else below; aligned to the button's side.
    const btnTop = window.innerHeight - p.bottom - s;
    const above = btnTop - 8 >= ch + 8;
    const top = above ? btnTop - 8 - ch : Math.min(window.innerHeight - ch - 8, window.innerHeight - p.bottom + 8);
    let left = window.innerWidth - p.right - cw;
    left = Math.max(8, Math.min(window.innerWidth - cw - 8, left));
    card.style.cssText = `left:${left}px; top:${Math.max(8, top)}px;`;
  };

  const render = () => {
    const hadFocus = shadow.activeElement === textarea;
    root.dataset.theme = pageTheme(document, window);
    root.classList.toggle("coarse", coarse());
    fab.setAttribute("aria-label", t("button"));
    fab.title = t("button");
    fab.setAttribute("aria-expanded", String(open));
    fab.classList.toggle("open", open);
    fab.hidden = (hidden && !open) || picking || !!document.fullscreenElement;
    card.hidden = !open || picking;
    card.setAttribute("aria-label", t("title"));
    card.replaceChildren();
    renderPick();
    if (!open || picking) return;
    textarea.placeholder = t("placeholder");
    textarea.setAttribute("aria-label", t("placeholder"));
    const head = el("div", { class: "head" }, el("b", {}, t("title")), el("button", { class: "icon-btn", type: "button", "aria-label": t("close"), title: t("close"), html: ICONS.close, onclick: () => close() }));
    const body = el("div", { class: "body" });
    if (sent) {
      const label = sent.todoId ? t("saved", { n: sent.todoId }) : t("savedPlain");
      body.append(
        el("p", { class: "note", role: "status" }, el("span", { class: "ok", html: ICONS.check }), el("span", {}, `${label} · ${t(sent.later ? "fixLater" : "fixingNow")}`), sent.todoUrl ? el("a", { class: "link", href: sent.todoUrl, target: "_blank", rel: "noopener" }, t("open")) : null),
      );
      renderRecent(body);
      card.append(head, body, contextFoot());
      placeCard();
      return;
    }
    const tool = (icon: string, label: string, onclick: () => void) => {
      const b = el("button", { class: "ghost", type: "button", html: icon, onclick });
      b.append(label);
      return b;
    };
    const tools = el(
      "div",
      { class: "tools" },
      tool(ICONS.pick, t("pick"), () => startPick()),
      canCapture() ? tool(ICONS.shot, t("shot"), () => void screenshot()) : null,
      tool(ICONS.attach, t("attach"), () => file.click()),
    );
    const chips = el("div", { class: "chips" });
    picked.forEach((p, i) => chips.append(chip(p.selector, () => { picked.splice(i, 1); render(); })));
    images.forEach((img, i) => chips.append(chip(`${img.name} · ${Math.max(1, Math.round(img.bytes / 1024))} KB`, () => { images.splice(i, 1); render(); })));
    const seg = el(
      "div",
      { class: "seg", role: "group", "aria-label": t("mode") },
      el("button", { type: "button", "aria-pressed": String(mode === "now"), onclick: () => { mode = "now"; render(); } }, t("now")),
      el("button", { type: "button", "aria-pressed": String(mode === "later"), onclick: () => { mode = "later"; render(); } }, t("later")),
    );
    const where = machine === null
      ? null
      : (() => {
          const select = el("select", { "aria-label": t("machine"), onchange: (e: Event) => { machine = (e.target as HTMLSelectElement).value; store.set(local, MACHINE_KEY, machine); } });
          for (const m of machines) {
            const o = el("option", { value: m.value }, m.value ? m.label : t("thisMachine", { name: m.label }));
            o.selected = m.value === machine;
            select.append(o);
          }
          return el("label", { class: "machine" }, el("span", {}, t("machine")), select);
        })();
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const send = el("button", { class: "primary", type: "button", disabled: sending, onclick: () => void submit() }, sending ? t("sending") : t("send"));
    const parts: (Node | null)[] = [
      textarea,
      tools,
      file,
      picked.length || images.length ? chips : null,
      seg,
      where,
      el("div", { class: "send-row" }, coarse() ? null : el("kbd", {}, isMac ? "⌘ Enter" : "Ctrl+Enter"), send),
      message ? el("p", { class: `note${message.ok ? "" : " err"}`, role: message.ok ? "status" : "alert" }, message.text) : null,
    ];
    body.append(...parts.filter((p): p is Node => p !== null));
    renderRecent(body);
    card.append(head, body, contextFoot());
    placeCard();
    if (hadFocus) textarea.focus();
  };

  const chip = (label: string, remove: () => void) =>
    el("span", { class: "chip", title: label }, el("span", {}, label), el("button", { class: "icon-btn", type: "button", "aria-label": t("remove", { name: label }), html: ICONS.x, onclick: remove }));

  const renderRecent = (into: HTMLElement) => {
    const items = recent.slice(0, 3);
    if (!items.length) return;
    const list = el("ul", { class: "recent" });
    for (const r of items) {
      const kids = [el("span", { class: "recent-id" }, r.todoId ? `#${r.todoId}` : "·"), el("span", { class: "recent-t", title: r.text }, r.text), el("span", { class: "badge", "data-s": r.status }, t(`status.${r.status}` as Key))];
      list.append(el("li", {}, r.todoUrl ? el("a", { class: "recent-row", href: r.todoUrl, target: "_blank", rel: "noopener" }, ...kids) : el("div", { class: "recent-row" }, ...kids)));
    }
    into.append(el("p", { class: "recent-h" }, t("recent")), list);
  };

  // ---- picking
  const bar = el("div", { class: "pickbar", role: "status" });
  const outline = el("div", { class: "outline" });
  const tag = el("div", { class: "tag" });
  root.append(bar, outline, tag);
  let hover: Element | null = null;
  const renderPick = () => {
    bar.hidden = outline.hidden = tag.hidden = !picking;
    if (!picking) return;
    bar.replaceChildren(
      el("span", {}, coarse() ? t("pickTap") : t("pickClick")),
      coarse() ? el("button", { type: "button", onclick: () => stopPick() }, t("cancel")) : el("span", {}, el("kbd", {}, "Esc"), t("toCancel")),
    );
    if (!hover) { outline.hidden = tag.hidden = true; return; }
    const r = hover.getBoundingClientRect();
    outline.style.cssText = `left:${r.left - 2}px; top:${r.top - 2}px; width:${r.width + 4}px; height:${r.height + 4}px;`;
    const d = describe(hover);
    tag.textContent = d.selector;
    tag.style.cssText = `left:${Math.max(4, r.left)}px; top:${r.top > 64 ? r.top - 28 : r.bottom + 6}px;`;
  };
  const target = (x: number, y: number): Element | null => {
    const e = document.elementFromPoint(x, y);
    return e && e !== host && !host.contains(e) && e !== document.documentElement && e !== document.body ? e : null;
  };
  const onMove = (e: PointerEvent) => { hover = target(e.clientX, e.clientY); renderPick(); };
  const block = (e: Event) => {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e: MouseEvent) => {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    const hit = target(e.clientX, e.clientY);
    if (!hit) return;
    if (picked.length >= 5) message = { text: t("maxElements") };
    else picked.push(describe(hit));
    stopPick();
  };
  const startPick = () => {
    picking = true;
    hover = null;
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onClick, true);
    for (const ev of ["pointerdown", "mousedown", "mouseup", "pointerup", "touchstart", "touchend", "submit"]) document.addEventListener(ev, block, true);
    render();
  };
  const stopPick = () => {
    picking = false;
    hover = null;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("click", onClick, true);
    for (const ev of ["pointerdown", "mousedown", "mouseup", "pointerup", "touchstart", "touchend", "submit"]) document.removeEventListener(ev, block, true);
    render();
    textarea.focus();
  };

  // ---- pictures
  const addImage = (blob: Blob, name: string) => {
    if (images.length >= 2) { message = { text: t("maxImages") }; render(); return; }
    if (blob.size > MAX_IMAGE) { message = { text: t("imageTooLarge") }; render(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const { data, bytes } = base64Of(String(reader.result));
      images.push({ name, type: blob.type, data, bytes });
      message = null;
      render();
    };
    reader.readAsDataURL(blob);
  };
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (f) addImage(f, f.name);
    file.value = "";
  });
  textarea.addEventListener("paste", (e) => {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.kind === "file" && /^image\//.test(item.type)) {
        const f = item.getAsFile();
        if (f) { e.preventDefault(); addImage(f, f.name || "pasted.png"); }
      }
    }
  });
  /** One frame of this tab (the browser asks which surface to share), with the card out of the way. */
  const screenshot = async () => {
    let stream: MediaStream | undefined;
    root.style.visibility = "hidden";
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" } as DisplayMediaStreamOptions);
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 250));
      const scale = Math.min(1, 1600 / (video.videoWidth || 1600));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round((video.videoWidth || 1) * scale);
      canvas.height = Math.round((video.videoHeight || 1) * scale);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      const blob = png && png.size <= MAX_IMAGE ? png : await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      if (blob) addImage(blob, `screenshot.${blob.type === "image/png" ? "png" : "jpg"}`);
    } catch {
      message = { text: t("shotCancelled") };
    } finally {
      stream?.getTracks().forEach((tr) => tr.stop());
      root.style.visibility = "";
      render();
    }
  };

  // ---- open, close, hide
  const loadRecent = () =>
    fetch(`${BASE}/recent`, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ items?: Recent[] }>) : null))
      .then((d) => { recent = d?.items ?? []; if (open) render(); })
      .catch(() => {});
  const openCard = () => {
    open = true;
    hidden = false;
    store.set(session, HIDE_KEY, null);
    sent = null;
    render();
    void loadRecent();
    textarea.focus();
  };
  const close = () => {
    open = false;
    if (picking) stopPick();
    render();
    fab.focus();
  };
  const toggle = () => (open ? close() : openCard());
  const hideHere = () => {
    hidden = true;
    store.set(session, HIDE_KEY, "1");
    close();
  };

  // ---- send
  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) { message = { text: t("empty") }; render(); textarea.focus(); return; }
    sending = true;
    message = null;
    render();
    const vp = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    const body = {
      text,
      mode,
      ...(machine !== null ? { machine } : {}),
      context: {
        url: location.href,
        title: document.title,
        viewport: vp,
        touch: coarse(),
        theme: pageTheme(document, window),
        lang: document.documentElement.lang || lang,
        elements: picked,
        errors: cfg.errors ? errors.slice() : [],
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      images: images.map((i) => ({ name: i.name, type: i.type, data: i.data })),
    };
    try {
      const r = await fetch(BASE, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; todoId?: number | null; todoUrl?: string | null; status?: string };
      if (!r.ok || !d.ok) {
        message = { text: r.status === 403 ? t("errOff") : r.status === 413 ? t("errTooLarge") : r.status === 429 ? t("errTooMany") : t("errGeneric", { msg: d.error ?? `HTTP ${r.status}` }) };
        return;
      }
      sent = { todoId: d.todoId ?? null, todoUrl: d.todoUrl ?? null, later: d.status === "later" };
      textarea.value = "";
      picked = [];
      images = [];
      void loadRecent();
      setTimeout(() => { if (sent && open) close(); }, 4000);
    } catch {
      message = { text: t("errNetwork") };
    } finally {
      sending = false;
      render();
    }
  };
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void submit(); }
  });

  // ---- keys: Alt+Shift+F anywhere (by the physical key, so a Mac's Option layer does not matter); Esc closes.
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyF" && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
      return;
    }
    if (e.key === "Escape" && (open || picking) && !e.isComposing) {
      e.preventDefault();
      if (picking) stopPick();
      else close();
    }
  }, true);

  // ---- follow the page: theme, language, size, full screen
  let seen = "";
  const refresh = () => {
    lang = pageLang(document);
    const now = `${lang}|${pageTheme(document, window)}|${Boolean(document.fullscreenElement)}`;
    if (now === seen) return;
    seen = now;
    place();
    render();
  };
  const watch = new MutationObserver(refresh);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "data-theme", "class", "data-color-scheme", "data-mode"] });
  if (document.body) watch.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "class"] });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", refresh);
  window.addEventListener("resize", () => { place(); if (open) placeCard(); });
  document.addEventListener("fullscreenchange", refresh);

  place();
  refresh();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
