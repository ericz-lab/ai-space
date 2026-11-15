import { useEffect, useRef } from "react";
import type { Key } from "./i18n.ts";
import { FIXED_KEYS, type KeyId, type Modifiers, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, SCROLLING_KEYS, type TerminalKey } from "./terminal-keys.ts";

// The terminal's key row on a phone (terminal-keys.ts has the keys and their bytes): the keys that
// scroll, then the arrows and hide-keyboard fixed at the right. styles.css shows it on touch
// screens and narrow windows only.
// - A press never takes the focus from the terminal (pointerdown and mousedown are cancelled), so
//   the soft keyboard stays up.
// - A key acts on its click, so a swipe along the row scrolls it without typing; an arrow acts at
//   once on the press and repeats while it is held.

/** Spoken names for the keys whose label says little; the rest read their label. */
const SPOKEN: Partial<Record<KeyId, Key>> = {
  esc: "term.keys.esc",
  backTab: "term.keys.backTab",
  ctrl: "term.keys.ctrl",
  alt: "term.keys.alt",
  ctrlC: "term.keys.ctrlC",
  pageUp: "term.keys.pageUp",
  pageDown: "term.keys.pageDown",
  left: "term.keys.left",
  down: "term.keys.down",
  up: "term.keys.up",
  right: "term.keys.right",
  hideKeyboard: "term.keys.hideKeyboard",
};

const keep = (e: { preventDefault: () => void }) => e.preventDefault();

function KeyCap({ k, on, label, onKey }: { k: TerminalKey; on: boolean; label?: string; onKey: (k: TerminalKey) => void }) {
  const timers = useRef<{ delay?: number; every?: number }>({});
  const stop = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stop, []);
  const modifier = k.kind.type === "modifier";
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`term-key${on ? " on" : ""}${k.repeats || k.kind.type === "hideKeyboard" ? " hold" : ""}`}
      aria-label={label}
      aria-pressed={modifier ? on : undefined}
      onPointerDown={(e) => {
        keep(e);
        if (!k.repeats) return;
        stop();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onKey(k);
        timers.current.delay = window.setTimeout(() => {
          timers.current.every = window.setInterval(() => onKey(k), REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onMouseDown={keep}
      onContextMenu={keep}
      // An arrow already acted on its press; a click without a pointer (a screen reader, detail 0) still counts.
      onClick={(e) => (!k.repeats || e.detail === 0) && onKey(k)}
    >
      {k.kind.type === "hideKeyboard" ? (
        <svg width="20" height="16" viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <rect x="1.5" y="1" width="17" height="9.5" rx="1.8" />
          <path d="M5 4.2h.01M8.3 4.2h.01M11.7 4.2h.01M15 4.2h.01M6.5 7.4h7" />
          <path d="M7.5 12.6 10 14.8l2.5-2.2" />
        </svg>
      ) : (
        k.label
      )}
    </button>
  );
}

export default function TerminalKeyRow({ mods, onKey, t }: { mods: Modifiers; onKey: (k: TerminalKey) => void; t: (key: Key) => string }) {
  const cap = (k: TerminalKey) => {
    const spoken = SPOKEN[k.id];
    const on = k.kind.type === "modifier" && mods[k.kind.which];
    return <KeyCap key={k.id} k={k} on={on} label={spoken ? t(spoken) : undefined} onKey={onKey} />;
  };
  return (
    <div className="term-keys" role="toolbar" aria-label={t("term.keys.row")}>
      <div className="term-keys-scroll">{SCROLLING_KEYS.map(cap)}</div>
      <div className="term-keys-fixed">{FIXED_KEYS.map(cap)}</div>
    </div>
  );
}
