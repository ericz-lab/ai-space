import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type BlockAction, type CardAction, isImgIcon, relTime, type WidgetBlock, type WidgetInfo } from "./api.ts";
import { type Key, localized, useLang, withLang } from "./i18n.ts";
import { useAccentParam, withAccent } from "./theme.ts";
import { type BlockCtx, Blocks, type Flash, isOutdated, txt } from "./WidgetBlocks.tsx";
import { blockChanges, loadView, postWidget, saveView } from "./widget-interact.ts";

// The panel's building blocks: app and agent tiles with their hover pop-over, and widget cards.

export const STATUS: Record<string, Key> = { active: "status.active", paused: "status.paused", archived: "status.archived" };
export const HEALTH: Record<string, Key | undefined> = { ok: "status.up", down: "status.down", unknown: undefined };

export type DragProps = Partial<Record<"draggable" | "onDragStart" | "onDragOver" | "onDragEnd" | "data-drop", unknown>> | undefined;

export function Icon({ icon, fallback }: { icon: string; fallback: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? fallback : icon || fallback}</>;
}

export function Tile({
  icon,
  fallback,
  name,
  href,
  editing,
  onRemove,
  removeTitle,
  onOpen,
  onUse,
  showPop = true,
  dragProps,
  stale,
  corner,
  badge,
  className,
  children,
}: {
  icon: string;
  fallback: string;
  name: string;
  href?: string;
  editing: boolean;
  onRemove?: () => void;
  removeTitle?: string;
  onOpen?: () => void;
  /** Told on every open outside edit mode, link or not (the usage beacon); never delays the open. */
  onUse?: () => void;
  showPop?: boolean;
  dragProps?: DragProps;
  /** The peer is not answering: the entry is its last known state. */
  stale?: boolean;
  /** A small icon over the icon's bottom-right corner: the app an agent belongs to. */
  corner?: string;
  /** A count over the icon's top-right corner (the inbox's unread threads); hidden when empty. */
  badge?: { n: number; title: string };
  className?: string;
  children?: ReactNode;
}) {
  // onOpen wins over href: agent tiles open the chat window; links move into the pop-over.
  const asLink = !!href && !editing && !onOpen;
  // Hide the pop-over once the tile is clicked (a pure :hover would keep it while the pointer rests there).
  const [popHidden, setPopHidden] = useState(false);
  const inner = (
    <>
      {editing && onRemove && (
        <button
          className="tile-del"
          title={removeTitle}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      )}
      <span className={`tile-icon ${isImgIcon(icon) ? "" : "solid"}`}>
        <Icon icon={icon} fallback={fallback} />
        {corner && (
          <span className={`tile-corner ${isImgIcon(corner) ? "" : "solid"}`}>
            <Icon icon={corner} fallback="📦" />
          </span>
        )}
        {badge && badge.n > 0 && (
          <span className="tile-badge" title={badge.title}>
            {badge.n > 99 ? "99+" : badge.n}
          </span>
        )}
      </span>
      <span className="tile-name">{name}</span>
      {!editing && !popHidden && showPop && <div className="pop">{children}</div>}
    </>
  );
  const activate = () => {
    setPopHidden(true);
    if (!editing) onUse?.();
    if (!editing && onOpen) onOpen();
  };
  const common = {
    className: `tile${stale ? " stale" : ""}${className ? ` ${className}` : ""}`,
    ...(dragProps as object),
    onMouseLeave: () => setPopHidden(false),
    onClick: activate,
  };
  if (asLink)
    return (
      <a {...common} href={href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  // A tile that opens a window is a button: it holds the remove button and the pop-over's links, so
  // it cannot be a <button> and takes the role, the tab stop and the keys instead. In edit mode a
  // click does nothing, so only the remove button stays in the tab order.
  const asButton = !editing && !!onOpen;
  return (
    <div
      {...common}
      {...(asButton && {
        role: "button",
        tabIndex: 0,
        "aria-label": badge && badge.n > 0 ? `${name}, ${badge.title}` : name,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          if (!e.repeat) activate();
        },
      })}
    >
      {inner}
    </div>
  );
}

/** Grid gap of `.widgets`, for turning a drag distance into columns and rows. */
const WIDGET_GAP = 20;
const MAX_COLS = 2;
const MAX_ROWS = 2;

export function Widget({
  w,
  dragProps,
  theme,
  onResize,
  onRemove,
  extra,
  onUpdate,
  preview,
}: {
  w: WidgetInfo;
  dragProps?: DragProps;
  theme: string;
  onResize?: (size: string, commit: boolean) => void;
  /** Edit mode: removes the card from the screen (it stays in the library). */
  onRemove?: () => void;
  /** Controls at the end of the card's head (the library's Add button and size). */
  extra?: ReactNode;
  /** The card after an action or a refresh: the caller puts it in place of this one. Absent = no write-back controls work. */
  onUpdate?: (w: WidgetInfo) => void;
  /** A live preview (the library): every control is drawn and none responds. */
  preview?: boolean;
}) {
  const { lang, t } = useLang();
  const accent = useAccentParam();
  const title = localized(lang, w).title;
  const embed = `${w.peer ? `/api/peers/${encodeURIComponent(w.peer)}` : "/api"}/widgets/${encodeURIComponent(w.app)}/${encodeURIComponent(w.name)}/embed?theme=${theme}&lang=${lang}`;
  const link = w.link ? withAccent(withLang(w.link, lang), accent) : "";
  const tall = w.size.endsWith("x2");
  // In edit mode and in the library the controls are drawn and inert; a peer's card has no
  // write-back controls at all (its hub strips them, and the card does not rely on that).
  const live = !onResize && !onRemove && !preview && !extra;
  const acts = !w.peer;
  const actLive = live && acts && !!onUpdate;
  const views = w.ok && w.views && w.views.length > 1 ? w.views : undefined;
  const [viewId, setViewId] = useState(() => (views ? loadView(w.id, views.map((v) => v.id)) : undefined));
  const view = views ? (views.find((v) => v.id === viewId) ?? views[0]!) : undefined;
  const blocks: WidgetBlock[] | undefined = view ? view.blocks : w.ok ? w.blocks : undefined;
  const viewKey = view?.id ?? "";
  const hasBlocks = w.ok && !!blocks?.length;
  const choose = (id: string) => {
    setViewId(id);
    saveView(w.id, id);
  };

  // A value that changed between two payloads of the same view flashes once; not on first mount.
  const prev = useRef<{ key: string; blocks?: WidgetBlock[] } | undefined>(undefined);
  const [flash, setFlash] = useState<(Flash & { key: string }) | undefined>(undefined);
  useEffect(() => {
    const p = prev.current;
    prev.current = { key: viewKey, blocks };
    if (!p || p.key !== viewKey || !blocks || !p.blocks || p.blocks === blocks) return;
    const marks = blockChanges(p.blocks, blocks);
    if (!marks.some(Boolean)) return;
    setFlash((f) => ({ key: viewKey, n: (f?.n ?? 0) + 1, marks }));
  }, [blocks, viewKey]);
  // Cleared once played, so a later remount (another page of rows) does not play it again.
  useEffect(() => {
    if (!flash) return;
    const h = setTimeout(() => setFlash(undefined), 1300);
    return () => clearTimeout(h);
  }, [flash]);

  // Write-back: one action at a time; a check is ticked while it is on the way and rolled back when it fails.
  const [busy, setBusy] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [asking, setAsking] = useState<{ text: string; label: string; resolve: (ok: boolean) => void } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!msg) return;
    const h = setTimeout(() => setMsg(null), msg.kind === "error" ? 6000 : 4000);
    return () => clearTimeout(h);
  }, [msg]);
  const fail = (error: string) => setMsg({ kind: "error", text: t("widget.actionFailed", { error }) });
  const ask = (a: BlockAction | CardAction) =>
    a.confirm ? new Promise<boolean>((resolve) => setAsking({ text: txt(a.confirm, lang), label: txt(a.label, lang), resolve })) : Promise.resolve(true);
  const answer = (ok: boolean) => {
    asking?.resolve(ok);
    setAsking(null);
  };
  const run = async (a: BlockAction | CardAction, value?: string): Promise<boolean> => {
    if (!actLive || busy) return false;
    setMsg(null);
    if (!(await ask(a))) return false;
    const untick = () =>
      setTicked((cur) => {
        const next = new Set(cur);
        next.delete(a.id);
        return next;
      });
    if (a.kind === "check") setTicked((cur) => new Set(cur).add(a.id));
    setBusy(a.id);
    const r = await postWidget(w, "action", value === undefined ? { action: a.id } : { action: a.id, value });
    setBusy(null);
    if (a.kind === "check") untick();
    if (!r.ok) {
      fail(r.error);
      return false;
    }
    onUpdate!(r.widget);
    const m = typeof r.message === "string" || (r.message && typeof r.message === "object") ? txt(r.message as string | Record<string, string>, lang).slice(0, 200) : "";
    if (m) setMsg({ kind: "info", text: m });
    return true;
  };
  const refresh = async () => {
    if (!actLive || refreshing) return;
    setRefreshing(true);
    const r = await postWidget(w, "refresh");
    setRefreshing(false);
    if (r.ok) onUpdate!(r.widget);
    else fail(r.error);
  };
  const ctx: BlockCtx = { live, acts, actLive, busy, ticked, onAction: (a) => void run(a) };
  const cardActs = w.ok && acts ? (w.actions ?? []) : [];
  const input = cardActs.find((a) => a.kind === "input");
  const buttons = cardActs.filter((a) => a.kind === "button");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (!input || !v) return;
    if (await run(input, v)) setDraft("");
  };
  const asOf = w.ok ? w.asOf : undefined;
  const outdated = w.ok && isOutdated(w.asOf, w.staleAfterMs);
  const card = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  // A size change (a drag snapping to the next cell, or a layout loaded later) is animated from the
  // card's previous box to its new one: grid spans cannot transition, so the box is measured before
  // and after the render and tweened with the Web Animations API.
  const lastBox = useRef<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const prev = lastBox.current;
    lastBox.current = { w: r.width, h: r.height };
    if (!prev || (prev.w === r.width && prev.h === r.height) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.style.overflow = "hidden";
    const anim = el.animate([{ width: `${prev.w}px`, height: `${prev.h}px` }, { width: `${r.width}px`, height: `${r.height}px` }], { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    anim.onfinish = () => {
      el.style.overflow = "";
    };
  }, [w.size]);
  // Edit mode: the handle in the bottom-right corner resizes by dragging (pointer events, so the
  // HTML5 drag that reorders cards does not start). One cell is the card's current width divided by
  // its columns; crossing half a cell snaps to the next size, and the size is saved on release.
  const startResize = (e: React.PointerEvent) => {
    if (!onResize || !card.current) return;
    e.preventDefault();
    e.stopPropagation();
    const [cols0, rows0] = w.size.split("x").map(Number) as [number, number];
    const rect = card.current.getBoundingClientRect();
    const cellW = (rect.width - WIDGET_GAP * (cols0 - 1)) / cols0;
    const cellH = (rect.height - WIDGET_GAP * (rows0 - 1)) / rows0;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = w.size;
    const sizeAt = (ev: PointerEvent) => {
      const cols = Math.min(MAX_COLS, Math.max(1, cols0 + Math.round((ev.clientX - x0) / (cellW + WIDGET_GAP))));
      const rows = Math.min(MAX_ROWS, Math.max(1, rows0 + Math.round((ev.clientY - y0) / (cellH + WIDGET_GAP))));
      return `${cols}x${rows}`;
    };
    const move = (ev: PointerEvent) => {
      const next = sizeAt(ev);
      setResizing(next);
      if (next !== last) {
        last = next;
        onResize(next, false);
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setResizing(null);
      onResize(sizeAt(ev), true);
      // The release also produces a click, wherever the pointer ended up; a click on the
      // background would leave edit mode, so the one that follows this drag is swallowed.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div ref={card} className={`widget s${w.size}${w.stale ? " stale" : ""}${hasBlocks ? " has-blocks" : ""}${resizing ? " resizing" : ""}`} {...(dragProps as object)} title={w.stale ? t("widget.stale", { peer: w.peer ?? "" }) : undefined}>
      {onRemove && (
        <button
          className="tile-del"
          title={t("screens.unpin")}
          aria-label={t("screens.unpin")}
          draggable={false}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      )}
      {/* The title stays quiet and leads to the app; the content is what the card is about. */}
      <div className="widget-head">
        <span className="widget-ico">
          <Icon icon={w.icon} fallback="📦" />
        </span>
        {link ? (
          <a className="widget-title" href={link} target="_blank" rel="noopener noreferrer">
            {title}
          </a>
        ) : (
          <span className="widget-title">{title}</span>
        )}
        {w.peer && <span className="widget-peer">{w.peer}</span>}
        {asOf &&
          (acts && onUpdate ? (
            <button
              type="button"
              className={`widget-asof widget-refresh${outdated ? " outdated" : ""}${refreshing ? " busy" : ""}`}
              title={`${new Date(asOf).toLocaleString()} · ${t("widget.refresh")}`}
              aria-label={`${outdated ? t("widget.outdated", { time: relTime(asOf, lang) }) : relTime(asOf, lang)} · ${refreshing ? t("widget.refreshing") : t("widget.refresh")}`}
              disabled={!actLive}
              onClick={() => void refresh()}
            >
              <svg className="widget-refresh-ico" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {outdated ? t("widget.outdated", { time: relTime(asOf, lang) }) : relTime(asOf, lang)}
            </button>
          ) : (
            <span className={`widget-asof${outdated ? " outdated" : ""}`} title={new Date(asOf).toLocaleString()}>
              {outdated ? t("widget.outdated", { time: relTime(asOf, lang) }) : relTime(asOf, lang)}
            </span>
          ))}
        {onResize && <span className="widget-size">{(resizing ?? w.size).replace("x", "×")}</span>}
        {extra && <span className="widget-extra">{extra}</span>}
      </div>
      {onResize && <span className="widget-grip" title={t("widget.resizeHint")} draggable={false} onPointerDown={startResize} onDragStart={(e) => e.preventDefault()} />}
      {views && view && (
        <div
          className="widget-views"
          role="tablist"
          aria-label={t("widget.views")}
          onKeyDown={(e) => {
            if (!live || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
            e.preventDefault();
            const i = views.findIndex((v) => v.id === view.id);
            const next = views[(i + (e.key === "ArrowRight" ? 1 : views.length - 1)) % views.length]!;
            choose(next.id);
            (e.currentTarget.querySelector(`[data-view="${next.id}"]`) as HTMLElement | null)?.focus();
          }}
        >
          {views.map((v) => (
            <button key={v.id} type="button" role="tab" data-view={v.id} aria-selected={v.id === view.id} tabIndex={v.id === view.id ? 0 : -1} disabled={!live} onClick={() => choose(v.id)}>
              {txt(v.label, lang)}
            </button>
          ))}
        </div>
      )}
      {w.kind === "embed" ? (
        <iframe title={title} src={embed} sandbox="allow-scripts" loading="lazy" />
      ) : w.ok && blocks?.length ? (
        <Blocks key={viewKey} blocks={blocks} size={w.size} ctx={ctx} flash={flash?.key === viewKey ? flash : undefined} />
      ) : w.ok ? (
        <div className="widget-list">
          {w.items.slice(0, tall ? 14 : 6).map((it, i) => (
            <a key={i} href={it.url || link} target="_blank" rel="noopener noreferrer">
              <span className="wi-text">{it.text}</span>
              {it.time && <span className="wi-time">{relTime(it.time, lang)}</span>}
            </a>
          ))}
          {!w.items.length && <p className="widget-err">{t("widget.empty")}</p>}
        </div>
      ) : (
        <p className="widget-err">{t("common.unavailable", { error: w.error })}</p>
      )}
      {link && !hasBlocks && (
        <a className="widget-more" href={link} target="_blank" rel="noopener noreferrer">
          {t("widget.viewAll")}
        </a>
      )}
      {(cardActs.length > 0 || asking || msg || (acts && onUpdate)) && (
        <div className={`widget-foot${cardActs.length || asking ? " has-controls" : ""}`}>
          {asking ? (
            <div
              className="widget-confirm"
              role="group"
              aria-label={asking.text}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  answer(false);
                }
              }}
            >
              <span className="widget-confirm-text">{asking.text}</span>
              <button type="button" className="wa-btn" onClick={() => answer(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="wa-btn primary" autoFocus onClick={() => answer(true)}>
                {asking.label}
              </button>
            </div>
          ) : (
            cardActs.length > 0 && (
              <div className="widget-actions">
                {input && (
                  <form className="wa-form" onSubmit={(e) => void submit(e)}>
                    <input
                      className="wa-input"
                      type="text"
                      value={draft}
                      maxLength={2000}
                      placeholder={txt(input.placeholder, lang) || txt(input.label, lang)}
                      aria-label={txt(input.label, lang)}
                      disabled={!actLive || busy !== null}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <button type="submit" className={`wa-send${busy === input.id ? " busy" : ""}`} aria-label={txt(input.label, lang)} title={txt(input.label, lang)} disabled={!actLive || busy !== null || !draft.trim()}>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </form>
                )}
                {buttons.map((a) => (
                  <button key={a.id} type="button" className={`wa-btn${busy === a.id ? " busy" : ""}`} disabled={!actLive || busy !== null} onClick={() => void run(a)}>
                    {txt(a.label, lang)}
                  </button>
                ))}
              </div>
            )
          )}
          <p className={`widget-msg${msg ? ` ${msg.kind}` : ""}`} role="status">
            {msg?.text ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}
