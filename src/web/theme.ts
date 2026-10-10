import { useSyncExternalStore } from "react";

/**
 * The panel's appearance (docs/panel.md#appearance): a preset (a ThemeDefinition with light and dark
 * tokens), a mode (system, light or dark) and the operator's per-mode adjustments.
 *
 * Resolution for the scheme in effect: DEFAULT_THEME's tokens, then the preset's, then the
 * operator's overrides; a token missing at one layer falls back to the layer below. `data-theme` on
 * <html> stays the resolved "light" | "dark", so styles and embedded widgets keep reading it.
 *
 * The pure half (validation, resolution, import and export) has no DOM and is tested in
 * theme.test.ts; the store at the bottom applies, persists and subscribes in the browser.
 */

export type Mode = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

/** Color tokens and the CSS custom property each one sets. Shadow and glow are colors too. */
export const COLOR_VARS = {
  background: "--bg",
  text: "--text",
  muted: "--muted",
  surface: "--glass",
  surfaceStrong: "--glass-strong",
  panel: "--panel",
  solid: "--solid",
  border: "--glass-border",
  hairline: "--hairline",
  shadow: "--shadow-color",
  accent: "--accent",
  onAccent: "--on-accent",
  link: "--link",
  focus: "--focus",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  glowA: "--blob-a",
  glowB: "--blob-b",
  glowC: "--blob-c",
  code: "--code-bg",
  terminal: "--term-bg",
  terminalText: "--term-fg",
  selection: "--selection",
  inverse: "--inverse",
  scrim: "--scrim",
} as const;
export type ColorToken = keyof typeof COLOR_VARS;
export const COLOR_TOKENS = Object.keys(COLOR_VARS) as ColorToken[];

/** Numeric tokens with their bounds; anything outside is rejected, not clamped. */
export const NUMBER_BOUNDS = { radius: [0, 28], blur: [0, 40] } as const;
export type NumberToken = keyof typeof NUMBER_BOUNDS;

export type Tokens = Partial<Record<ColorToken, string>> & Partial<Record<NumberToken, number>> & { glow?: boolean };
export type ResolvedTokens = Record<ColorToken, string> & Record<NumberToken, number> & { glow: boolean };
/** What the operator adjusts per mode: any token, plus the opacity of the glass surface (0..1). */
export type Overrides = Tokens & { surfaceAlpha?: number };

/**
 * `backdrop` names drawn artwork for the page background: `public/backdrops/<backdrop>.html`, a
 * static document with a light and a dark version that the panel frames in place of the glow
 * while the glow is on.
 */
export type ThemeDefinition = { version: 1; id: string; name: string; light: Tokens; dark: Tokens; backdrop?: string };
export type ThemePreferences = { version: 1; mode: Mode; presetId: string; overrides: Record<Scheme, Overrides> };

export const PREFS_VERSION = 1;
export const STORAGE_KEY = "panel-appearance";
/** Resolved variables for both schemes, read by the inline script in index.html before first paint. */
export const BOOT_KEY = "panel-appearance-boot";
/** The light/dark switch of earlier versions; migrated once, then removed. */
export const LEGACY_KEY = "panel-theme";
export const EXPORT_FORMAT = "ai-space-panel-theme";
/** Import files larger than this are refused before parsing. */
export const MAX_IMPORT_BYTES = 16 * 1024;

