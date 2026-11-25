import { activePrices } from "../prices/book.ts";
import type { Price } from "./types.ts";

/**
 * What a speech call costs (docs/speech.md#prices): ASR per minute of audio, TTS per million characters,
 * in USD. The provider's own `price:` wins; otherwise the list price of the vendor whose own API the
 * provider's URL is (OpenAI's api.openai.com, MiniMax's api.minimax.io), from the price book
 * (docs/prices.md): a self-hosted server may serve a model under the same name for nothing.
 */

/** The price that applies to one provider's models, or undefined when none does. */
export function priceFor(opts: { url: string; asrModel: string; ttsModel: string; price?: Price }): Price | undefined {
  if (opts.price) return opts.price;
  let host = "";
  try {
    host = new URL(opts.url).hostname;
  } catch {
    return undefined;
  }
  const book = activePrices();
  const vendor = book.vendorAt(host);
  if (!vendor) return undefined;
  const transcribe = book.forVendor(vendor, opts.asrModel)?.price.perMinute;
  const speak = book.forVendor(vendor, opts.ttsModel)?.price.perMillionChars;
  if (transcribe === undefined && speak === undefined) return undefined;
  return { ...(transcribe !== undefined ? { transcribePerMinute: transcribe } : {}), ...(speak !== undefined ? { speakPerMillionChars: speak } : {}) };
}

/** MiniMax's list prices on the host they are listed for (its international site); the same lookup. */
export const minimaxPriceFor = priceFor;

/** USD for one call's figures, rounded to a millionth; undefined without the price or the figure. */
export function costOf(price: Price | undefined, capability: string, figures: { audioSeconds?: number; chars?: number }): number | undefined {
  if (!price) return undefined;
  const usd =
    capability === "speak" ? (price.speakPerMillionChars !== undefined && figures.chars !== undefined ? (figures.chars / 1_000_000) * price.speakPerMillionChars : undefined)
    : price.transcribePerMinute !== undefined && figures.audioSeconds !== undefined ? (figures.audioSeconds / 60) * price.transcribePerMinute
    : undefined;
  return usd === undefined ? undefined : Math.round(usd * 1e6) / 1e6;
}
