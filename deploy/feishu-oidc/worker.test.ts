import { beforeAll, describe, expect, test } from "bun:test";
import { handle, type Env } from "./worker.ts";

let env: Env;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  env = { ISSUER: "https://bridge.example.com", CLIENT_ID: "test-app", REDIRECT_URI: "https://team.cloudflareaccess.com/cdn-cgi/access/callback",
    KEY_ID: "test-key", SIGNING_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) };
});
const now = 1_790_000_000_000;
function request(changes: Record<string, string> = {}, basic = false): Request {
  const params = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: "private:secret",
    grant_type: "authorization_code", code: "single-use-code", redirect_uri: env.REDIRECT_URI, ...changes });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (basic) {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(params.get("client_id")!)}:${encodeURIComponent(params.get("client_secret")!)}`)}`;
    params.delete("client_id"); params.delete("client_secret");
  }
  return new Request(env.ISSUER + "/token", { method: "POST", headers, body: params });
}
function provider(profile: unknown = { open_id: "real-user", email: "user@example.com", name: "User" }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return { calls, fetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url.endsWith("/token") ? { code: 0, access_token: "upstream-private", refresh_token: "refresh-private" } : { code: 0, data: profile });
  } };
}

describe("Feishu Access bridge", () => {
  test("preserves the global fetch receiver required by Workers", async () => {
    const saved = globalThis.fetch;
    const upstream = provider();
    globalThis.fetch = Object.assign(async function(this: unknown, input: string | URL | Request, init?: RequestInit) {
      expect(this).toBe(globalThis);
      return upstream.fetch(String(input), init);
    }, { preconnect: saved.preconnect });
    try { expect((await handle(request(), env)).status).toBe(200); }
    finally { globalThis.fetch = saved; }
  });
  for (const basic of [false, true]) test(`signs real identities after upstream verification (${basic ? "basic" : "post"})`, async () => {
    const upstream = provider();
    const response = await handle(request({}, basic), env, upstream.fetch, () => now);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("private");
    const body = JSON.parse(text);
    const [header, payload, signature] = body.id_token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT", kid: env.KEY_ID });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iss: env.ISSUER, sub: "real-user", aud: env.CLIENT_ID, email: "user@example.com", name: "User", iat: now / 1000, exp: now / 1000 + 300,
    });
    const jwks = await (await handle(new Request(env.ISSUER + "/jwks"), env)).json() as { keys: JsonWebKey[] };
    expect(Object.keys(jwks.keys[0]!)).toEqual(["kty", "n", "e", "alg", "use", "kid"]);
    const publicKey = await crypto.subtle.importKey("jwk", jwks.keys[0]!, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    const sent = JSON.parse(upstream.calls[0]!.init!.body as string);
    expect(sent.client_secret).toBe("private:secret");
    expect(sent.redirect_uri).toBe(env.REDIRECT_URI);
    expect(upstream.calls[0]!.url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token");
    expect(upstream.calls[0]!.init!.headers).toEqual({ "Content-Type": "application/json" });
    expect(upstream.calls[1]!.url).toBe("https://open.feishu.cn/open-apis/authen/v1/user_info");
    expect(upstream.calls[0]!.init!.redirect).toBe("manual");
    expect(upstream.calls[1]!.init!.headers).toEqual({ Authorization: "Bearer upstream-private" });
  });

  test("keeps the Feishu callback and opaque Access state unchanged", async () => {
    const url = new URL(env.ISSUER + "/authorize");
    url.search = new URLSearchParams({ client_id: env.CLIENT_ID, redirect_uri: env.REDIRECT_URI,
      response_type: "code", scope: "openid email profile", state: "opaque+/=%state", login_hint: "ignored" }).toString();
    const response = await handle(new Request(url), env);
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(target.origin).toBe("https://accounts.feishu.cn");
    expect(target.pathname).toBe("/open-apis/authen/v1/authorize");
    expect(target.searchParams.get("scope")).toBe("contact:user.base:readonly contact:user.email:readonly");
    expect(target.searchParams.get("state")).toBe("opaque+/=%state");
    expect(target.searchParams.get("redirect_uri")).toBe(env.REDIRECT_URI);
    expect(target.searchParams.has("login_hint")).toBe(false);
    url.searchParams.set("nonce", "not-silently-ignored");
    expect((await handle(new Request(url), env)).status).toBe(400);
    url.searchParams.delete("nonce"); url.searchParams.set("redirect_uri", "https://attacker.example");
    expect((await handle(new Request(url), env)).status).toBe(400);
  });

  test("rejects other clients, callbacks, grants and missing secrets before network access", async () => {
    const upstream = provider();
    const invalid: Record<string, string>[] = [{ client_id: "another" }, { redirect_uri: "https://attacker.example" }, { client_secret: "" },
      { grant_type: "refresh_token" }, { code: "" }, { code_verifier: "unsupported" }];
    for (const params of invalid) {
      expect((await handle(request(params), env, upstream.fetch)).status).toBeGreaterThanOrEqual(400);
    }
    expect(upstream.calls.length).toBe(0);
  });

  test("does not sign identities when Feishu rejects or replays a code", async () => {
    let used = false;
    const upstream = provider();
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/token")) {
        if (used) return Response.json({ error: "invalid_grant", error_description: "private-provider-message" }, { status: 400 });
        used = true;
      }
      return upstream.fetch(url, init);
    };
    expect((await handle(request(), env, fetch)).status).toBe(200);
    const replay = await handle(request(), env, fetch);
    expect(replay.status).toBe(400);
    expect(await replay.text()).not.toContain("private-provider-message");
  });

  test("requires provider identity and real email, and rejects explicitly unverified email", async () => {
    for (const profile of [{ open_id: "u" }, { email: "u@example.com" }, { open_id: "u", email: "bad" },
      { open_id: "u", email: "u@example.com", email_verified: false }, null,
      { open_id: "u", enterprise_email: "fallback@example.com" }]) {
      const response = await handle(request(), env, provider(profile).fetch);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain("id_token");
    }
  });

  test("rejects modern API errors even when the HTTP status is successful", async () => {
    const response = await handle(request(), env, async url => Response.json(url.endsWith("/token")
      ? { code: 0, access_token: "private" }
      : { code: 99991672, msg: "permission denied", data: { open_id: "u", email: "u@example.com" } }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("id_token");
  });

  test("handles unavailable and malformed provider responses without leaking credentials", async () => {
    for (const fetch of [async () => { throw new Error("private network error"); }, async () => new Response("not JSON")]) {
      const response = await handle(request(), env, fetch);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("private");
    }
  });

  test("refuses upstream redirects without forwarding credentials to the target", async () => {
    const response = await handle(request(), env, async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://attacker.example/token" } });
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable", error_description: "feishu_token_redirected" });
  });

  test("rejects malformed authentication, ambiguous input and excessive bodies", async () => {
    const upstream = provider();
    for (const authorization of ["Bearer secret", "Basic !!!", `Basic ${btoa("missing-colon")}`]) {
      const req = request({}, true); req.headers.set("Authorization", authorization);
      expect((await handle(req, env, upstream.fetch)).status).toBe(401);
    }
    const ambiguous = request(); ambiguous.headers.set("Authorization", `Basic ${btoa("a:b")}`);
    expect((await handle(ambiguous, env, upstream.fetch)).status).toBe(400);
    const duplicate = new Request(env.ISSUER + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "code=a&code=b" });
    expect((await handle(duplicate, env, upstream.fetch)).status).toBe(400);
    expect((await handle(request({ code: "x".repeat(20_000) }), env, upstream.fetch)).status).toBe(413);
    expect(upstream.calls.length).toBe(0);
  });

  test("does not expose keys at unexpected origins or accept broken signing configuration", async () => {
    expect((await handle(new Request("https://attacker.example/jwks"), env)).status).toBe(400);
    const response = await handle(request(), { ...env, SIGNING_JWK: "invalid-private-material" }, provider().fetch);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("invalid-private-material");
  });
});
