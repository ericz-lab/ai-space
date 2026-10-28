import { dateTime, fmtDuration } from "./api.ts";
import { type Key, type Lang, translate } from "./messages.ts";

/**
 * A model call's fallback and trace as text (docs/model.md#trace), for the panel's Model usage
 * window and the Linux client's: no React, so both share it. The shapes are the ones
 * `GET /api/model/calls` sends (src/space/model/types.ts `CallTrace`).
 */

export type FailureKind = "credit" | "quota" | "rate" | "auth" | "transport" | "other";

export type CallTrace = {
  skippedLayers?: { source: string; model: string }[];
  candidates?: { model: string; later?: "resting" | "signed-out" | "unreachable" | "not-installed"; restKind?: FailureKind; until?: string; skipped?: string }[];
  tries: { runtime: string; machine?: string; model: string; ok: boolean; error?: string; kind?: FailureKind; ms: number; streamed?: boolean; served?: string }[];
  stop?: "answered" | "not-switched" | "streamed" | "no-time" | "exhausted" | "aborted";
};

const KINDS: ReadonlySet<string> = new Set(["credit", "quota", "rate", "auth", "transport", "other"]);

/** A failure cause in words: `quota` → "quota used up"; a kind this client does not know reads as other. */
export const failureText = (kind: string, lang: Lang): string => translate(lang, `failure.${KINDS.has(kind) ? kind : "other"}` as Key);

/** The call row's short note: `fallback from codex/basic · 2 tries`; empty for a call with one try and no fallback. */
export function fallbackNote(c: { fallbackFrom?: string; tries?: number }, lang: Lang): string {
  return [c.fallbackFrom ? translate(lang, "usage.fallbackFrom", { model: c.fallbackFrom }) : "", (c.tries ?? 0) > 1 ? translate(lang, "usage.tries", { n: c.tries! }) : ""].filter(Boolean).join(" · ");
}

const LATER: Record<string, Key> = { "signed-out": "runtimes.notSignedIn", unreachable: "runtimes.unreachable", "not-installed": "runtimes.notInstalled" };

/** The trace as lines, in the order it happened: the layers skipped, the candidates set aside, each try, why it stopped. */
export function traceLines(trace: CallTrace, lang: Lang): string[] {
  const t = (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars);
  const out: string[] = [];
  for (const l of trace.skippedLayers ?? []) out.push(t("trace.layerSkipped", { source: t(`appModels.source.${l.source}` as Key), model: l.model }));
  for (const c of trace.candidates ?? []) {
    if (c.skipped) out.push(t("trace.skipped", { model: c.model, reason: c.skipped }));
    else if (c.later) {
      const why = c.later === "resting" ? (c.restKind ? failureText(c.restKind, lang) : t("runtimes.limited")) : t(LATER[c.later] ?? "runtimes.limited");
      out.push(t("trace.later", { model: c.model, why: c.until ? `${why}, ${t("trace.until", { time: dateTime(c.until, lang) })}` : why }));
    }
  }
  trace.tries.forEach((x, i) => {
    const model = `${x.machine ? `${x.machine}:` : ""}${x.runtime}/${x.model}`;
    const time = fmtDuration(x.ms, lang);
    const line = x.ok ? t("trace.tryOk", { n: i + 1, model, time }) : t("trace.tryFailed", { n: i + 1, model, kind: failureText(x.kind ?? "other", lang), time });
    const extra = [x.streamed ? t("trace.streamed") : "", x.served ? t("trace.served", { model: x.served }) : ""].filter(Boolean);
    out.push(extra.length ? `${line} · ${extra.join(" · ")}` : line);
  });
  if (trace.stop && trace.stop !== "answered") out.push(t(`trace.stop.${trace.stop}` as Key));
  return out;
}
