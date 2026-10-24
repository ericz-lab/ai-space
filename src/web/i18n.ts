import { createContext, useContext, useMemo } from "react";

import { LANGS, MESSAGES, translate, type Key, type Lang, type Vars } from "./messages.ts";

export { LANGS, LOCALE, MESSAGES, translate, type Key, type Lang, type Vars } from "./messages.ts";

/**
 * The panel's language in React (see docs/i18n.md); the dictionaries live in messages.ts. Manifest
 * text (app, agent and widget titles) is chosen with `localized` from the `i18n` field the API sends
 * next to the plain field.
 */

const STORAGE_KEY = "panel-lang";

const isLang = (s: unknown): s is Lang => LANGS.some((l) => l.code === s);
const primary = (tag: string) => tag.split("-")[0]?.toLowerCase() ?? "";

/** The first of the browser's languages the panel has a dictionary for; English otherwise. */
export function detectLang(tags: readonly string[]): Lang {
  for (const tag of tags) {
    const p = primary(tag);
    if (isLang(p)) return p;
  }
  return "en";
}

/** The saved preference, else the browser's languages. Works without localStorage. */
export function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* no storage: detect on every load */
  }
  return detectLang(typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* no storage: the choice lasts for this page */
  }
}

/** Translations the API sends next to a plain `title` / `description`, by language tag. */
export type I18n = Record<string, { title?: string; description?: string }>;

/**
 * Manifest text in `lang`: the `i18n` entry for that tag, else one whose primary tag matches
 * (`zh-Hant` for `zh`), else the plain field.
 */
export function localized<T extends { title: string; description?: string; i18n?: I18n }>(lang: Lang, x: T): { title: string; description?: string } {
  const i18n = x.i18n ?? {};
  const entry = i18n[lang] ?? Object.entries(i18n).find(([tag]) => primary(tag) === lang)?.[1];
  const description = entry?.description ?? x.description;
  return { title: entry?.title ?? x.title, ...(description !== undefined ? { description } : {}) };
}

/**
 * Everything a search should find a manifest entry by, whatever language the panel is in: the plain
 * title and description and every translation of them. A reader who knows an app by its English name
 * finds it from a Chinese panel and the other way round.
 */
export function searchText(x: { title: string; description?: string; i18n?: I18n }): string {
  const texts = [x.title, x.description, ...Object.values(x.i18n ?? {}).flatMap((e) => [e.title, e.description])];
  return [...new Set(texts.filter(Boolean))].join(" ");
}

/** A panel string in every language, for searching the panel's own entries the same way. */
export function searchKeyText(...keys: Key[]): string {
  return [...new Set(keys.flatMap((key) => LANGS.map(({ code }) => MESSAGES[code][key])))].join(" ");
}

/**
 * An app URL with the `{lang}` placeholder filled (app-spec.md: an app opts in to the panel's language
 * by putting it in its `url` query). `%7Blang%7D` is the same placeholder after URL normalisation.
 */
export function withLang(url: string, lang: Lang): string {
  return url.replaceAll("{lang}", lang).replaceAll("%7Blang%7D", lang);
}

export const LangContext = createContext<Lang>("en");

/** The current language and a bound `t`. Components re-render when the provider's value changes. */
export function useLang() {
  const lang = useContext(LangContext);
  return useMemo(() => ({ lang, t: (key: Key, vars?: Vars) => translate(lang, key, vars) }), [lang]);
}
