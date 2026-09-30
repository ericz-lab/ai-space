import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { isImgIcon, relTime, type WidgetInfo } from "./api.ts";
import { type Key, localized, useLang, withLang } from "./i18n.ts";

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
  showPop = true,
  dragProps,
  stale,
  corner,
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
  showPop?: boolean;
  dragProps?: DragProps;
  /** The peer is not answering: the entry is its last known state. */
  stale?: boolean;
  /** A small icon over the icon's bottom-right corner: the app an agent belongs to. */
  corner?: string;
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
      </span>
      <span className="tile-name">{name}</span>
      {!editing && !popHidden && showPop && <div className="pop">{children}</div>}
    </>
  );
  const common = {
    className: `tile${stale ? " stale" : ""}${className ? ` ${className}` : ""}`,
    ...(dragProps as object),
    onMouseLeave: () => setPopHidden(false),
    onClick: () => {
      setPopHidden(true);
      if (!editing && onOpen) onOpen();
    },
  };
  return asLink ? (
    <a {...common} href={href} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  ) : (
    <div {...common}>{inner}</div>
  );
}

/** Grid gap of `.widgets`, for turning a drag distance into columns and rows. */
const WIDGET_GAP = 20;
const MAX_COLS = 2;
const MAX_ROWS = 2;

export function Widget({ w, dragProps, theme, onResize }: { w: WidgetInfo; dragProps?: DragProps; theme: string; onResize?: (size: string, commit: boolean) => void }) {
  const { lang, t } = useLang();
  const title = localized(lang, w).title;
  const embed = `${w.peer ? `/api/peers/${encodeURIComponent(w.peer)}` : "/api"}/widgets/${encodeURIComponent(w.app)}/${encodeURIComponent(w.name)}/embed?theme=${theme}&lang=${lang}`;
  const link = w.link ? withLang(w.link, lang) : "";
  const tall = w.size.endsWith("x2");
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
    <div ref={card} className={`widget s${w.size}${w.stale ? " stale" : ""}${resizing ? " resizing" : ""}`} {...(dragProps as object)} title={w.stale ? t("widget.stale", { peer: w.peer ?? "" }) : undefined}>
      <div className="widget-head">
        <span className="widget-ico">
          <Icon icon={w.icon} fallback="📦" />
        </span>
        <b>{title}</b>
        {w.peer && <span className="widget-peer">{w.peer}</span>}
        {onResize && <span className="widget-size">{(resizing ?? w.size).replace("x", "×")}</span>}
      </div>
      {onResize && <span className="widget-grip" title={t("widget.resizeHint")} draggable={false} onPointerDown={startResize} onDragStart={(e) => e.preventDefault()} />}
      {w.kind === "embed" ? (
        <iframe title={title} src={embed} sandbox="allow-scripts" loading="lazy" />
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
      {link && (
        <a className="widget-more" href={link} target="_blank" rel="noopener noreferrer">
          {t("widget.viewAll")}
        </a>
      )}
    </div>
  );
}
