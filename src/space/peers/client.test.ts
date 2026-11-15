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