/** The look the panel always had ("Aurora"); every other preset and override falls back to it. Mirrors styles.css. */
export const DEFAULT_THEME: ThemeDefinition & { light: ResolvedTokens; dark: ResolvedTokens } = {
  version: 1,
  id: "aurora",
  name: "Aurora",
  light: {
    background: "#f6f7fb",
    text: "#0e1116",
    muted: "rgba(14, 17, 22, 0.55)",
    surface: "rgba(255, 255, 255, 0.55)",
    surfaceStrong: "rgba(255, 255, 255, 0.78)",
    panel: "rgba(255, 255, 255, 0.94)",
    solid: "#ffffff",
    border: "rgba(255, 255, 255, 0.65)",
    hairline: "rgba(14, 17, 22, 0.08)",
    shadow: "rgba(31, 38, 135, 0.08)",
    accent: "#8b5cf6",
    onAccent: "#ffffff",
    link: "#6366f1",
    focus: "#8b5cf6",
    success: "#34c759",
    warning: "#ff9500",
    danger: "#ef4444",
    glowA: "#c7d2fe",
    glowB: "#fbcfe8",
    glowC: "#a5f3fc",
    code: "rgba(14, 17, 22, 0.06)",
    terminal: "#fbfbfd",
    terminalText: "#1d1d1f",
    selection: "rgba(99, 102, 241, 0.28)",
    inverse: "#ffffff",
    scrim: "rgba(0, 0, 0, 0.3)",
    radius: 18,
    blur: 20,
    glow: true,
  },
  dark: {
    background: "#1c2030",
    text: "#f1f4f8",
    muted: "rgba(235, 235, 245, 0.62)",
    surface: "rgba(255, 255, 255, 0.09)",
    surfaceStrong: "rgba(40, 45, 62, 0.88)",
    panel: "rgba(40, 45, 62, 0.97)",
    solid: "#2c3145",
    border: "rgba(255, 255, 255, 0.16)",
    hairline: "rgba(255, 255, 255, 0.12)",
    shadow: "rgba(0, 0, 0, 0.3)",
    accent: "#8b5cf6",
    onAccent: "#ffffff",
    link: "#6366f1",
    focus: "#8b5cf6",
    success: "#34c759",
    warning: "#ff9500",
    danger: "#ef4444",
    glowA: "#2a2872",
    glowB: "#5f1642",
    glowC: "#134354",
    code: "rgba(0, 0, 0, 0.3)",
    terminal: "#0b0d12",
    terminalText: "#e6e8ee",
    selection: "rgba(139, 92, 246, 0.35)",
    inverse: "#0e1116",
    scrim: "rgba(0, 0, 0, 0.3)",
    radius: 18,
    blur: 20,
    glow: true,
  },
};

