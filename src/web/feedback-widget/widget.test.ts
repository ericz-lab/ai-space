import { describe, expect, test } from "bun:test";
import { buildFeedbackScript } from "./build.ts";
import { base64Of, clampPosition, pageTheme, stableClasses } from "./capture.ts";
import { pageLang, tr } from "./i18n.ts";

/** Just enough of an element for pageTheme. */
const node = (attrs: Record<string, string> = {}, classes: string[] = []) => ({ getAttribute: (n: string) => attrs[n] ?? null, classList: { contains: (c: string) => classes.includes(c) } });
const doc = (html: ReturnType<typeof node>, body: ReturnType<typeof node> | null = node()) => ({ documentElement: html, body }) as unknown as Document;
const win = (dark: boolean) => ({ matchMedia: () => ({ matches: dark }) }) as unknown as Window;

describe("capture", () => {
  test("the page's theme: its own attribute or class, else the system's", () => {
    expect(pageTheme(doc(node({ "data-theme": "dark" })), win(false))).toBe("dark");
    expect(pageTheme(doc(node(), node({}, ["dark"])), win(false))).toBe("dark");
    expect(pageTheme(doc(node({ "data-color-scheme": "light" })), win(true))).toBe("light");
    expect(pageTheme(doc(node({ "data-theme": "system" }), null), win(true))).toBe("dark");
    expect(pageTheme(doc(node()), win(false))).toBe("light");
  });

  test("selectors keep readable classes, not generated ones", () => {
    expect(stableClasses(["add-task", "css-1x2y3z", "_a1b2", "sc-AxjAm", "btn", "primary"])).toEqual(["add-task", "btn"]);
    expect(stableClasses(["Button123", "jsx-2948"])).toEqual([]);
  });

  test("the button stays inside the window", () => {
    expect(clampPosition({ right: -50, bottom: 9999 }, 36, 375, 812)).toEqual({ right: 8, bottom: 812 - 36 - 8 });
    expect(clampPosition({ right: 16, bottom: 16 }, 44, 375, 812)).toEqual({ right: 16, bottom: 16 });
    expect(clampPosition({ right: 100, bottom: 100 }, 36, 20, 20)).toEqual({ right: 8, bottom: 8 });
  });

  test("a data URL's size", () => {
    expect(base64Of("data:image/png;base64,QUJD")).toEqual({ data: "QUJD", bytes: 3 });
    expect(base64Of("data:image/png;base64,QUI=")).toEqual({ data: "QUI=", bytes: 2 });
  });

  test("words in the page's language", () => {
    expect(pageLang({ documentElement: { lang: "zh-CN" } } as unknown as Document)).toBe("zh");
    expect(pageLang({ documentElement: { lang: "" } } as unknown as Document)).toBe("en");
    expect(tr("zh", "saved", { n: 312 })).toBe("已记到待办 #312");
    expect(tr("en", "button")).toBe("Feedback (Alt+Shift+F)");
  });
});

describe("bundle", () => {
  test("one small script, without server code", async () => {
    const { js, etag } = await buildFeedbackScript({ dev: false })();
    expect(js.length).toBeGreaterThan(5_000);
    expect(js.length).toBeLessThan(60_000);
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(js).not.toContain("Buffer");
    expect(js).not.toContain("bun:sqlite");
    expect(js).toContain("/_space/feedback");
    expect(js).toContain("attachShadow");
  });
});
