import { describe, expect, test } from "bun:test";
import { httpError, PeerClient } from "./client.ts";

// What a refresh records when the peer, or Cloudflare in front of its tunnel, answers with an error status.

const config = { name: "box", url: "https://space-box.example.com", token: "t", headers: {}, refreshMs: 30_000 };

function clientAnswering(res: () => Response): PeerClient {
  return new PeerClient(config, { fetch: (async () => res()) as unknown as typeof fetch });
}

describe("peer refresh errors", () => {
  test("a tunnel with no connector reads as such, not as a bare 530", async () => {
    const c = clientAnswering(() => new Response("error code: 1033", { status: 530 }));
    await c.refresh();
    expect(c.status()).toMatchObject({ health: "down", error: "tunnel not connected (Cloudflare 1033)" });
  });

  test("Cloudflare's HTML error page carries the same code", async () => {
    const page = `<html><body><h1>Error <span class="cf-error-code">1033</span></h1><p>Cloudflare Tunnel error</p><span>error code: 1033</span></body></html>`;
    expect(await httpError(new Response(page, { status: 530, headers: { "content-type": "text/html" } }))).toBe("tunnel not connected (Cloudflare 1033)");
  });

  test("the JSON Cloudflare sends for Accept: application/json carries the code", async () => {
    const problem = { type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/", title: "Error 1033: Cloudflare Tunnel error", status: 530, detail: "The tunnel is not connected.", error_code: 1033, error_name: "cloudflare_tunnel_error", ray_id: "8f0000000000abcd" };
    const c = clientAnswering(() => Response.json(problem, { status: 530 }));
    await c.refresh();
    expect(c.status().error).toBe("tunnel not connected (Cloudflare 1033)");
    expect(await httpError(new Response(JSON.stringify(problem), { status: 530, headers: { "content-type": "application/problem+json" } }))).toBe("tunnel not connected (Cloudflare 1033)");
    expect(await httpError(Response.json({ ...problem, error_code: 1034 }, { status: 530 }))).toBe("HTTP 530 (Cloudflare 1034)");
  });

  test("the HTML page Bun's default Accept gets has the code after kilobytes of CSS", async () => {
    const rules = Array.from({ length: 80 }, (_, i) => `.cf-rule-${i}{margin:0 auto;padding:${i}px 1rem;font-family:system-ui,-apple-system,sans-serif;color:#404040}`).join("\n");
    const css = `.cf-error-code{font-weight:600;color:#bd2426}\n${rules}`;
    const page = `<!DOCTYPE html><html lang="en-US"><head><meta charset="UTF-8"><title>Cloudflare Tunnel error | space-box.example.com | Cloudflare</title><style>${css}</style></head><body><div id="cf-wrapper"><h1><span class="cf-error-type">Error</span> <span class="cf-error-code">1033</span></h1><h2>Cloudflare Tunnel error</h2><p>Ray ID: 8f0000000000abcd</p></div></body></html>`;
    expect(page.indexOf('cf-error-code">')).toBeGreaterThan(5000);
    expect(await httpError(new Response(page, { status: 530, headers: { "content-type": "text/html; charset=UTF-8" } }))).toBe("tunnel not connected (Cloudflare 1033)");
  });

  test("the Markdown Cloudflare sends for Accept: text/markdown carries the code", async () => {
    const md = `---\nerror_code: 1033\nerror_name: cloudflare_tunnel_error\nstatus: 530\nray_id: 8f0000000000abcd\n---\n\n# Error 1033: Cloudflare Tunnel error\n\nThe tunnel is not connected.\n`;
    expect(await httpError(new Response(md, { status: 530, headers: { "content-type": "text/markdown; charset=utf-8" } }))).toBe("tunnel not connected (Cloudflare 1033)");
  });

  test("another Cloudflare code keeps the status and names the code", async () => {
    expect(await httpError(new Response("error code: 1016", { status: 530 }))).toBe("origin DNS error (Cloudflare 1016)");
    expect(await httpError(new Response("error code: 1034", { status: 530 }))).toBe("HTTP 530 (Cloudflare 1034)");
  });

  test("a 530 without a code, and other statuses, stay the status", async () => {
    expect(await httpError(new Response("", { status: 530 }))).toBe("HTTP 530");
    expect(await httpError(new Response("error code: 1033", { status: 502 }))).toBe("HTTP 502");
    const c = clientAnswering(() => new Response("bad gateway", { status: 502 }));
    await c.refresh();
    expect(c.status().error).toBe("HTTP 502");
  });

  test("a rejected token is still named", async () => {
    const c = clientAnswering(() => new Response("", { status: 401 }));
    await c.refresh();
    expect(c.status().error).toBe("token rejected");
  });
});

describe("what the hub asks a peer for", () => {
  // Cloudflare shapes its own 530 by Accept, and Bun's fetch sends `*/*` unless told otherwise.
  function recording(): { seen: { url: string; accept: string | null }[]; fetch: typeof fetch } {
    const seen: { url: string; accept: string | null }[] = [];
    const f = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), accept: new Headers(init?.headers).get("accept") });
      return String(url).includes("/api/peer/events") ? Response.json({ ok: true, events: [], latestId: 0 }) : Response.json({ ok: true, name: "box", apps: [], services: [], widgets: [], agents: [], asOf: "2026-01-01T00:00:00Z" });
    };
    return { seen, fetch: f as unknown as typeof fetch };
  }

  test("the snapshot refresh and the event pull ask for JSON", async () => {
    const r = recording();
    const c = new PeerClient(config, { fetch: r.fetch, onEvents: () => {} });
    await c.refresh();
    expect(c.status().health).toBe("ok");
    expect(r.seen).toEqual([
      { url: "https://space-box.example.com/api/peer/snapshot", accept: "application/json" },
      { url: "https://space-box.example.com/api/peer/events?since=0&limit=200", accept: "application/json" },
    ]);
  });

  test("a request asks for JSON unless the caller asks for something else", async () => {
    const r = recording();
    const c = new PeerClient(config, { fetch: r.fetch });
    await c.request("/api/peer/ledgers/usage");
    await c.request("/api/peer/model/complete", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" } });
    await c.request("/api/peer/model/complete", { method: "POST", headers: { Accept: "text/event-stream" } });
    expect(r.seen.map((s) => s.accept)).toEqual(["application/json", "text/event-stream", "text/event-stream"]);
  });
});
