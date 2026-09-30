import { describe, expect, test } from "bun:test";
import { OPERATOR, bearer, crossSiteWrite, guardBrowserWrites, identify, isOperator, tokenEquals } from "./auth.ts";

const req = (headers: Record<string, string> = {}, method = "POST") => new Request("http://127.0.0.1:8700/api/x", { method, headers });

describe("bearer tokens", () => {
  test("the scheme is case-insensitive and surrounding space is dropped", () => {
    expect(bearer(req({ authorization: "bearer  abc " }))).toBe("abc");
    expect(bearer(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(bearer(req())).toBe("");
  });

  test("comparison needs both sides and an exact match", () => {
    expect(tokenEquals("abc", "abc")).toBe(true);
    expect(tokenEquals("abc", "abd")).toBe(false);
    expect(tokenEquals("abc", "abcd")).toBe(false);
    expect(tokenEquals("", "")).toBe(false);
  });

  test("an operator route accepts any spelling of the scheme, and everyone when no token is set", () => {
    expect(isOperator(req({ authorization: "bearer op" }), "op")).toBe(true);
    expect(isOperator(req({ authorization: "Bearer nope" }), "op")).toBe(false);
    expect(isOperator(req(), "op")).toBe(false);
    expect(isOperator(req(), "")).toBe(true);
  });

  test("identify: operator token, app token, no token, unknown token", async () => {
    const appForToken = async (t: string) => (t === "app-t" ? "notes" : undefined);
    expect(await identify(req({ authorization: "Bearer op" }), { token: "op", appForToken })).toBe(OPERATOR);
    expect(await identify(req({ authorization: "Bearer app-t" }), { token: "op", appForToken })).toEqual({ app: "notes" });
    expect(await identify(req(), { token: "op", appForToken })).toBeUndefined();
    expect(await identify(req(), { token: "", appForToken })).toBe(OPERATOR);
    expect(await identify(req({ authorization: "Bearer other" }), { token: "", appForToken })).toBeUndefined();
  });
});

describe("browser writes", () => {
  test("a write from another site's page is refused; the panel, scripts and token holders pass", () => {
    expect(crossSiteWrite(req({ origin: "https://evil.example", host: "127.0.0.1:8700" }))).toBe(true);
    expect(crossSiteWrite(req({ origin: "null", host: "127.0.0.1:8700" }))).toBe(true);
    expect(crossSiteWrite(req({ "sec-fetch-site": "cross-site", host: "127.0.0.1:8700" }))).toBe(true);
    expect(crossSiteWrite(req({ origin: "http://127.0.0.1:8700", host: "127.0.0.1:8700" }))).toBe(false);
    expect(crossSiteWrite(req({ host: "127.0.0.1:8700" }))).toBe(false);
    expect(crossSiteWrite(req({ origin: "https://evil.example", authorization: "Bearer x" }))).toBe(false);
    expect(crossSiteWrite(req({ origin: "https://evil.example" }, "GET"))).toBe(false);
  });

  test("guardBrowserWrites wraps write methods and bare handlers, and leaves reads and static routes alone", async () => {
    const ok = (_: Request): Response | Promise<Response> => new Response("ok");
    // Like Bun's HTML bundle: a class instance without own method keys, which must reach Bun.serve untouched.
    const page = new (class Bundle {})();
    const routes = guardBrowserWrites({ "/a": { GET: ok, POST: ok }, "/b": ok, "/": page });
    const evil = (method: string) => req({ origin: "https://evil.example", host: "127.0.0.1:8700" }, method);
    expect((await routes["/a"].POST(evil("POST"))).status).toBe(403);
    expect(await (await routes["/a"].GET(evil("GET"))).text()).toBe("ok");
    expect((await routes["/b"](evil("DELETE"))).status).toBe(403);
    expect(routes["/"]).toBe(page);
  });
});
