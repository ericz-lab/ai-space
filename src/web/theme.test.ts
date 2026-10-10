import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BOOT_KEY,
  COLOR_VARS,
  DEFAULT_THEME,
  type KV,
  LEGACY_KEY,
  MAX_IMPORT_BYTES,
  PRESETS,
  backdropOf,
  STORAGE_KEY,
  bootRecord,
  contrastOn,
  defaultPreferences,
  exportPreferences,
  importPreferences,
  loadPreferences,
  parseColor,
  resolveScheme,
  resolveTokens,
  savePreferences,
  toCssVars,
  validatePreferences,
} from "./theme.ts";

const memory = (init: Record<string, string> = {}): KV & { data: Record<string, string> } => {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
};
const broken: KV = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {},
};

describe("colors", () => {
  test("accepts hex and rgb()/rgba() only", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#6366f1")).toEqual({ r: 99, g: 102, b: 241, a: 1 });
    expect(parseColor("rgba(14, 17, 22, .55)")).toEqual({ r: 14, g: 17, b: 22, a: 0.55 });
    expect(parseColor("#00000080")?.a).toBeCloseTo(0.502, 3);
    for (const bad of ["red", "#12", "rgb(256, 0, 0)", "rgba(0,0,0,2)", "url(x)", "#fff; background:url(x)", "var(--x)", 12, null, "#" + "a".repeat(60)]) expect(parseColor(bad)).toBeNull();
  });

  test("picks a readable color on an accent", () => {
    expect(contrastOn("#1d4ed8")).toBe("#ffffff");
    expect(contrastOn("#fde68a")).toBe("#0e1116");
  });
});

describe("default preset mirrors styles.css", () => {
  const css = require("node:fs").readFileSync(join(import.meta.dir, "styles.css"), "utf8") as string;
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf("\n}", start));
    return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
  };
  const light = block(":root");
  const dark = { ...light, ...block(':root[data-theme="dark"]') };

  test.each([
    ["light", light],
    ["dark", dark],
  ] as const)("%s", (scheme, vars) => {
    const resolved = toCssVars(resolveTokens(defaultPreferences(), scheme));
    for (const [k, v] of Object.entries(resolved)) expect(vars[k], `${scheme} ${k}`).toBe(v);
  });
});

describe("resolution", () => {
  test("system mode follows the OS, fixed modes ignore it", () => {
    expect(resolveScheme("system", true)).toBe("dark");
    expect(resolveScheme("system", false)).toBe("light");
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
  });

  test("default, then preset, then overrides for the scheme in effect", () => {
    const prefs = { ...defaultPreferences(), presetId: "warm", overrides: { light: { radius: 4 }, dark: { background: "#000000" } } };
    const light = resolveTokens(prefs, "light");
    expect(light.radius).toBe(4);
    expect(light.background).toBe(PRESETS.find((p) => p.id === "warm")!.light.background!);
    // A token the preset does not list falls back to the default.
    expect(light.success).toBe(DEFAULT_THEME.light.success);
    expect(resolveTokens(prefs, "dark").background).toBe("#000000");
    expect(resolveTokens(prefs, "dark").radius).toBe(20);
  });

  test("an accent override moves link, focus and its contrast along", () => {
    const r = resolveTokens({ ...defaultPreferences(), overrides: { light: { accent: "#fde68a" }, dark: {} } }, "light");
    expect([r.accent, r.link, r.focus, r.onAccent]).toEqual(["#fde68a", "#fde68a", "#fde68a", "#0e1116"]);
  });

  test("surface opacity changes the alpha of the glass only", () => {
    const r = resolveTokens({ ...defaultPreferences(), overrides: { light: { surfaceAlpha: 0.2 }, dark: {} } }, "light");
    expect(r.surface).toBe("rgba(255, 255, 255, 0.2)");
    expect(r.surfaceStrong).toBe(DEFAULT_THEME.light.surfaceStrong);
  });

  test("every preset resolves every token in both schemes", () => {
    for (const p of PRESETS)
      for (const s of ["light", "dark"] as const) {
        const vars = toCssVars(resolveTokens({ ...defaultPreferences(), presetId: p.id }, s));
        for (const v of Object.values(COLOR_VARS)) expect(parseColor(vars[v]), `${p.id} ${s} ${v}`).not.toBeNull();
      }
  });

  test("a preset's backdrop shows while the glow is on, and its file is a public route", async () => {
    const { createWebRoutes } = await import("./routes.ts");
    const routes = createWebRoutes();
    for (const p of PRESETS) {
      const prefs = { ...defaultPreferences("dark"), presetId: p.id };
      expect(backdropOf(prefs, resolveTokens(prefs, "dark"))).toBe(p.backdrop);
      const off = { ...prefs, overrides: { light: {}, dark: { glow: false } } };
      expect(backdropOf(off, resolveTokens(off, "dark"))).toBeUndefined();
      if (!p.backdrop) continue;
      expect(routes[`/backdrops/${p.backdrop}.html`], p.id).toBeDefined();
      expect(await Bun.file(`${import.meta.dir}/public/backdrops/${p.backdrop}.html`).exists(), p.id).toBe(true);
    }
  });

  test("an unknown preset id falls back to the default", () => {
    expect(resolveTokens({ ...defaultPreferences(), presetId: "gone" }, "dark")).toEqual(DEFAULT_THEME.dark);
  });

  test("glow off sets the glow opacity to zero", () => {
    expect(toCssVars(resolveTokens({ ...defaultPreferences(), presetId: "simple" }, "light"))["--glow-opacity"]).toBe("0");
  });
});

