import table from "./prices.json";
import type { Price } from "./types.ts";

/**
 * What a speech call costs (docs/speech.md#prices): ASR per minute of audio, TTS per million characters,
 * in USD. The provider's own `price:` wins; OpenAI's list prices apply only to OpenAI's own host, since
 * a self-hosted server may serve a model under the same name for nothing.
 */

type Table = { asOf: string; transcribePerMinute: Record<string, number>; speakPerMillionChars: Record<string, number> };
export const SPEECH_PRICES = table as Table & { minimax: Table & { hosts: string[] } };

/** The host whose models the built-in table prices. */
export const OPENAI_HOST = "api.openai.com";

/** The price that applies to one provider's models, or undefined when none does. */
export function priceFor(opts: { url: string; asrModel: string; ttsModel: string; price?: Price }): Price | undefined {
  if (opts.price) return opts.price;
  let host = "";
  try {
    host = new URL(opts.url).hostname;
  } catch {
    return undefined;
  }
  if (host !== OPENAI_HOST) return undefined;
  const transcribe = SPEECH_PRICES.transcribePerMinute[bareModel(opts.asrModel)];
  const speak = SPEECH_PRICES.speakPerMillionChars[bareModel(opts.ttsModel)];
  if (transcribe === undefined && speak === undefined) return undefined;
  return { ...(transcribe !== undefined ? { transcribePerMinute: transcribe } : {}), ...(speak !== undefined ? { speakPerMillionChars: speak } : {}) };
}

/** A dated snapshot id (`gpt-4o-transcribe-2025-03-20`) is priced as its base model. */
function bareModel(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/** USD for one call's figures, rounded to a millionth; undefined without the price or the figure. */
export function costOf(price: Price | undefined, capability: string, figures: { audioSeconds?: number; chars?: number }): number | undefined {
  if (!price) return undefined;
  const usd =
    capability === "speak" ? (price.speakPerMillionChars !== undefined && figures.chars !== undefined ? (figures.chars / 1_000_000) * price.speakPerMillionChars : undefined)
    : price.transcribePerMinute !== undefined && figures.audioSeconds !== undefined ? (figures.audioSeconds / 60) * price.transcribePerMinute
    : undefined;
  return usd === undefined ? undefined : Math.round(usd * 1e6) / 1e6;
}

/** MiniMax's list prices, on the host they are listed for (its international site); undefined elsewhere. */
export function minimaxPriceFor(opts: { url: string; asrModel: string; ttsModel: string; price?: Price }): Price | undefined {
  if (opts.price) return opts.price;
  let host = "";
  try {
    host = new URL(opts.url).hostname;
  } catch {
    return undefined;
  }
  const t = SPEECH_PRICES.minimax;
  if (!t.hosts.includes(host)) return undefined;
  const transcribe = t.transcribePerMinute[opts.asrModel];
  const speak = t.speakPerMillionChars[opts.ttsModel];
  if (transcribe === undefined && speak === undefined) return undefined;
  return { ...(transcribe !== undefined ? { transcribePerMinute: transcribe } : {}), ...(speak !== undefined ? { speakPerMillionChars: speak } : {}) };
}
