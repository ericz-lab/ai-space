import { type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WidgetInfo } from "./api.ts";
import { useLang } from "./i18n.ts";
import { type DragProps, Widget } from "./Tiles.tsx";
import {
  type Align,
  type Box,
  type Edge,
  type Frame,
  type Guides,
  type LayoutWrite,
  ONE_COLUMN_BELOW,
  alignTwelfths,
  framesWrite,
  keyStep,
  nudge,
  place,
  resizeTo,
  resolveFrames,
  sizeClass,
  splitEvenly,
  startResize as startDrag,
} from "./widget-layout.ts";

// A screen's widget area (docs/panel.md#resize-a-widget), shared by the panel (App.tsx) and the
// widget preview: the cards placed by widget-layout.ts, each absolutely positioned in an area as
// tall as its rows, so a card keeps its element (and its state) while it moves. In edit mode every
// card has three handles (right edge, bottom edge, corner), cards reorder by dragging with the rows
// re-flowing live, and a toolbar aligns, centres, splits and resets. Below 700px the area is one
// column of cards sized by their content, as before; the frames are kept and not applied.

export type AreaCard = { key: string; w: WidgetInfo };

const TWEEN = { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
const UNDO_MS = 8000;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function WidgetArea({
  cards,
  align,
  editing,
  theme,
  onRemove,
  onUpdate,
  onReorder,
  apply,
  save,
}: {
  cards: AreaCard[];
  align: Align;
  editing: boolean;
  theme: string;
  onRemove?: (key: string) => void;
  onUpdate?: (w: WidgetInfo) => void;
  /** A card dropped at another place in the area's order. */
  onReorder?: (from: number, to: number) => void;
  /** Puts a layout write on the page at once (frames, sizes, the alignment). */
  apply: (write: LayoutWrite) => void;
  /** Stores it; false when it was not saved (the area then puts the previous layout back). */
  save: (write: LayoutWrite) => Promise<boolean>;
}) {
  const { t } = useLang();
  const area = useRef<HTMLDivElement>(null);
  const [W, setW] = useState<number | null>(null);
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(`(max-width: ${ONE_COLUMN_BELOW}px)`).matches);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const read = () => setW(el.getBoundingClientRect().width || null);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const mq = matchMedia(`(max-width: ${ONE_COLUMN_BELOW}px)`);
    const onMq = () => setNarrow(mq.matches);
    mq.addEventListener("change", onMq);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);
  const free = !narrow && W !== null && W > 0;
  const width = W ?? 0;

  // While an edge is dragged (or moved with the keys) the frames shown are these, not the stored ones.
  const [live, setLive] = useState<Frame[] | null>(null);
  const [active, setActive] = useState<{ i: number; edge: Edge } | null>(null);
  const [guides, setGuides] = useState<Guides | null>(null);
  // While a card is dragged to another place: the order shown, as indices into `cards`.
  const [perm, setPerm] = useState<number[] | null>(null);
  const ordered = perm ?? cards.map((_, i) => i);
  const frames = live ?? resolveFrames(cards.map((c) => c.w), width);
  const placed = place(ordered.map((i) => frames[i]!), width, align);
  const boxOf: Box[] = new Array(cards.length);
  ordered.forEach((ci, pos) => (boxOf[ci] = placed.boxes[pos]!));

  // The size class each card's inner layout follows, kept per card for the hysteresis.
  const classes = useRef(new Map<string, string>());
  const classOf = (key: string, b: Box) => {
    const c = sizeClass(classes.current.get(key), b.width, b.height);
    classes.current.set(key, c);
    return c;
  };

  // Moves (a toolbar action, an undo, a reorder) tween each card from its previous box to its new one.
  const els = useRef(new Map<string, HTMLDivElement>());
  const prevBoxes = useRef(new Map<string, Box>());
  const prevOrder = useRef("");
  const animateNext = useRef(false);
  useLayoutEffect(() => {
    if (!free) {
      prevBoxes.current.clear();
      prevOrder.current = "";
      return;
    }
    const order = ordered.map((i) => cards[i]!.key).join("\n");
    const moved = animateNext.current || (prevOrder.current !== "" && prevOrder.current !== order);
    animateNext.current = false;
    prevOrder.current = order;
    if (moved && !live && !reducedMotion())
      cards.forEach((c, i) => {
        const b = boxOf[i]!;
        const p = prevBoxes.current.get(c.key);
        const el = els.current.get(c.key);
        if (!p || !el || (p.x === b.x && p.y === b.y && p.width === b.width && p.height === b.height)) return;
        el.animate(
          [
            { left: `${p.x}px`, top: `${p.y}px`, width: `${p.width}px`, height: `${p.height}px` },
            { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px` },
          ],
          TWEEN,
        );
      });
    prevBoxes.current = new Map(cards.map((c, i) => [c.key, boxOf[i]!]));
  });

  // Writes: drawn at once, saved, put back with a message when the save fails; the last one can be undone.
  const [undoable, setUndoable] = useState<{ undo: LayoutWrite; redo: LayoutWrite } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!undoable) return;
    const h = setTimeout(() => setUndoable(null), UNDO_MS);
    return () => clearTimeout(h);
  }, [undoable]);
  useEffect(() => {
    if (!error) return;
    const h = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(h);
  }, [error]);
  useEffect(() => {
    if (!editing) {
      setUndoable(null);
      setConfirmReset(false);
    }
  }, [editing]);
  const run = (write: LayoutWrite, undo: LayoutWrite, animate: boolean, undoing = false) => {
    if (animate) animateNext.current = true;
    apply(write);
    setError(null);
    setUndoable(undoing ? null : { undo, redo: write });
    void save(write).then((ok) => {
      if (ok) return;
      animateNext.current = true;
      apply(undo);
      setUndoable(null);
      setError(t("layout.saveFailed"));
    });
  };
  const stored = () => cards.map((c) => ({ id: c.w.id, size: c.w.size, frame: c.w.frame }));
  const commit = (before: Frame[], after: Frame[], animate = false) => {
    const r = framesWrite(stored(), before, after);
    if (r) run(r.write, r.undo, animate);
  };

  // Dragging an edge. The width goes through setWidth (the boundary with the next card, or the
  // row's free space; Shift re-flows), the height sets the row's; both snap unless Alt is held.
  const resizing = useRef(false);
  const startResize = (i: number, edge: Edge) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || !free) return;
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const base = frames;
    const start = startDrag(base, width, align, i, edge);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const at = (ev: PointerEvent) => {
      const r = resizeTo(start, ev.clientX - x0, ev.clientY - y0, { reflow: ev.shiftKey, free: ev.altKey });
      return { f: r.frames, g: r.guides };
    };
    setActive({ i, edge });
    const move = (ev: PointerEvent) => {
      const r = at(ev);
      setLive(r.f);
      setGuides(r.g.x.length || r.g.y.length ? r.g : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      resizing.current = false;
      const r = at(ev);
      setLive(null);
      setGuides(null);
      setActive(null);
      if (ev.type === "pointerup") commit(base, r.f);
      // The release also produces a click wherever the pointer ended up; a click on the background
      // would leave edit mode, so the one that follows this drag is swallowed.
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

  // The handles from the keyboard: 8px a press, 1px with Shift; saved once the keys rest or focus leaves.
  const keys = useRef<{ base: Frame[]; f: Frame[]; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const finishKeys = () => {
    const k = keys.current;
    if (!k) return;
    clearTimeout(k.timer);
    keys.current = null;
    setLive(null);
    setActive(null);
    commit(k.base, k.f);
  };
  const onKey = (i: number, edge: Edge) => (e: KeyboardEvent) => {
    const arrow = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[e.key as "ArrowLeft"];
    const { dx, dy } = arrow ? keyStep(edge, arrow, e.shiftKey) : { dx: 0, dy: 0 };
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    const k = keys.current ?? (keys.current = { base: frames, f: frames });
    const f = nudge(k.f, width, align, i, dx, dy);
    k.f = f;
    setLive(f);
    setActive({ i, edge });
    clearTimeout(k.timer);
    k.timer = setTimeout(finishKeys, 700);
  };

  // Reordering: HTML5 drag as before, but the order shown changes while the card is dragged (only
  // positions change, the elements stay where they are, so the browser does not end the drag).
  const reorder = useRef<{ from: number; perm: number[]; last: number } | null>(null);
  const dragProps = (i: number): DragProps =>
    editing && onReorder
      ? ({
          draggable: true,
          onDragStart: (e: DragEvent) => {
            if (resizing.current || (e.target as Element).closest?.(".wl-handle")) {
              e.preventDefault();
              return;
            }
            reorder.current = { from: i, perm: ordered.slice(), last: i };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", cards[i]!.key);
          },
          onDragOver: (e: DragEvent) => {
            const r = reorder.current;
            if (!r) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            // A card that just moved under the pointer is not a new target until the pointer has been elsewhere.
            if (r.last === i) return;
            r.last = i;
            if (i === r.from) return;
            const p = r.perm.filter((x) => x !== r.from);
            p.splice(r.perm.indexOf(i), 0, r.from);
            r.perm = p;
            if (free) setPerm(p);
          },
          onDrop: (e: DragEvent) => e.preventDefault(),
          onDragEnd: () => {
            const r = reorder.current;
            reorder.current = null;
            setPerm(null);
            const to = r ? r.perm.indexOf(r.from) : -1;
            if (r && to >= 0 && to !== r.from) onReorder(r.from, to);
          },
        } as DragProps)
      : undefined;

  // The toolbar's operations, each one write over the area's cards.
  const [confirmReset, setConfirmReset] = useState(false);
  const doAlign = () => commit(frames, alignTwelfths(frames, width), true);
  const doSplit = () => commit(frames, splitEvenly(frames), true);
  const doCenter = () => run({ widgetAlign: align === "center" ? "start" : "center" }, { widgetAlign: align }, true);
  const doReset = () => {
    setConfirmReset(false);
    const framed = cards.filter((c) => c.w.frame);
    if (!framed.length) return;
    run({ frames: Object.fromEntries(framed.map((c) => [c.w.id, null])) }, { frames: Object.fromEntries(framed.map((c) => [c.w.id, c.w.frame!])), sizes: Object.fromEntries(framed.map((c) => [c.w.id, c.w.size])) }, true);
  };
  const doUndo = () => {
    if (!undoable) return;
    run(undoable.undo, undoable.redo, true, true);
  };

  const handles = (i: number, b: Box) => {
    const common = (edge: Edge) => ({
      tabIndex: 0,
      draggable: false,
      onPointerDown: startResize(i, edge),
      onKeyDown: onKey(i, edge),
      onBlur: finishKeys,
      onDragStart: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
    });
    return (
      <>
        <span className="wl-handle wl-x" role="separator" aria-orientation="vertical" aria-valuenow={Math.round(b.width)} aria-label={t("widget.resizeWidth")} title={t("widget.resizeWidth")} {...common("x")} />
        <span className="wl-handle wl-y" role="separator" aria-orientation="horizontal" aria-valuenow={Math.round(b.height)} aria-label={t("widget.resizeHeight")} title={t("widget.resizeHeight")} {...common("y")} />
        <span className="wl-handle wl-xy widget-grip" role="button" aria-label={t("widget.resizeBoth")} title={t("widget.resizeBoth")} {...common("xy")} />
      </>
    );
  };

  return (
    <>
      {editing && free && cards.length > 0 && (
        <div className="wl-toolbar" role="toolbar" aria-label={t("layout.toolbar")}>
          <button type="button" className="btn2" title={t("layout.alignHint")} onClick={doAlign}>
            {t("layout.align")}
          </button>
          <button type="button" className={`btn2${align === "center" ? " on" : ""}`} aria-pressed={align === "center"} title={t("layout.centerHint")} onClick={doCenter}>
            {t("layout.center")}
          </button>
          <button type="button" className="btn2" title={t("layout.splitHint")} onClick={doSplit}>
            {t("layout.split")}
          </button>
          {confirmReset ? (
            <span className="wl-confirm" role="group" aria-label={t("layout.resetAsk")}>
              <span>{t("layout.resetAsk")}</span>
              <button type="button" className="btn2" onClick={() => setConfirmReset(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn2 danger" autoFocus onClick={doReset}>
                {t("layout.reset")}
              </button>
            </span>
          ) : (
            <button type="button" className="btn2" title={t("layout.resetHint")} disabled={!cards.some((c) => c.w.frame)} onClick={() => setConfirmReset(true)}>
              {t("layout.reset")}
            </button>
          )}
          {undoable && (
            <button type="button" className="btn2 wl-undo" onClick={doUndo}>
              ↶ {t("layout.undo")}
            </button>
          )}
          {error && (
            <span className="wl-error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
      <div ref={area} className={`widgets ${free ? "flow" : "column"}${editing ? " editing" : ""}`} style={free ? ({ height: placed.height } as CSSProperties) : undefined}>
        {cards.map((c, i) => {
          const b = boxOf[i]!;
          const isActive = active?.i === i;
          return (
            <Widget
              key={c.key}
              w={c.w}
              theme={theme}
              editing={editing}
              cardRef={(el) => {
                if (el) els.current.set(c.key, el);
                else els.current.delete(c.key);
              }}
              frame={
                free
                  ? {
                      style: { left: b.x, top: b.y, width: b.width, height: b.height },
                      sizeClass: classOf(c.key, b),
                      ...(editing ? { handles: handles(i, b), readout: `${Math.round(b.width)} × ${Math.round(b.height)}`, resizing: isActive } : {}),
                    }
                  : undefined
              }
              dragProps={dragProps(i)}
              onRemove={editing && onRemove ? () => onRemove(c.key) : undefined}
              onUpdate={onUpdate}
            />
          );
        })}
        {guides?.x.map((x, k) => <span key={`x${k}`} className="wl-guide wl-guide-x" style={{ left: x }} aria-hidden="true" />)}
        {guides?.y.map((y, k) => <span key={`y${k}`} className="wl-guide wl-guide-y" style={{ top: y }} aria-hidden="true" />)}
      </div>
    </>
  );
}
