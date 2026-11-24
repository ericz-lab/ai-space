import type { Usage } from "../runtimes/types.ts";

/**
 * The built-in model gateway (docs/model-gateway.md): it sits between an AI runtime (Claude Code)
 * or a direct call (the `anthropic-api` runtime, the speech service) and the model providers. It
 * holds the providers' keys, picks the provider for a model or a group, fails over before the
 * first byte, and records what answered. It forwards a request in the protocol it arrived in and
 * rewrites only the `model` field and the auth header: no translation between protocols.
 *
 * Not the package gateway (`src/space/packages/gateway.ts`) and not the Space Router.
 */

/** The two kinds of base a provider can have, which decide what the gateway forwards to it. */
export const GATEWAY_BASES = ["messages", "openai"] as const;
export type GatewayBase = (typeof GATEWAY_BASES)[number];

/** How the key travels on the `messages` base; the `openai` base always uses a bearer. */
export const GATEWAY_AUTH = ["x-api-key", "bearer"] as const;
export type GatewayAuth = (typeof GATEWAY_AUTH)[number];

/** A provider's or group's name in `gateway.yaml` and in a model id (`deepseek/deepseek-chat`, `fast`). */
export const GATEWAY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The model part of `provider/model`: what the provider calls it, passed on as is. */
export const GATEWAY_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export type GatewayProvider = {
  name: string;
  /** Base that speaks Anthropic Messages: `{messages}/v1/messages`. */
  messages?: string;
  /** OpenAI-style base: `{openai}/audio/speech`, `{openai}/images/generations`, … */
  openai?: string;
  /** How the key travels on the `messages` base. */
  auth: GatewayAuth;
  apiKeyEnv?: string;
  /** Read from `apiKeyEnv` at load; never written anywhere, never logged. */
  apiKey?: string;
  /** Models to list in `/v1/models`; any `provider/<model>` is forwarded whether listed or not. */
  models: string[];
  /** The preset its bases came from, when one did. */
  preset?: string;
};

export type GatewayConfig = {
  providers: GatewayProvider[];
  /** A group's members, tried in order: `provider/model` each. */
  groups: Record<string, string[]>;
  /** Providers kept in the file but off, with the reason (a key variable that is empty). */
  off: Record<string, string>;
};

/** What the gateway kept about one run token: which provider and model answered, what was tried, the tokens. */
export type GatewayTrace = {
  run: string;
  /** Requests forwarded under this token. */
  requests: number;
  /** The last `provider/model` that answered. */
  served?: string;
  /** Every `provider/model` tried, in order of first try. */
  tried: string[];
  /** Summed over the answers that reported usage. */
  usage?: Usage;
  /** The last failure, when the last request failed. */
  error?: string;
  updatedAt: number;
};

/** A token issued for one run: `run` is what the trace is kept under. */
export type GatewayGrant = { run: string; token: string };

/**
 * What a runtime or the speech service needs of the built-in model gateway: where it listens, a
 * token for one run, and the trace of that run afterwards. Undefined `base()`: the gateway is off
 * (no `gateway.yaml`, or the space does not listen on loopback).
 */
export type GatewayLink = {
  /** `http://127.0.0.1:<port>/api/model-gateway`; `/v1/messages` and the rest are under it. */
  base(): string | undefined;
  issue(): GatewayGrant;
  trace(run: string): GatewayTrace | undefined;
  /** A provider by name, for the speech shorthand and the image operation. */
  provider(name: string): GatewayProvider | undefined;
  /** Whether some provider that is on has a base of this kind. */
  has(base: GatewayBase): boolean;
  /** Why the gateway cannot answer, or undefined when it can (the status table). */
  problem(): string | undefined;
};