/** Built-in presets. A preset lists only what differs from the default; the rest falls back. */
export const PRESETS: ThemeDefinition[] = [
  DEFAULT_THEME,
  {
    version: 1,
    id: "simple",
    name: "Simple",
    light: {
      background: "#f4f5f7",
      surface: "rgba(255, 255, 255, 0.92)",
      surfaceStrong: "#ffffff",
      panel: "#ffffff",
      border: "rgba(14, 17, 22, 0.1)",
      shadow: "rgba(14, 17, 22, 0.06)",
      accent: "#2563eb",
      selection: "rgba(37, 99, 235, 0.22)",
      terminal: "#ffffff",
      radius: 10,
      blur: 0,
      glow: false,
    },
    dark: {
      background: "#16181d",
      text: "#eceef2",
      surface: "rgba(255, 255, 255, 0.06)",
      surfaceStrong: "#24272e",
      panel: "#1f2228",
      solid: "#2a2d35",
      border: "rgba(255, 255, 255, 0.1)",
      hairline: "rgba(255, 255, 255, 0.08)",
      shadow: "rgba(0, 0, 0, 0.35)",
      accent: "#3b82f6",
      selection: "rgba(59, 130, 246, 0.35)",
      terminal: "#111317",
      radius: 10,
      blur: 0,
      glow: false,
    },
  },
  {
    version: 1,
    id: "warm",
    name: "Warm",
    light: {
      background: "#faf6f0",
      text: "#2b2118",
      muted: "rgba(43, 33, 24, 0.58)",
      surface: "rgba(255, 252, 247, 0.6)",
      surfaceStrong: "rgba(255, 250, 243, 0.86)",
      panel: "rgba(255, 251, 246, 0.96)",
      solid: "#fffaf3",
      border: "rgba(255, 255, 255, 0.6)",
      hairline: "rgba(43, 33, 24, 0.08)",
      shadow: "rgba(120, 72, 20, 0.1)",
      accent: "#c2410c",
      glowA: "#fde3c4",
      glowB: "#fbd0c0",
      glowC: "#fef3c7",
      code: "rgba(43, 33, 24, 0.06)",
      terminal: "#fdf9f3",
      terminalText: "#2b2118",
      selection: "rgba(194, 65, 12, 0.22)",
      inverse: "#fffaf3",
      radius: 20,
    },
    dark: {
      background: "#211a15",
      text: "#f6ede4",
      muted: "rgba(246, 237, 228, 0.6)",
      surface: "rgba(255, 240, 225, 0.08)",
      surfaceStrong: "rgba(52, 42, 35, 0.9)",
      panel: "rgba(52, 42, 35, 0.97)",
      solid: "#3a2f27",
      border: "rgba(255, 240, 225, 0.14)",
      hairline: "rgba(255, 240, 225, 0.1)",
      accent: "#f0a46b",
      glowA: "#5a3418",
      glowB: "#5c1f2a",
      glowC: "#4a3c12",
      terminal: "#17120e",
      terminalText: "#f1e6da",
      selection: "rgba(240, 164, 107, 0.35)",
      inverse: "#211a15",
      radius: 20,
    },
  },
  // The four below bring a backdrop; their backgrounds are the artwork's own ground color, so the
  // page looks the same before the frame loads and with the glow switched off.
  {
    version: 1,
    id: "orbit",
    name: "Orbit",
    backdrop: "orbit",
    light: { background: "#d3d2f6", accent: "#5550b8", selection: "rgba(85, 80, 184, 0.24)" },
    dark: {
      background: "#04050e",
      surfaceStrong: "rgba(20, 24, 46, 0.88)",
      panel: "rgba(20, 24, 46, 0.97)",
      solid: "#1c2140",
      accent: "#93a4ff",
      selection: "rgba(147, 164, 255, 0.35)",
    },
  },
  {
    version: 1,
    id: "northern",
    name: "Northern Lights",
    backdrop: "northern",
    light: { background: "#f3f1fa", accent: "#0b7fc9", selection: "rgba(11, 127, 201, 0.22)" },
    dark: {
      background: "#040816",
      surfaceStrong: "rgba(16, 24, 44, 0.88)",
      panel: "rgba(16, 24, 44, 0.97)",
      solid: "#182540",
      accent: "#4be3a8",
      selection: "rgba(75, 227, 168, 0.3)",
    },
  },
  {
    version: 1,
    id: "papercut",
    name: "Paper Cut",
    backdrop: "papercut",
    light: { background: "#f8f5ef", accent: "#4d79de", selection: "rgba(77, 121, 222, 0.24)" },
    dark: {
      background: "#1a2337",
      surfaceStrong: "rgba(30, 40, 62, 0.88)",
      panel: "rgba(30, 40, 62, 0.97)",
      solid: "#26324c",
      accent: "#7cc4ea",
      selection: "rgba(124, 196, 234, 0.32)",
    },
  },
  {
    version: 1,
    id: "prism",
    name: "Prism",
    backdrop: "prism",
    light: { background: "#e6e8ed", accent: "#7257ff", selection: "rgba(114, 87, 255, 0.22)" },
    dark: {
      background: "#12141c",
      surfaceStrong: "rgba(28, 31, 44, 0.88)",
      panel: "rgba(28, 31, 44, 0.97)",
      solid: "#242838",
      accent: "#a394ff",
      selection: "rgba(163, 148, 255, 0.35)",
    },
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export const defaultPreferences = (mode: Mode = "system"): ThemePreferences => ({ version: 1, mode, presetId: DEFAULT_THEME.id, overrides: { light: {}, dark: {} } });

// ---- colors ---------------------------------------------------------------------------------

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

/** Hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb()/rgba() with comma-separated numbers; nothing else. */
export function parseColor(s: unknown): Rgba | null {
  if (typeof s !== "string" || s.length > 40) return null;
  const v = s.trim();
  const h = HEX.exec(v)?.[1];
  if (h) {
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  const m = RGB.exec(v);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (r > 255 || g > 255 || b > 255 || !(a >= 0 && a <= 1)) return null;
  return { r, g, b, a };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
/** `#rrggbb` when opaque, else `rgba(r, g, b, a)`. */
export function formatColor({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/** The color as `#rrggbb`, ignoring alpha (what an <input type="color"> takes). */
export const toHex = (s: string) => {
  const c = parseColor(s);
  return c ? formatColor({ ...c, a: 1 }) : "#000000";
};

export function withAlpha(s: string, a: number): string {
  const c = parseColor(s);
  return c ? formatColor({ ...c, a: Math.min(1, Math.max(0, a)) }) : s;
}

export const alphaOf = (s: string) => parseColor(s)?.a ?? 1;

/** Relative luminance (WCAG) of the opaque color. */
export function luminance(s: string): number {
  const c = parseColor(s);
  if (!c) return 0;
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** White or near-black, whichever reads better on the color. */
export const contrastOn = (s: string) => (luminance(s) > 0.4 ? "#0e1116" : "#ffffff");

// ---- validation -----------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One problem found in stored or imported data; the settings translate `code` (i18n `themeIssue.*`). */
export type IssueCode = "notJson" | "tooLarge" | "wrongFormat" | "version" | "notObject" | "unknownField" | "notColor" | "notNumber" | "notBoolean" | "notMode" | "unknownPreset";
export type Issue = { code: IssueCode; path?: string; min?: number; max?: number };

/** Checks a token set; known, valid fields are kept, everything else is reported in `issues`. */
export function validateTokens(raw: unknown, where: string, allowAlpha: boolean): { tokens: Overrides; issues: Issue[] } {
  const tokens: Overrides = {};
  const issues: Issue[] = [];
  if (raw === undefined) return { tokens, issues };
  if (!isObj(raw)) return { tokens, issues: [{ code: "notObject", path: where }] };
  for (const [k, v] of Object.entries(raw)) {
    const path = `${where}.${k}`;
    if (k in COLOR_VARS) {
      const c = parseColor(v);
      if (c) tokens[k as ColorToken] = formatColor(c);
      else issues.push({ code: "notColor", path });
    } else if (k in NUMBER_BOUNDS) {
      const [min, max] = NUMBER_BOUNDS[k as NumberToken];
      if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) tokens[k as NumberToken] = v;
      else issues.push({ code: "notNumber", path, min, max });
    } else if (k === "glow") {
      if (typeof v === "boolean") tokens.glow = v;
      else issues.push({ code: "notBoolean", path });
    } else if (k === "surfaceAlpha" && allowAlpha) {
      if (typeof v === "number" && v >= 0 && v <= 1) tokens.surfaceAlpha = v;
      else issues.push({ code: "notNumber", path, min: 0, max: 1 });
    } else issues.push({ code: "unknownField", path });
  }
  return { tokens, issues };
}

/**
 * Checks stored or imported preferences. The result is always usable: invalid parts fall back to
 * the default and are listed in `issues`. A wrong version replaces everything with the default.
 */
export function validatePreferences(raw: unknown, extraKeys: string[] = []): { prefs: ThemePreferences; issues: Issue[] } {
  if (!isObj(raw)) return { prefs: defaultPreferences(), issues: [{ code: "notObject" }] };
  if (raw.version !== PREFS_VERSION) return { prefs: defaultPreferences(), issues: [{ code: "version", path: "version" }] };
  const issues: Issue[] = [];
  const prefs = defaultPreferences();
  for (const k of Object.keys(raw)) if (!["version", "mode", "presetId", "overrides", ...extraKeys].includes(k)) issues.push({ code: "unknownField", path: k });
  if (raw.mode === "system" || raw.mode === "light" || raw.mode === "dark") prefs.mode = raw.mode;
  else if (raw.mode !== undefined) issues.push({ code: "notMode", path: "mode" });
  if (typeof raw.presetId === "string" && presetById(raw.presetId)) prefs.presetId = raw.presetId;
  else if (raw.presetId !== undefined) issues.push({ code: "unknownPreset", path: "presetId" });
  if (raw.overrides !== undefined) {
    if (!isObj(raw.overrides)) issues.push({ code: "notObject", path: "overrides" });
    else
      for (const [k, v] of Object.entries(raw.overrides)) {
        if (k !== "light" && k !== "dark") {
          issues.push({ code: "unknownField", path: `overrides.${k}` });
          continue;
        }
        const r = validateTokens(v, `overrides.${k}`, true);
        prefs.overrides[k] = r.tokens;
        issues.push(...r.issues);
      }
  }
  return { prefs, issues };
}

// ---- resolution -----------------------------------------------------------------------------

export const resolveScheme = (mode: Mode, systemDark: boolean): Scheme => (mode === "system" ? (systemDark ? "dark" : "light") : mode);

/** One layer over the resolved tokens; a layer that sets the accent but not its companions moves them along. */
function layer(base: ResolvedTokens, l: Overrides): ResolvedTokens {
  const out = { ...base };
  for (const k of COLOR_TOKENS) if (l[k] !== undefined && parseColor(l[k])) out[k] = l[k]!;
  for (const k of Object.keys(NUMBER_BOUNDS) as NumberToken[]) if (typeof l[k] === "number") out[k] = l[k]!;
  if (typeof l.glow === "boolean") out.glow = l.glow;
  if (l.accent !== undefined && parseColor(l.accent)) {
    if (l.link === undefined) out.link = l.accent;
    if (l.focus === undefined) out.focus = l.accent;
    if (l.onAccent === undefined) out.onAccent = contrastOn(l.accent);
  }
  if (typeof l.surfaceAlpha === "number") out.surface = withAlpha(out.surface, l.surfaceAlpha);
  return out;
}

/** Default tokens, then the preset's for the scheme, then the operator's overrides for the scheme. */
export function resolveTokens(prefs: ThemePreferences, scheme: Scheme): ResolvedTokens {
  const preset = presetById(prefs.presetId) ?? DEFAULT_THEME;
  return layer(layer({ ...DEFAULT_THEME[scheme] }, preset[scheme]), prefs.overrides[scheme] ?? {});
}

/** The custom properties that put resolved tokens on the page. */
export function toCssVars(t: ResolvedTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const k of COLOR_TOKENS) vars[COLOR_VARS[k]] = t[k];
  vars["--radius"] = `${t.radius}px`;
  vars["--blur"] = `${t.blur}px`;
  vars["--glow-opacity"] = t.glow ? "0.55" : "0";
  return vars;
}

/** The backdrop to frame behind the page: the preset's, while the resolved glow is on. */
export const backdropOf = (prefs: ThemePreferences, t: ResolvedTokens): string | undefined => (t.glow ? presetById(prefs.presetId)?.backdrop : undefined);

export const hasOverrides = (p: ThemePreferences) => Object.keys(p.overrides.light).length > 0 || Object.keys(p.overrides.dark).length > 0;

export const samePreferences = (a: ThemePreferences, b: ThemePreferences) => JSON.stringify(a) === JSON.stringify(b);

// ---- persistence ----------------------------------------------------------------------------

export type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Why the stored appearance was not used as is; the settings offer a reset. */
export type LoadProblem = { issues: Issue[] };

/**
 * Reads the saved preferences: the versioned key, else the legacy light/dark switch (migrated and
 * removed), else the default (system mode). Unreadable data yields the default plus a problem.
 */
export function loadPreferences(kv: KV | null): { prefs: ThemePreferences; problem: LoadProblem | null } {
  if (!kv) return { prefs: defaultPreferences(), problem: null };
  let raw: string | null;
  try {
    raw = kv.getItem(STORAGE_KEY);
  } catch {
    return { prefs: defaultPreferences(), problem: null };
  }
  if (raw === null) {
    let legacy: string | null = null;
    try {
      legacy = kv.getItem(LEGACY_KEY);
    } catch {
      /* unavailable */
    }
    if (legacy !== "light" && legacy !== "dark") return { prefs: defaultPreferences(), problem: null };
    const prefs = defaultPreferences(legacy);
    if (savePreferences(kv, prefs)) {
      try {
        kv.removeItem(LEGACY_KEY);
      } catch {
        /* kept; the new key wins from now on */
      }
    }
    return { prefs, problem: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { prefs: defaultPreferences(), problem: { issues: [{ code: "notJson" }] } };
  }
  const { prefs, issues } = validatePreferences(parsed);
  return { prefs, problem: issues.length ? { issues } : null };
}

/** False when the browser refuses to store (private mode, quota, disabled storage). */
export function savePreferences(kv: KV | null, prefs: ThemePreferences): boolean {
  if (!kv) return false;
  try {
    kv.setItem(STORAGE_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

/** What index.html's inline script reads to paint the right colors before the bundle runs. */
export const bootRecord = (prefs: ThemePreferences) => {
  const light = resolveTokens(prefs, "light");
  const dark = resolveTokens(prefs, "dark");
  return { mode: prefs.mode, light: toCssVars(light), dark: toCssVars(dark), themeColor: { light: toHex(light.background), dark: toHex(dark.background) } };
};

// ---- import and export ----------------------------------------------------------------------

export function exportPreferences(prefs: ThemePreferences): string {
  return JSON.stringify({ format: EXPORT_FORMAT, version: PREFS_VERSION, mode: prefs.mode, presetId: prefs.presetId, overrides: prefs.overrides }, null, 2);
}

/** Strict: any unknown field, invalid color, out-of-range number or wrong version refuses the whole file. */
export function importPreferences(text: string): { ok: true; prefs: ThemePreferences } | { ok: false; issues: Issue[] } {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return { ok: false, issues: [{ code: "tooLarge", max: MAX_IMPORT_BYTES / 1024 }] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ code: "notJson" }] };
  }
  if (!isObj(raw) || raw.format !== EXPORT_FORMAT) return { ok: false, issues: [{ code: "wrongFormat" }] };
  const { prefs, issues } = validatePreferences(raw, ["format"]);
  return issues.length ? { ok: false, issues } : { ok: true, prefs };
}

// ---- the browser store ----------------------------------------------------------------------

export type Appearance = {
  /** What is stored. */
  saved: ThemePreferences;
  /** Unsaved edits shown as a live preview while the settings are open, else null. */
  draft: ThemePreferences | null;
  /** The stored data could not be read as is; the default (or what was valid) is in use. */
  problem: LoadProblem | null;
  /** The scheme in effect and its tokens, for the draft when there is one. */
  scheme: Scheme;
  resolved: ResolvedTokens;
};

const storage = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const systemQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);

let state: Appearance | null = null;
const listeners = new Set<() => void>();

function compute(saved: ThemePreferences, draft: ThemePreferences | null, problem: LoadProblem | null): Appearance {
  const active = draft ?? saved;
  const scheme = resolveScheme(active.mode, systemQuery()?.matches ?? false);
  return { saved, draft, problem, scheme, resolved: resolveTokens(active, scheme) };
}

function paint(a: Appearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(toCssVars(a.resolved))) root.style.setProperty(k, v);
  root.dataset.theme = a.scheme;
  // styles.css gives labels on the open field a halo while artwork is behind them.
  const backdrop = backdropOf(a.draft ?? a.saved, a.resolved);
  if (backdrop) root.dataset.backdrop = backdrop;
  else delete root.dataset.backdrop;
  root.style.colorScheme = a.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", toHex(a.resolved.background));
}

function set(next: Appearance) {
  state = next;
  paint(next);
  for (const l of listeners) l();
}

/** Loads, paints and starts listening; main.tsx calls it before the first render. Idempotent. */
export function initAppearance(): Appearance {
  if (state) return state;
  const kv = storage();
  const { prefs, problem } = loadPreferences(kv);
  if (problem) console.warn("panel appearance unreadable, using defaults:", problem.issues);
  set(compute(prefs, null, problem));
  // Only system mode follows the OS; a fixed mode ignores the change.
  systemQuery()?.addEventListener("change", () => {
    if (state && (state.draft ?? state.saved).mode === "system") set(compute(state.saved, state.draft, state.problem));
  });
  // Another tab saved: take its preferences; an open draft here stays on screen.
  if (typeof window !== "undefined")
    window.addEventListener("storage", (e) => {
      if (e.key !== STORAGE_KEY && e.key !== null) return;
      const r = loadPreferences(storage());
      if (state) set(compute(r.prefs, state.draft, r.problem));
    });
  writeBoot(prefs);
  return state!;
}

function writeBoot(prefs: ThemePreferences) {
  try {
    storage()?.setItem(BOOT_KEY, JSON.stringify(bootRecord(prefs)));
  } catch {
    /* the next load paints after the bundle runs instead */
  }
}

/** Shows `draft` as a live preview without saving; null drops it and shows what is saved. */
export function previewAppearance(draft: ThemePreferences | null) {
  const s = state ?? initAppearance();
  set(compute(s.saved, draft, s.problem));
}

/** Saves and applies; false when the browser would not store it (it still applies for this page). */
export function saveAppearance(prefs: ThemePreferences): boolean {
  const ok = savePreferences(storage(), prefs);
  if (ok) writeBoot(prefs);
  set(compute(prefs, null, ok ? null : (state?.problem ?? null)));
  return ok;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state ?? initAppearance();

/** The current appearance, re-rendering on every change (preview, save, other tab, OS scheme). */
export const useAppearance = (): Appearance => useSyncExternalStore(subscribe, snapshot);

/** For non-React code (the terminal): called with every change. */
export function onAppearance(fn: (a: Appearance) => void): () => void {
  const l = () => state && fn(state);
  listeners.add(l);
  return () => listeners.delete(l);
}
export const currentAppearance = () => snapshot();
