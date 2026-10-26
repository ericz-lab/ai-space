// Relative URLs only: ai-space serves the app under an origin of its own.

// Every visible string, in Chinese and English (docs/app-spec.md#app-pages in ai-space). Add a key
// to both dictionaries; mark fixed text in index.html with data-i18n="key".
const MESSAGES = {
  en: {
    title: "My App",
    loading: "Loading…",
    ready: "My App is running. Server time: {time}",
    failed: "Could not load: {error}",
    language: "Language",
    theme_system: "Theme: system",
    theme_light: "Theme: light",
    theme_dark: "Theme: dark",
    themeNext: "click to change",
  },
  zh: {
    title: "My App",
    loading: "加载中…",
    ready: "My App 已在运行。服务器时间:{time}",
    failed: "没能加载:{error}",
    language: "语言",
    theme_system: "主题:跟随系统",
    theme_light: "主题:浅色",
    theme_dark: "主题:深色",
    themeNext: "点击切换",
  },
} as const;
type Lang = keyof typeof MESSAGES;
type Key = keyof (typeof MESSAGES)["en"];
type Theme = "system" | "light" | "dark";

const root = document.documentElement;
const save = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private mode: the choice lasts this visit */ }
};
// The inline script in index.html already chose both before the first paint.
let lang: Lang = root.lang.startsWith("zh") ? "zh" : "en";
let theme: Theme = (root.dataset.theme as Theme | undefined) ?? "system";
if (new URLSearchParams(location.search).get("lang")) save("my-app.lang", lang);

const t = (key: Key, vars: Record<string, string> = {}) =>
  MESSAGES[lang][key].replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

const ICONS: Record<Theme, string> = {
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
};

let message: { key: Key; time?: Date; error?: string } = { key: "loading" };

/** Draws every string in the current language and both controls in their current state. */
function paint() {
  root.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n as Key);
  const langs = document.querySelector<HTMLElement>("#langs")!;
  langs.setAttribute("aria-label", t("language"));
  for (const b of langs.querySelectorAll<HTMLElement>("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  const button = document.querySelector<HTMLButtonElement>("#theme")!;
  button.title = `${t(`theme_${theme}`)} (${t("themeNext")})`;
  button.setAttribute("aria-label", button.title);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[theme]}</svg>`;
  // Dates and numbers follow the page language too.
  const time = message.time ? message.time.toLocaleString(lang === "zh" ? "zh-CN" : "en") : "";
  document.querySelector("#message")!.textContent = t(message.key, { time, error: message.error ?? "" });
}

document.querySelector("#langs")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-lang]");
  if (!b) return;
  lang = b.dataset.lang as Lang;
  save("my-app.lang", lang);
  paint();
});
document.querySelector("#theme")!.addEventListener("click", () => {
  theme = ({ system: "light", light: "dark", dark: "system" } as const)[theme];
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  save("my-app.theme", theme);
  paint();
});
paint();

try {
  const res = await fetch("api/hello");
  const data = (await res.json()) as { time: string };
  message = { key: "ready", time: new Date(data.time) };
} catch (e) {
  message = { key: "failed", error: String((e as Error).message ?? e) };
}
paint();
