/** A token bridge for Cloudflare Access's confidential authorization-code flow.
 * Feishu retains the callback and consumes each code once. Access validates state.
 * This is not a general OIDC server: nonce, PKCE, refresh and implicit flows are
 * deliberately unsupported. No user identity or upstream credential is stored.
 */
export interface Env {
  ISSUER: string;
  CLIENT_ID: string;
  REDIRECT_URI: string;
  SIGNING_JWK: string;
  KEY_ID: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
const UPSTREAM = {
  authorize: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
  userinfo: "https://open.feishu.cn/open-apis/authen/v1/user_info",
} as const;
const encoder = new TextEncoder();
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const lifetimeSeconds = 300;

class Failure extends Error {
  constructor(readonly status: number, readonly code: string, readonly stage: string) {
    super(stage);
  }
}

function json(value: unknown, status = 200, cache = "no-store"): Response {
  return Response.json(value, { status, headers: {
    "Cache-Control": cache, "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
  } });
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encode(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

function signingKey(env: Env): JsonWebKey {
  const key = JSON.parse(env.SIGNING_JWK) as JsonWebKey;
  if (key.kty !== "RSA" || !key.n || !key.e || !key.d || !env.KEY_ID) throw new Error("signing configuration");
  return key;
}

async function sign(payload: RecordValue, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", signingKey(env), algorithm, false, ["sign"]);
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: env.KEY_ID })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(algorithm, key, encoder.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

async function boundedText(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new Error("body limit");
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(bytes);
}

async function upstream(path: "token" | "userinfo", init: RequestInit, fetch: Fetch): Promise<RecordValue> {
  let status = 0;
  try {
    const response = await fetch(UPSTREAM[path], {
      ...init, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    if (status >= 300 && status < 400) throw new Failure(502, "temporarily_unavailable", `feishu_${path}_redirected`);
    const data = object(JSON.parse(await boundedText(response.body, 64 * 1024)));
    if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) {
      throw new Failure(400, "invalid_grant", `feishu_${path}_rejected`);
    }
    return data;
  } catch (error) {
    if (error instanceof Failure) throw error;
    const kind = error instanceof Error && ["TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error.name) ? error.name : "Error";
    const reason = error instanceof Error ? ["redirect", "signal", "invocation", "timeout"].find(value => error.message.toLowerCase().includes(value)) ?? "other" : "other";
    console.warn(JSON.stringify({ event: "feishu_oidc_upstream", endpoint: path, status, kind, reason }));
    throw new Failure(502, "temporarily_unavailable", `feishu_${path}_unavailable`);
  }
}

function validateClient(clientId: string, redirect: string, env: Env): void {
  if (!env.CLIENT_ID || clientId !== env.CLIENT_ID) throw new Failure(401, "invalid_client", "client_not_allowed");
  if (!env.REDIRECT_URI || redirect !== env.REDIRECT_URI) throw new Failure(400, "invalid_request", "redirect_not_allowed");
}

function authorize(url: URL, env: Env): Response {
  const q = url.searchParams;
  validateClient(q.get("client_id") ?? "", q.get("redirect_uri") ?? "", env);
  if (q.get("response_type") !== "code" || !q.get("state")) throw new Failure(400, "invalid_request", "code_and_state_required");
  if (q.has("nonce") || q.has("code_challenge") || q.has("request") || q.has("request_uri")) {
    throw new Failure(400, "invalid_request", "unsupported_authorization_flow");
  }
  const scopes = (q.get("scope") ?? "").split(" ").filter(Boolean);
  if (!scopes.includes("openid") || scopes.some(s => !["openid", "email", "profile"].includes(s))) {
    throw new Failure(400, "invalid_scope", "unsupported_scope");
  }
  const target = new URL(UPSTREAM.authorize);
  for (const name of ["client_id", "redirect_uri", "response_type", "state"]) target.searchParams.set(name, q.get(name)!);
  // Feishu uses API permission names, not OIDC's openid/email/profile scopes.
  target.searchParams.set("scope", "contact:user.base:readonly contact:user.email:readonly");
  return new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function token(request: Request, env: Env, fetch: Fetch, now: () => number): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") {
    throw new Failure(415, "invalid_request", "form_required");
  }
  let form: URLSearchParams;
  try { form = new URLSearchParams(await boundedText(request.body, 16 * 1024)); }
  catch { throw new Failure(413, "invalid_request", "request_too_large"); }
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length !== 1) throw new Failure(400, "invalid_request", "duplicate_parameter");
  }
  let clientId = form.get("client_id") ?? "";
  let secret = form.get("client_secret") ?? "";
  const authorization = request.headers.get("Authorization");
  if (authorization) {
    if (clientId || secret) throw new Failure(400, "invalid_request", "ambiguous_client_authentication");
    try {
      const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(authorization);
      if (!match) throw new Error();
      const decoded = atob(match[1]!);
      const separator = decoded.indexOf(":");
      if (separator < 1) throw new Error();
      clientId = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " "));
      secret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " "));
    } catch { throw new Failure(401, "invalid_client", "invalid_client_authentication"); }
  }
  validateClient(clientId, form.get("redirect_uri") ?? "", env);
  if (!secret) throw new Failure(401, "invalid_client", "client_secret_required");
  if (form.get("grant_type") !== "authorization_code") throw new Failure(400, "unsupported_grant_type", "authorization_code_required");
  if (!form.get("code") || form.has("code_verifier") || form.has("nonce")) throw new Failure(400, "invalid_request", "unsupported_token_request");
  const exchanged = await upstream("token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: secret,
      grant_type: "authorization_code", code: form.get("code")!, redirect_uri: env.REDIRECT_URI }),
  }, fetch);
  const accessToken = string(exchanged.access_token);
  if (!accessToken) throw new Failure(502, "server_error", "feishu_token_missing");
  const profileResponse = await upstream("userinfo", { headers: { Authorization: `Bearer ${accessToken}` } }, fetch);
  const profile = object(profileResponse.data);
  const sub = string(profile.open_id);
  const email = string(profile.email).trim();
  if (!sub || sub.length > 512) throw new Failure(502, "server_error", "feishu_subject_missing");
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || profile.email_verified === false) {
    console.warn(JSON.stringify({ event: "feishu_oidc_identity", emailPresent: Boolean(email),
      emailFormatValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      emailVerification: typeof profile.email_verified === "boolean" ? profile.email_verified : "unspecified",
      enterpriseEmailPresent: Boolean(string(profile.enterprise_email).trim()) }));
    throw new Failure(403, "access_denied", "feishu_email_missing_or_unverified");
  }
  // JWT NumericDate is epoch seconds; internal clocks use epoch milliseconds.
  const issuedAtSeconds = Math.floor(now() / 1000);
  const identity: RecordValue = { iss: env.ISSUER, sub, aud: env.CLIENT_ID,
    iat: issuedAtSeconds, exp: issuedAtSeconds + lifetimeSeconds, email };
  if (profile.email_verified === true) identity.email_verified = true;
  if (typeof profile.name === "string") identity.name = profile.name;
  const idToken = await sign(identity, env);
  // Access consumes id_token. Do not forward Feishu access/refresh credentials.
  return json({ token_type: "Bearer", access_token: crypto.randomUUID(), id_token: idToken,
    expires_in: lifetimeSeconds, scope: "openid email profile" });
}

export async function handle(request: Request, env: Env, fetch: Fetch = (url, init) => globalThis.fetch(url, init), now = Date.now): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.origin !== env.ISSUER || !env.ISSUER.startsWith("https://")) throw new Failure(400, "invalid_request", "issuer_mismatch");
    if (url.pathname === "/jwks" && request.method === "GET") {
      const { n, e } = signingKey(env);
      return json({ keys: [{ kty: "RSA", n, e, alg: "RS256", use: "sig", kid: env.KEY_ID }] }, 200, "public, max-age=300");
    }
    if (url.pathname === "/authorize" && request.method === "GET") return authorize(url, env);
    if (url.pathname === "/token" && request.method === "POST") return await token(request, env, fetch, now);
    return json({ error: "not_found" }, 404);
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure(500, "server_error", "bridge_configuration_error");
    // Diagnostics contain fixed stage names only, never requests or provider bodies.
    console.warn(JSON.stringify({ event: "feishu_oidc_failure", stage: failure.stage }));
    return json({ error: failure.code, error_description: failure.stage }, failure.status);
  }
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
