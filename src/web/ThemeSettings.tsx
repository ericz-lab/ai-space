import { useEffect, useRef, useState } from "react";
import { type Key, useLang } from "./i18n.ts";
import {
  type Issue,
  type Mode,
  type Overrides,
  type ThemePreferences,
  MAX_IMPORT_BYTES,
  NUMBER_BOUNDS,
  PRESETS,
  alphaOf,
  defaultPreferences,
  exportPreferences,
  hasOverrides,
  importPreferences,
  previewAppearance,
  samePreferences,
  saveAppearance,
  toHex,
  useAppearance,
} from "./theme.ts";

/**
 * The appearance rows of the settings (docs/panel.md#appearance). The mode is saved at once, like
 * the dark switch it replaces; the theme and the adjustments are edited as a draft that the page
 * previews live, then saved or cancelled. Adjustments belong to the scheme on screen, so light and
 * dark keep their own. Unsaved edits are dropped when the settings close.
 */

const MODES: { mode: Mode; key: Key }[] = [
  { mode: "system", key: "appearance.system" },
  { mode: "light", key: "appearance.light" },
  { mode: "dark", key: "appearance.dark" },
];
const presetKey = (id: string) => `preset.${id}` as Key;

export default function ThemeSettings() {
  const { t } = useLang();
  const a = useAppearance();
  const draft = a.draft ?? a.saved;
  const dirty = a.draft !== null && !samePreferences(a.draft, a.saved);
  const [open, setOpen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [note, setNote] = useState<{ err: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => () => previewAppearance(null), []);

  const issueText = (issues: Issue[]) =>
    issues
      .slice(0, 3)
      .map((i) => t(`themeIssue.${i.code}`, { path: i.path ?? "/", min: i.min ?? 0, max: i.max ?? 0 }))
      .join("; ");

  const edit = (fn: (p: ThemePreferences) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setNote(null);
    previewAppearance(next);
  };
  const setOverride = <K extends keyof Overrides>(k: K, v: Overrides[K]) => edit((p) => void (p.overrides[a.scheme][k] = v));

  const save = (prefs: ThemePreferences) => {
    const ok = saveAppearance(prefs);
    setNote(ok ? null : { err: true, text: t("appearance.notSaved") });
  };
  // The mode is saved straight away; an open draft takes it too so the preview keeps it.
  const pickMode = (mode: Mode) => {
    save({ ...a.saved, mode });
    if (a.draft) previewAppearance({ ...a.draft, mode });
  };
  const pickPreset = (id: string, keep: boolean) => {
    setPendingPreset(null);
    edit((p) => {
      p.presetId = id;
      if (!keep) p.overrides = { light: {}, dark: {} };
    });
  };

  const download = () => {
    const blob = new Blob([exportPreferences(a.saved)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ai-space-panel-theme.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const upload = async (f: File | undefined) => {
    if (file.current) file.current.value = "";
    if (!f) return;
    const r = f.size > MAX_IMPORT_BYTES ? ({ ok: false, issues: [{ code: "tooLarge", max: MAX_IMPORT_BYTES / 1024 }] } as const) : importPreferences(await f.text());
    if (!r.ok) return setNote({ err: true, text: t("appearance.importFailed", { error: issueText([...r.issues]) }) });
    previewAppearance(r.prefs);
    setNote({ err: false, text: t("appearance.imported") });
  };

  const r = a.resolved;
  const o = draft.overrides[a.scheme];
  const range = (label: Key, value: number, min: number, max: number, set: (v: number) => void, unit = "") => (
    <label className="setrow">
      {t(label)}
      <span className="setrange">
        <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => set(Number(e.target.value))} />
        <span>
          {value}
          {unit}
        </span>
      </span>
    </label>
  );
  const color = (label: Key, k: "accent" | "background") => (
    <label className="setrow">
      {t(label)}
      <span className="setcolor">
        {o[k] !== undefined && (
          <button type="button" title={t("appearance.reset")} onClick={() => edit((p) => void delete p.overrides[a.scheme][k])}>
            ↺
          </button>
        )}
        <input type="color" value={toHex(r[k])} onChange={(e) => setOverride(k, e.target.value)} />
      </span>
    </label>
  );

  return (
    <>
      {a.problem && (
        <div className="setnote err setline" role="alert">
          <span>{t("appearance.unreadable", { error: issueText(a.problem.issues) })}</span>
          <button className="btn2" onClick={() => save(defaultPreferences(a.saved.mode))}>
            {t("appearance.resetNow")}
          </button>
        </div>
      )}
      <label className="setrow">
        {t("appearance.mode")}
        <select className="setselect" value={a.saved.mode} onChange={(e) => pickMode(e.target.value as Mode)}>
          {MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {t(m.key)}
            </option>
          ))}
        </select>
      </label>
      <label className="setrow">
        {t("appearance.preset")}
        <select
          className="setselect"
          value={pendingPreset ?? draft.presetId}
          onChange={(e) => (hasOverrides(draft) ? setPendingPreset(e.target.value) : pickPreset(e.target.value, false))}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(presetKey(p.id))}
            </option>
          ))}
        </select>
      </label>
      {pendingPreset && (
        <div className="setnote">
          {t("appearance.presetPrompt", { name: t(presetKey(pendingPreset)) })}
          <div className="setbtns">
            <button className="btn2" onClick={() => setPendingPreset(null)}>
              {t("common.cancel")}
            </button>
            <button className="btn2" onClick={() => pickPreset(pendingPreset, false)}>
              {t("appearance.clear")}
            </button>
            <button className="btn2 primary" onClick={() => pickPreset(pendingPreset, true)}>
              {t("appearance.keep")}
            </button>
          </div>
        </div>
      )}
      <button className="setrow setlink" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        {t("appearance.customize")}
        <span className={`setchev${open ? " open" : ""}`}>›</span>
      </button>
      {open && (
        <div className="setgroup">
          <p className="setnote">{t("appearance.editing", { scheme: t(a.scheme === "dark" ? "appearance.schemeDark" : "appearance.schemeLight") })}</p>
          {color("appearance.accent", "accent")}
          {color("appearance.background", "background")}
          {range("appearance.radius", r.radius, NUMBER_BOUNDS.radius[0], NUMBER_BOUNDS.radius[1], (v) => setOverride("radius", v), "px")}
          {range("appearance.blur", r.blur, NUMBER_BOUNDS.blur[0], NUMBER_BOUNDS.blur[1], (v) => setOverride("blur", v), "px")}
          {range("appearance.opacity", Math.round(alphaOf(r.surface) * 100), 0, 100, (v) => setOverride("surfaceAlpha", v / 100), "%")}
          <label className="setrow">
            {t("appearance.glow")}
            <input type="checkbox" role="switch" checked={r.glow} onChange={() => setOverride("glow", !r.glow)} />
          </label>
          <div className="setbtns">
            <button className="btn2" onClick={download}>
              {t("appearance.export")}
            </button>
            <button className="btn2" onClick={() => file.current?.click()}>
              {t("appearance.import")}
            </button>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => void upload(e.target.files?.[0])} />
            <span className="setbtns-gap" />
            <button className="btn2" onClick={() => edit((p) => Object.assign(p, defaultPreferences(p.mode)))}>
              {t("appearance.reset")}
            </button>
          </div>
        </div>
      )}
      {note && (
        <p className={`setnote${note.err ? " err" : ""}`} role={note.err ? "alert" : undefined}>
          {note.text}
        </p>
      )}
      {dirty && (
        <div className="setbtns">
          <span className="setnote">{t("appearance.unsaved")}</span>
          <span className="setbtns-gap" />
          <button
            className="btn2"
            onClick={() => {
              setNote(null);
              previewAppearance(null);
            }}
          >
            {t("common.cancel")}
          </button>
          <button className="btn2 primary" onClick={() => save(draft)}>
            {t("common.save")}
          </button>
        </div>
      )}
    </>
  );
}