describe("validation", () => {
  test("keeps valid parts and reports the rest", () => {
    const { prefs, issues } = validatePreferences({ version: 1, mode: "dusk", presetId: "warm", overrides: { light: { accent: "javascript:alert(1)", radius: 99, blur: 8, glow: "yes", extra: 1 }, sepia: {} } });
    expect(prefs.mode).toBe("system");
    expect(prefs.presetId).toBe("warm");
    expect(prefs.overrides.light).toEqual({ blur: 8 });
    expect(issues.map((i) => `${i.code} ${i.path}`).sort()).toEqual(
      ["notMode mode", "notColor overrides.light.accent", "notNumber overrides.light.radius", "notBoolean overrides.light.glow", "unknownField overrides.light.extra", "unknownField overrides.sepia"].sort(),
    );
  });

  test("a different version or shape is the default", () => {
    expect(validatePreferences({ version: 2, mode: "dark" })).toEqual({ prefs: defaultPreferences(), issues: [{ code: "version", path: "version" }] });
    expect(validatePreferences([]).issues[0]!.code).toBe("notObject");
  });

  test("colors are normalized", () => {
    expect(validatePreferences({ version: 1, overrides: { dark: { accent: "#ABC" } } }).prefs.overrides.dark.accent).toBe("#aabbcc");
  });
});

describe("persistence and migration", () => {
  test("nothing stored is the default in system mode", () => {
    expect(loadPreferences(memory())).toEqual({ prefs: defaultPreferences("system"), problem: null });
  });

  test("the legacy light/dark switch becomes a fixed mode and is removed", () => {
    const kv = memory({ [LEGACY_KEY]: "dark" });
    const { prefs, problem } = loadPreferences(kv);
    expect(problem).toBeNull();
    expect(prefs.mode).toBe("dark");
    expect(JSON.parse(kv.data[STORAGE_KEY]!)).toEqual(prefs);
    expect(kv.data[LEGACY_KEY]).toBeUndefined();
  });

  test("a garbage legacy value is ignored", () => {
    expect(loadPreferences(memory({ [LEGACY_KEY]: "blue" })).prefs.mode).toBe("system");
  });

  test("the versioned key wins over the legacy one", () => {
    const kv = memory({ [STORAGE_KEY]: JSON.stringify({ ...defaultPreferences("light"), presetId: "simple" }), [LEGACY_KEY]: "dark" });
    expect(loadPreferences(kv).prefs).toEqual({ ...defaultPreferences("light"), presetId: "simple" });
  });

  test("unreadable data is flagged and the default used", () => {
    expect(loadPreferences(memory({ [STORAGE_KEY]: "{oops" }))).toEqual({ prefs: defaultPreferences(), problem: { issues: [{ code: "notJson" }] } });
    expect(loadPreferences(memory({ [STORAGE_KEY]: '{"version":1,"presetId":"nope"}' })).problem?.issues[0]?.code).toBe("unknownPreset");
  });

  test("unavailable storage falls back without throwing", () => {
    expect(loadPreferences(broken).prefs).toEqual(defaultPreferences());
    expect(loadPreferences(null).prefs).toEqual(defaultPreferences());
    expect(savePreferences(broken, defaultPreferences())).toBe(false);
    expect(savePreferences(null, defaultPreferences())).toBe(false);
  });

  test("save then load is the same", () => {
    const kv = memory();
    const prefs = { ...defaultPreferences("dark"), presetId: "warm", overrides: { light: {}, dark: { accent: "#22c55e", glow: false } } };
    expect(savePreferences(kv, prefs)).toBe(true);
    expect(loadPreferences(kv)).toEqual({ prefs, problem: null });
  });

  test("the boot record holds both schemes for the inline script", () => {
    const boot = bootRecord({ ...defaultPreferences("system"), presetId: "warm" });
    expect(boot.mode).toBe("system");
    expect(boot.light["--bg"]).toBe("#faf6f0");
    expect(boot.dark["--bg"]).toBe("#211a15");
    expect(boot.themeColor).toEqual({ light: "#faf6f0", dark: "#211a15" });
    for (const k of [...Object.keys(boot.light), ...Object.keys(boot.dark)]) expect(k).toMatch(/^--[a-z0-9-]+$/);
    expect(BOOT_KEY).not.toBe(STORAGE_KEY);
  });
});

describe("import and export", () => {
  const prefs = { ...defaultPreferences("light"), presetId: "simple", overrides: { light: { accent: "#0ea5e9", radius: 6, surfaceAlpha: 0.4 }, dark: { glow: false } } };

  test("round trip", () => {
    expect(importPreferences(exportPreferences(prefs))).toEqual({ ok: true, prefs });
  });

  test("refuses the whole file on any problem", () => {
    const file = (patch: object) => JSON.stringify({ ...JSON.parse(exportPreferences(prefs)), ...patch });
    const codes = (text: string) => {
      const r = importPreferences(text);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes("not json")).toEqual(["notJson"]);
    expect(codes(JSON.stringify(prefs))).toEqual(["wrongFormat"]);
    expect(codes(file({ version: 9 }))).toEqual(["version"]);
    expect(codes(file({ css: "body{display:none}" }))).toEqual(["unknownField"]);
    expect(codes(file({ overrides: { light: { background: "url(https://x/y.png)" } } }))).toEqual(["notColor"]);
    expect(codes(file({ overrides: { dark: { blur: -1 } } }))).toEqual(["notNumber"]);
    expect(codes(file({ presetId: "../../etc" }))).toEqual(["unknownPreset"]);
    expect(codes(file({ pad: "x".repeat(MAX_IMPORT_BYTES) }))).toEqual(["tooLarge"]);
  });
});
