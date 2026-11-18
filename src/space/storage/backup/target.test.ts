import { afterEach, describe, expect, test } from "bun:test";
import { S3Target, isTransientS3Error } from "./target.ts";

/**
 * S3Target against a fake endpoint on localhost: a TCP server that drops the first connections the
 * way a sleeping machine's link drops, then answers like S3; or an HTTP server with a final error.
 */

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** Drops the first `drop` connections as soon as a request arrives, answers 200 to the rest. */
function flakyEndpoint(drop: number) {
  let connections = 0;
  const server = Bun.listen<{ n: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { n: ++connections };
      },
      data(s) {
        if (s.data.n <= drop) return void s.terminate();
        s.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nETag: "x"\r\nConnection: close\r\n\r\n');
        s.end();
      },
    },
  });
  stops.push(() => server.stop(true));
  return { endpoint: `http://127.0.0.1:${server.port}`, connections: () => connections };
}

function target(endpoint: string, delays = [1, 1, 1]) {
  const waits: number[] = [];
  const logs: string[] = [];
  const t = new S3Target("bucket", "backups/m/", { accessKeyId: "a", secretAccessKey: "s", endpoint }, { retryDelaysMs: delays, sleep: async (ms) => void waits.push(ms), log: (m) => logs.push(m) });
  return { t, waits, logs };
}

describe("S3Target retries", () => {
  test("a dropped connection is tried again after each delay, and the call succeeds", async () => {
    const ep = flakyEndpoint(2);
    const { t, waits, logs } = target(ep.endpoint, [10, 20, 30]);
    await t.putText("space/2026-11-17T11-45-50Z.json", "{}");
    expect(ep.connections()).toBe(3);
    expect(waits).toEqual([10, 20]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("S3 put space/2026-11-17T11-45-50Z.json");
    expect(logs[0]).toContain("ConnectionClosed");
    expect(logs[0]).toContain("attempt 2 of 4");
  });

  test("a link that stays down fails after the last attempt, naming the S3 code", async () => {
    const ep = flakyEndpoint(100);
    const { t, waits } = target(ep.endpoint, [1, 1]);
    const e = await t.putText("space/x.json", "{}").then(() => undefined, (e: Error) => e);
    expect(e?.message).toContain("(S3 ConnectionClosed) after 3 attempts");
    expect(e?.message).toContain("s3://bucket/backups/m/space/x.json");
    expect(waits).toHaveLength(2);
  });

  test("an answer from the service is final: no second attempt", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        requests++;
        return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403, headers: { "content-type": "application/xml" } });
      },
    });
    stops.push(() => server.stop(true));
    const { t, waits } = target(`http://127.0.0.1:${server.port}`);
    const e = await t.putText("space/x.json", "{}").then(() => undefined, (e: Error) => e);
    expect(e?.message).toContain("(S3 AccessDenied)");
    expect(e?.message).not.toContain("attempts");
    expect(requests).toBe(1);
    expect(waits).toEqual([]);
  });

  test("which codes count as transient", () => {
    for (const code of ["ConnectionClosed", "ConnectionRefused", "ECONNRESET", "ETIMEDOUT", "RequestTimeout", "InternalError", "ServiceUnavailable", "SlowDown"]) {
      expect(isTransientS3Error({ name: "S3Error", code })).toBe(true);
    }
    for (const code of ["AccessDenied", "NoSuchBucket", "SignatureDoesNotMatch", "InvalidAccessKeyId"]) {
      expect(isTransientS3Error({ name: "S3Error", code })).toBe(false);
    }
    expect(isTransientS3Error(new Error("no code"))).toBe(false);
  });
});
