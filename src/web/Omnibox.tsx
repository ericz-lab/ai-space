import { useEffect, useMemo, useRef, useState } from "react";
import { getJson, recordOpen } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Entry } from "./Library.tsx";
import { opensByDefault, rank } from "./omnibox.ts";
import { parseKey } from "./screens.ts";
import { Icon } from "./Tiles.tsx";

// The home screen's command box (docs/panel.md#omnibox): one field that finds an app, agent, widget
// or built-in tile by name, and hands anything else to Space Assistant as a new conversation. Enter
// acts on the highlighted row: the first match when its name holds what was typed, the "ask" row
// otherwise; ⌘/Ctrl+Enter always asks. The microphone records a clip and puts its transcript into
// the field (POST /api/voice/transcribe, voice-studio through the bus); it never sends by itself.

/** A clip is cut here, well under the bus's 4 MB body limit at speech bitrates. */
const MAX_RECORD_MS = 90_000;

type Voice = "off" | "idle" | "recording" | "transcribing";

/** The last focus signal acted on; the box remounts each time the home screen is shown. */
let takenSignal = 0;

/** The first container this browser records in: WebKit has only MP4, the others WebM. */
const recordingType = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";

export default function Omnibox({ entries, onOpen, onAsk, focusSignal }: { entries: Entry[]; onOpen: (key: string) => void; onAsk: (text: string) => void; focusSignal: number }) {
  const { t } = useLang();
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  // A signal is taken once: coming back to the home screen later does not focus the field again.
  useEffect(() => {
    if (focusSignal === takenSignal) return;
    takenSignal = focusSignal;
    field.current?.focus();
  }, [focusSignal]);

  const results = useMemo(() => rank(q, entries), [q, entries]);
  const askIndex = results.length;
  // A new query highlights the row Enter would pick.
  useEffect(() => setSel(opensByDefault(q, results[0]) ? 0 : askIndex), [q, results, askIndex]);

  const reset = () => {
    setQ("");
    field.current?.blur();
  };
  const open = (e: Entry) => {
    const id = parseKey(e.key)!.id;
    if (e.kind === "agent" || e.kind === "builtin") {
      if (e.kind === "builtin") recordOpen("builtin", id, "panel");
      onOpen(e.key);
    } else if (e.href) {
      if (e.kind === "app") recordOpen("app", id, "panel");
      window.open(e.href, "_blank", "noopener,noreferrer");
    } else return;
    reset();
  };
  const ask = () => {
    const text = q.trim();
    if (!text) return;
    onAsk(text);
    reset();
  };
  const act = (i: number) => (i < results.length ? open(results[i]!) : ask());

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) ask();
      else if (q.trim()) act(sel);
    } else if (e.key === "ArrowDown" && q) {
      e.preventDefault();
      setSel((i) => Math.min(askIndex, i + 1));
    } else if (e.key === "ArrowUp" && q) {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (q) setQ("");
      else field.current?.blur();
    }
  };
  // The field grows with what is typed or dictated, up to a few lines.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [q]);

  // Voice: offered only when a transcriber answers on this space or one of its peers.
  const [voice, setVoice] = useState<Voice>("off");
  const [voiceError, setVoiceError] = useState("");
  const recorder = useRef<{ rec: MediaRecorder; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (!recordingType() || !navigator.mediaDevices?.getUserMedia) return;
    getJson<{ transcribe?: boolean }>("/api/voice")
      .then((d) => d.transcribe && setVoice("idle"))
      .catch(() => {});
    return () => recorder.current?.rec.stream.getTracks().forEach((tr) => tr.stop());
  }, []);
  const transcribe = async (clip: Blob) => {
    setVoice("transcribing");
    try {
      const form = new FormData();
      form.append("file", new File([clip], clip.type.includes("mp4") ? "voice.m4a" : "voice.webm", { type: clip.type }));
      const r = await fetch("/api/voice/transcribe", { method: "POST", body: form });
      const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string; detail?: string };
      if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status}`);
      const text = (j.text ?? "").trim();
      if (text) setQ((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text));
      field.current?.focus();
    } catch (e) {
      setVoiceError(t("omni.voiceFailed", { error: (e as Error).message }));
    } finally {
      setVoice("idle");
    }
  };
  const toggleVoice = async () => {
    setVoiceError("");
    if (voice === "recording") {
      recorder.current?.rec.stop();
      return;
    }
    if (voice !== "idle") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceError(t("omni.micDenied"));
      return;
    }
    const rec = new MediaRecorder(stream, { mimeType: recordingType() });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      clearTimeout(recorder.current?.timer);
      recorder.current = null;
      stream.getTracks().forEach((tr) => tr.stop());
      const clip = new Blob(chunks, { type: rec.mimeType });
      if (clip.size) void transcribe(clip);
      else setVoice("idle");
    };
    rec.start();
    recorder.current = { rec, timer: setTimeout(() => rec.state === "recording" && rec.stop(), MAX_RECORD_MS) };
    setVoice("recording");
  };

  const showList = focused && q.trim().length > 0;
  return (
    <div className={`omni${showList ? " open" : ""}`}>
      <div className="omni-bar">
        <span className="omni-glyph" aria-hidden="true">
          ✦
        </span>
        <textarea
          ref={field}
          rows={1}
          className="omni-field"
          value={q}
          placeholder={voice === "recording" ? t("omni.recording") : voice === "transcribing" ? t("omni.transcribing") : t("omni.placeholder")}
          aria-label={t("omni.label")}
          aria-expanded={showList}
          aria-controls="omni-list"
          role="combobox"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          // A click on a row lands before the blur hides the list.
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {voice !== "off" && (
          <button className={`omni-mic ${voice}`} title={voice === "recording" ? t("omni.stop") : t("omni.voice")} aria-label={voice === "recording" ? t("omni.stop") : t("omni.voice")} disabled={voice === "transcribing"} onClick={toggleVoice}>
            {voice === "transcribing" ? "…" : voice === "recording" ? "■" : "🎙"}
          </button>
        )}
      </div>
      {voiceError && <p className="omni-error">{voiceError}</p>}
      {showList && (
        <ul className="omni-list" id="omni-list" role="listbox">
          {results.map((e, i) => (
            <li key={e.key} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => act(i)}>
              <span className="omni-icon">
                <Icon icon={e.icon} fallback={e.fallback} />
              </span>
              <span className="omni-title">{e.title}</span>
              <span className="omni-kind">
                {e.kindLabel}
                {e.peer ? ` · ${e.peer}` : ""}
              </span>
              {i === sel && <kbd>↵</kbd>}
            </li>
          ))}
          <li role="option" aria-selected={sel === askIndex} className={`omni-ask${sel === askIndex ? " on" : ""}`} onMouseEnter={() => setSel(askIndex)} onMouseDown={(ev) => ev.preventDefault()} onClick={ask}>
            <span className="omni-icon">
              <img src="/assistant.svg" alt="" />
            </span>
            <span className="omni-title">
              {t("omni.ask")}: <em>{q.trim()}</em>
            </span>
            <kbd>{sel === askIndex ? "↵" : navigator.platform.startsWith("Mac") ? "⌘↵" : "Ctrl+↵"}</kbd>
          </li>
        </ul>
      )}
    </div>
  );
}
