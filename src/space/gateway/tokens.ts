import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GatewayGrant } from "./types.ts";

/**
 * The tokens the built-in model gateway accepts (docs/model-gateway.md#who-may-call-it): ones
 * ai-space issued itself, to a Claude Code process it starts or to one of its own callers. A token
 * is `sgw-<run>.<mac>`: the run id is random per process or call and names its trace; the mac is an
 * HMAC of the run under a secret made at boot, so nothing is stored per token, and every token
 * dies with the process that issued it. An app's `SPACE_APP_TOKEN` is not one: apps keep using
 * `/api/model/*` and `/api/speech/*`, which own the ledgers.
 */

export const GATEWAY_TOKEN_PREFIX = "sgw-";
const RUN_PATTERN = /^[a-f0-9]{24}$/;

export class GatewayTokens {
  private readonly secret: Buffer;

  constructor(secret: Uint8Array = randomBytes(32)) {
    this.secret = Buffer.from(secret);
  }

  issue(): GatewayGrant {
    const run = randomBytes(12).toString("hex");
    return { run, token: `${GATEWAY_TOKEN_PREFIX}${run}.${this.mac(run)}` };
  }

  /** The run a token was issued for, or undefined when ai-space did not issue it in this boot. */
  verify(token: string): string | undefined {
    if (!token.startsWith(GATEWAY_TOKEN_PREFIX)) return undefined;
    const [run, mac] = token.slice(GATEWAY_TOKEN_PREFIX.length).split(".");
    if (!run || !mac || !RUN_PATTERN.test(run)) return undefined;
    const want = Buffer.from(this.mac(run));
    const got = Buffer.from(mac);
    return got.length === want.length && timingSafeEqual(got, want) ? run : undefined;
  }

  private mac(run: string): string {
    return createHmac("sha256", this.secret).update(run).digest("base64url");
  }
}
