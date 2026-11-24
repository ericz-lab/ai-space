import { expect, test } from "bun:test";
import { fetchVendorImage, isPublicAddress } from "./vendor-image.ts";

// Each rule of vendor-image.ts, with a stand-in resolver and fetch: nothing here reaches the network.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const at = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
function recorder(answer: () => Response = () => new Response(PNG)) {
  const calls: { url: string; init: RequestInit & { tls?: { serverName?: string; checkServerIdentity?: unknown } } }[] = [];
  const fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), answer())) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test("public and non-public addresses, IPv4 inside IPv6 checked as IPv4", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::6810:84e5", "2a00:1450:4001:80b::200e"]) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
    "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:a00:1::1", "not-an-ip",
  ]) expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
});

test("https on 443 only, no credentials", async () => {
  const r = recorder();
  for (const [url, why] of [["http://cdn.vendor.test/a.png", /not https/], ["https://u:p@cdn.vendor.test/a.png", /credentials/], ["https://cdn.vendor.test:8443/a.png", /port 443/], ["file:///etc/passwd", /not https/], ["nope", /not a URL/]] as const) {
    expect(await fetchVendorImage(url, { lookup: at("93.184.216.34"), fetch: r.fetch })).toEqual({ ok: false, error: expect.stringMatching(why) });
  }
  expect(r.calls).toHaveLength(0);
});

test("a host with any non-public address is refused before a connection", async () => {
  const r = recorder();
  for (const addrs of [["127.0.0.1"], ["93.184.216.34", "10.0.0.5"], ["::1"], ["169.254.169.254"]]) {
    const out = await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup: at(...addrs), fetch: r.fetch });
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/non-public address/) });
  }
  // An address written in the URL is checked the same way.
  expect(await fetchVendorImage("https://127.0.0.1/a.png", { fetch: r.fetch })).toMatchObject({ ok: false });
  expect(await fetchVendorImage("https://[::ffff:169.254.169.254]/a.png", { fetch: r.fetch })).toMatchObject({ ok: false });
  expect(r.calls).toHaveLength(0);
});

test("the connection goes to the checked address, the name kept for TLS and Host, redirects not followed", async () => {
  const r = recorder();
  const out = await fetchVendorImage("https://cdn.vendor.test/img/a.png?x=1", { lookup: at("93.184.216.34"), fetch: r.fetch });
  expect(out).toEqual({ ok: true, bytes: PNG, type: "image/png" });
  const c = r.calls[0]!;
  expect(c.url).toBe("https://93.184.216.34/img/a.png?x=1");
  expect(new Headers(c.init.headers).get("host")).toBe("cdn.vendor.test");
  expect(new Headers(c.init.headers).get("authorization")).toBeNull();
  expect(c.init.redirect).toBe("manual");
  expect(c.init.tls?.serverName).toBe("cdn.vendor.test");
  expect(typeof c.init.tls?.checkServerIdentity).toBe("function");
  const v6 = recorder();
  await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup: at("2606:4700::6810:84e5"), fetch: v6.fetch });
  expect(v6.calls[0]!.url).toBe("https://[2606:4700::6810:84e5]/a.png");
  const moved = recorder(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
  expect(await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup: at("93.184.216.34"), fetch: moved.fetch })).toEqual({ ok: false, error: expect.stringMatching(/redirects/) });
  expect(moved.calls).toHaveLength(1);
});

test("a size cap, a timeout, and the bytes must be an image", async () => {
  const lookup = at("93.184.216.34");
  const big = recorder(() => new Response(new Uint8Array(2048)));
  expect(await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup, fetch: big.fetch, maxBytes: 1024 })).toEqual({ ok: false, error: expect.stringMatching(/larger than 1024/) });
  const declared = recorder(() => new Response(PNG, { headers: { "content-length": "999999999" } }));
  expect(await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup, fetch: declared.fetch })).toEqual({ ok: false, error: expect.stringMatching(/larger than/) });
  const html = recorder(() => new Response("<html>login</html>", { headers: { "content-type": "image/png" } }));
  expect(await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup, fetch: html.fetch })).toEqual({ ok: false, error: expect.stringMatching(/did not answer a png/) });
  const slow = (async (_u: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
  expect(await fetchVendorImage("https://cdn.vendor.test/a.png", { lookup, fetch: slow, timeoutMs: 20 })).toEqual({ ok: false, error: expect.stringMatching(/timed out/) });
});
