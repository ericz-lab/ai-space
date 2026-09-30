import { describe, expect, test } from "bun:test";
import { type EdgePlan, cfCommands, parseWhoami, renderCfScript, shellArg, tunnelIngress } from "./cloudflare.ts";

const plan: EdgePlan = { machine: "box", zone: "example.com", panelHost: "space.example.com", panelPort: 8700, routerPort: 8080, email: "me@example.com" };

describe("cloudflare plan", () => {
  test("ingress: panel first, then the wildcard to the router, then the catch-all", () => {
    expect(tunnelIngress(plan).config.ingress).toEqual([
      { hostname: "space.example.com", service: "http://127.0.0.1:8700" },
      { hostname: "*.example.com", service: "http://127.0.0.1:8080" },
      { service: "http_status:404" },
    ]);
    const { routerPort: _, ...noRouter } = plan;
    expect(tunnelIngress(noRouter).config.ingress).toHaveLength(2);
  });

  test("Access is created before the tunnel's hostnames and their DNS records", () => {
    const steps = cfCommands(plan).map((c) => c.argv.slice(1, 4).join(" "));
    const access = steps.lastIndexOf("zero-trust access applications");
    expect(access).toBeLessThan(steps.indexOf("tunnels config update"));
    expect(access).toBeLessThan(steps.indexOf("dns records create"));
    expect(steps.filter((s) => s === "zero-trust access applications")).toHaveLength(2);
    expect(steps.filter((s) => s === "dns records create")).toHaveLength(2);
  });

  test("bodies carry the hostnames, the email and the tunnel variable", () => {
    const cmds = cfCommands({ ...plan, bucket: "space-box", peerToken: "hub" });
    const body = (i: number) => JSON.parse(cmds[i]!.argv.at(-1)!);
    const access = cmds.findIndex((c) => c.argv.includes("applications"));
    expect(body(access)).toMatchObject({ type: "self_hosted", domain: "space.example.com", policies: [{ decision: "allow", include: [{ email: { email: "me@example.com" } }] }] });
    const dns = cmds.findIndex((c) => c.argv.includes("records"));
    expect(body(dns)).toEqual({ type: "CNAME", name: "space.example.com", content: "$TUNNEL_ID.cfargotunnel.com", proxied: true });
    expect(cmds.some((c) => c.argv.join(" ") === "cf r2 buckets create --name space-box")).toBe(true);
    expect(cmds.some((c) => c.argv.join(" ") === "cf zero-trust access service-tokens create --name hub --duration forever")).toBe(true);
    expect(cmds.at(0)!.argv).toEqual(["cf", "auth", "login"]);
  });

  test("the script quotes JSON and keeps $TUNNEL_ID expandable", () => {
    expect(shellArg("space.example.com")).toBe("space.example.com");
    expect(shellArg(`{"a":"it's"}`)).toBe(`'{"a":"it'\\''s"}'`);
    expect(shellArg(`{"content":"$TUNNEL_ID.cfargotunnel.com"}`)).toBe(`"{\\"content\\":\\"$TUNNEL_ID.cfargotunnel.com\\"}"`);
    const lines = renderCfScript(cfCommands(plan));
    expect(lines).toContain("cf tunnels create --name box --config-src cloudflare");
    expect(lines).toContain("cf tunnels token get $TUNNEL_ID");
  });

  test("whoami: logged in, not logged in, rejected token, garbage", () => {
    expect(parseWhoami('{"authenticated":true,"authSource":"oauth"}').ok).toBe(true);
    expect(parseWhoami('{"authenticated":false,"error":"Not logged in"}')).toEqual({ ok: false, detail: "Not logged in" });
    expect(parseWhoami('{"authenticated":true,"tokenValid":false}').ok).toBe(false);
    expect(parseWhoami("").ok).toBe(false);
  });
});
