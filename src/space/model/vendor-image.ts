import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { sniffImage } from "./images.ts";

/**
 * A picture a model provider answered with as a URL instead of base64 (Zhipu, Z.ai and others
 * answer only that way; docs/model.md#images). ai-space fetches it, which `images.ts` otherwise
 * never does, so only under these rules, each enforced here and tested in vendor-image.test.ts:
 *
 * - the URL comes from the vendor's answer to a picture request ai-space made through the
 *   built-in model gateway (`runImage` in runtimes/anthropic-api.ts), never from a caller's
 *   request: no route takes an image URL;
 * - https on port 443 only, no credentials in it;
 * - the host resolves only to public addresses: one loopback, private, link-local (the cloud
 *   metadata address among them), carrier-grade NAT, multicast or reserved address anywhere in the
 *   answer refuses the URL, and IPv4 inside IPv6 (mapped, NAT64) is checked as IPv4;
 * - the connection goes to the address that was checked, with the host name kept for TLS (SNI and
 *   the certificate check) and `Host`, so a second DNS answer cannot move it elsewhere;
 * - no redirect is followed;
 * - at most `MAX_BYTES`, within `TIMEOUT_MS`;
 * - the bytes must sniff as png, jpeg, gif or webp.
 *
 * No header of the request that made the picture is sent: the gateway's token stays with ai-space.
 */

export const VENDOR_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VENDOR_IMAGE_TIMEOUT_MS = 30_000;

export type VendorImageDeps = {
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
};

export type VendorImage = { ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string };

function v4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : undefined;
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, the metadata address 169.254.169.254
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a! >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** The eight 16-bit groups of an IPv6 address (with an embedded IPv4 tail), or undefined. */
function v6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const four = v4(tail[1]!);
    if (!four) return undefined;
    s = s.slice(0, -tail[1]!.length) + `${((four[0]! << 8) | four[1]!).toString(16)}:${((four[2]! << 8) | four[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return undefined;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

/** Whether an address may be fetched from: a public unicast address, IPv4 or IPv6. */
export function isPublicAddress(ip: string): boolean {
  const four = v4(ip);
  if (four) return publicV4(four);
  const g = v6(ip);
  if (!g) return false;
  const [a, b, , , , f, x, y] = g as [number, number, number, number, number, number, number, number];
  const zeros = (n: number) => g.slice(0, n).every((v) => v === 0);
  if (zeros(8)) return false; // ::
  if (zeros(7) && y === 1) return false; // ::1
  const embedded = [x >> 8, x & 255, y >> 8, y & 255];
  if (zeros(5) && f === 0xffff) return publicV4(embedded); // ::ffff:a.b.c.d
  if (zeros(6)) return false; // ::a.b.c.d (deprecated compatible)
  if (a === 0x64 && b === 0xff9b) return publicV4(embedded); // NAT64 64:ff9b::/96 (and the local-use /48)
  if ((a & 0xfe00) === 0xfc00) return false; // unique local fc00::/7 (fd00:ec2::254, a metadata address, among them)
  if ((a & 0xffc0) === 0xfe80) return false; // link-local
  if ((a & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x0100 && zeros(4)) return false; // discard-only 100::/64
  if (a === 0x2002) return publicV4([b >> 8, b & 255, g[2]! >> 8, g[2]! & 255]); // 6to4 carries an IPv4
  return true;
}

/** Fetch a picture the vendor's answer named, under the rules above. */
export async function fetchVendorImage(raw: string, deps: VendorImageDeps = {}): Promise<VendorImage> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "the provider's image URL is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "the provider's image URL is not https" };
  if (url.username || url.password) return { ok: false, error: "the provider's image URL carries credentials" };
  if (url.port && url.port !== "443") return { ok: false, error: "the provider's image URL is not on port 443" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await (deps.lookup ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true })))(host)).map((a) => a.address);
    } catch (e) {
      return { ok: false, error: `the provider's image host did not resolve: ${(e as Error).message}` };
    }
  }
  if (!addresses.length) return { ok: false, error: "the provider's image host did not resolve" };
  const bad = addresses.find((a) => !isPublicAddress(a));
  if (bad) return { ok: false, error: `the provider's image host resolves to a non-public address (${bad}); not fetched` };
  const ip = addresses[0]!;
  const pinned = `https://${isIP(ip) === 6 ? `[${ip}]` : ip}${url.pathname}${url.search}`;
  const named = !isIP(host);
  const max = deps.maxBytes ?? VENDOR_IMAGE_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? VENDOR_IMAGE_TIMEOUT_MS;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(pinned, {
      method: "GET",
      redirect: "manual",
      headers: { host: url.host, accept: "image/*" },
      signal: AbortSignal.timeout(timeoutMs),
      ...(named ? { tls: { serverName: host, checkServerIdentity: (_: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, cert) } } : {}),
    } as RequestInit);
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "TimeoutError" ? `fetching the provider's image timed out after ${Math.round(timeoutMs / 1000)}s` : `fetching the provider's image failed: ${err.message}` };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, error: `the provider's image URL redirects (HTTP ${res.status}); redirects are not followed` };
  if (!res.ok) return { ok: false, error: `fetching the provider's image answered HTTP ${res.status}` };
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return { ok: false, error: `the provider's image is larger than ${max} bytes` };
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: "the provider's image answer has no body" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: `the provider's image is larger than ${max} bytes` };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, error: `reading the provider's image failed: ${(e as Error).message}` };
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const type = sniffImage(bytes);
  if (!type) return { ok: false, error: "the provider's image URL did not answer a png, jpeg, gif or webp image" };
  return { ok: true, bytes, type };
}
