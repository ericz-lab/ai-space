import { bearer } from "../auth.ts";
import type { GatewayOperation, ModelGateway } from "./service.ts";

/**
 * The built-in model gateway's routes (docs/model-gateway.md#routes), under `/api/model-gateway`,
 * which is the base a child process gets (Claude Code appends `/v1/messages`):
 *
 *   POST /api/model-gateway/v1/messages               Anthropic Messages, JSON or SSE back as the provider sent it
 *   POST /api/model-gateway/v1/messages/count_tokens  the same base; a provider without it answers its own error
 *   GET  /api/model-gateway/v1/models                 provider/model ids and groups (OpenAI-style list)
 *   POST /api/model-gateway/v1/audio/speech           OpenAI audio, to a provider's openai base
 *   POST /api/model-gateway/v1/audio/transcriptions   multipart, as sent
 *   POST /api/model-gateway/v1/images/generations     OpenAI Images
 *   POST /api/model-gateway/v1/images/edits           multipart or JSON, as sent
 *
 * Policy `self` (docs/auth.md#access-policy): the routes check their own credential, a token
 * ai-space issued to a process it started or to one of its own callers (tokens.ts), presented as
 * `Authorization: Bearer` or `x-api-key`. Not the operator token, a session or an app's token:
 * apps call `/api/model/*` and `/api/speech/*`, which keep the ledgers. And only from loopback,
 * with no proxy in between (a request that came through the router or a tunnel carries its
 * forwarding headers and is refused).
 */

export const GATEWAY_PREFIX = "/api/model-gateway";

type Server = { requestIP?: (req: Request) => { address: string } | null } | undefined;

const MESSAGES: GatewayOperation = { base: "messages", path: "/v1/messages", usage: "messages", pin: true, errors: "anthropic" };
const COUNT: GatewayOperation = { base: "messages", path: "/v1/messages/count_tokens", usage: "none", pin: false, errors: "anthropic" };
const openai = (path: string, usage: GatewayOperation["usage"]): GatewayOperation => ({ base: "openai", path, usage, pin: false, errors: "openai" });

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const FORWARDED = ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"];

/** A request straight from this machine: a loopback peer and no proxy's forwarding headers. */
export function fromLoopback(req: Request, server: Server): boolean {
  if (FORWARDED.some((h) => req.headers.has(h))) return false;
  const ip = server?.requestIP?.(req)?.address;
  return ip !== undefined && LOOPBACK.test(ip);
}

export function createGatewayRoutes(gateway: ModelGateway) {
  const caller = (req: Request, server: Server, errors: GatewayOperation["errors"]): string | Response => {
    if (!fromLoopback(req, server)) return gateway.refuse({ errors }, 403, "the model gateway answers this machine only");
    const token = bearer(req) || req.headers.get("x-api-key")?.trim() || "";
    const run = token ? gateway.tokens.verify(token) : undefined;
    if (!run) return gateway.refuse({ errors }, 401, "the model gateway takes only tokens ai-space issued to its own processes; apps call /api/model and /api/speech");
    return run;
  };
  const post = (op: GatewayOperation) => ({
    POST: async (req: Request, server: Server) => {
      const run = caller(req, server, op.errors);
      return typeof run === "string" ? gateway.forward(req, op, run) : run;
    },
  });
  return {
    [`${GATEWAY_PREFIX}/v1/messages`]: post(MESSAGES),
    [`${GATEWAY_PREFIX}/v1/messages/count_tokens`]: post(COUNT),
    [`${GATEWAY_PREFIX}/v1/models`]: {
      GET: (req: Request, server: Server) => {
        const run = caller(req, server, "openai");
        if (typeof run !== "string") return run;
        return new Response(JSON.stringify(gateway.models()), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      },
    },
    [`${GATEWAY_PREFIX}/v1/audio/speech`]: post(openai("/audio/speech", "none")),
    [`${GATEWAY_PREFIX}/v1/audio/transcriptions`]: post(openai("/audio/transcriptions", "openai")),
    [`${GATEWAY_PREFIX}/v1/images/generations`]: post(openai("/images/generations", "openai")),
    [`${GATEWAY_PREFIX}/v1/images/edits`]: post(openai("/images/edits", "openai")),
  };
}

/**
 * The base a child process reaches the gateway at, from where ai-space listens: loopback, or every
 * address (then through 127.0.0.1). Undefined, with the reason, for a space bound to one other
 * address, since the gateway answers loopback only.
 */
export function gatewayBase(host: string, port: number): { base: string } | { reason: string } {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (h === "127.0.0.1" || h === "localhost" || h === "0.0.0.0" || h === "" || h === "::") return { base: `http://127.0.0.1:${port}${GATEWAY_PREFIX}` };
  if (h === "::1") return { base: `http://[::1]:${port}${GATEWAY_PREFIX}` };
  if (LOOPBACK.test(h)) return { base: `http://${h}:${port}${GATEWAY_PREFIX}` };
  return { reason: `ai-space listens on ${host} only (SPACE_HOST), not on loopback, so the built-in model gateway is off` };
}
