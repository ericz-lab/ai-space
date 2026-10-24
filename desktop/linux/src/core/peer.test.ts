import { expect, test } from "bun:test";
import { loadPeers } from "../../../../src/space/peers/config.ts";
import { quoteEnvValue as serverQuote, updateEnvText as serverUpdate } from "../../../../src/space/setup.ts";
import { hubLines, parseEnvText, parseSshTarget, peerEnvKey, peerSideUpdates, readPeerSide, readTunnelUnit, renderTunnelUnit, suggestPeerName, tokenHex, tunnelAddress, updateEnvText, validPeerName, quoteEnvValue } from "./peer.ts";

const SAMPLE = ["# workspace", "SPACE_PORT=8700", "# SPACE_HUB_TOKEN=", 'export SPACE_NAME="old name"', "", "OTHER='x y'", ""].join("\n");

test(".env edits match `space setup`, apart from the header", () => {
  const updates = { SPACE_HUB_TOKEN: "abc", SPACE_NAME: "laptop", SPACE_TERMINAL_ENABLED: "1", EMPTY: "" };
  const ours = updateEnvText(SAMPLE, updates);
  const theirs = serverUpdate(SAMPLE, updates);
  expect(ours.replace(/^# Added by .*$/m, "#")).toBe(theirs.replace(/^# Added by .*$/m, "#"));
  expect(updateEnvText("", { A: "1" })).toBe("# Added by the AI Space app (Settings › Peer)\nA=1\n");
  for (const v of ["", "plain", "has space", 'q"uote', "back\\slash", "#hash"]) expect(quoteEnvValue(v)).toBe(serverQuote(v));
});

test("reading the .env as the service does", () => {
  const env = parseEnvText(updateEnvText(SAMPLE, { SPACE_HUB_TOKEN: "t0k", SPACE_TERMINAL_ENABLED: "yes" }));
  expect(env.SPACE_NAME).toBe("old name");
  expect(env.OTHER).toBe("x y");
  expect(readPeerSide(env)).toEqual({ enabled: true, token: "t0k", name: "old name", terminal: true, port: 8700 });
  expect(readPeerSide({ SPACE_PORT: "nope" })).toEqual({ enabled: false, token: "", name: "", terminal: false, port: 8700 });
  expect(peerSideUpdates({ enabled: false, token: "t", name: "a", terminal: false })).toEqual({ SPACE_HUB_TOKEN: "", SPACE_NAME: "a", SPACE_TERMINAL_ENABLED: "0" });
});

test("peer names and the hub's lines round-trip through the hub's own parser", () => {
  expect(suggestPeerName("Eric-ThinkPad.local")).toBe("eric-thinkpad");
  expect(suggestPeerName("___")).toBe("computer");
  expect(validPeerName("laptop-2")).toBe(true);
  expect(validPeerName("a.b")).toBe(false);
  expect(validPeerName("Laptop")).toBe(false);
  expect(peerEnvKey("laptop-2")).toBe("SPACE_PEER_LAPTOP_2");
  const text = hubLines("laptop-2", tunnelAddress(8711), "deadbeef", "CF-Access-Client-Id: x; CF-Access-Client-Secret: y");
  const { peers, errors } = loadPeers(parseEnvText(text));
  expect(errors.size).toBe(0);
  expect(peers).toHaveLength(1);
  expect(peers[0]!.name).toBe("laptop-2");
  expect(peers[0]!.url.toString()).toBe("http://127.0.0.1:8711");
  expect(peers[0]!.token).toBe("deadbeef");
  expect(Object.keys(peers[0]!.headers)).toHaveLength(2);
  expect(hubLines("a", "https://a.example.com", "t").split("\n")).toHaveLength(2);
  expect(tokenHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
});

test("SSH targets", () => {
  expect(parseSshTarget("hub")).toEqual({ dest: "hub" });
  expect(parseSshTarget(" me@hub.example.com ")).toEqual({ dest: "me@hub.example.com" });
  expect(parseSshTarget("ssh://me@10.0.0.2:2222")).toEqual({ dest: "me@10.0.0.2", port: 2222 });
  for (const bad of ["", "-oProxyCommand=x", "me@hub; rm", "a b", "hub:99999"]) expect(parseSshTarget(bad)).toBeUndefined();
});

test("the tunnel unit is written and read back", () => {
  const unit = renderTunnelUnit({ ssh: "/usr/bin/ssh", target: "ssh://me@hub:2222", hubPort: 8711, localPort: 8700 });
  expect(unit).toContain("ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -p 2222 -R 127.0.0.1:8711:127.0.0.1:8700 me@hub\n");
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("WantedBy=default.target");
  expect(readTunnelUnit(unit)).toEqual({ target: "me@hub:2222", hubPort: 8711, localPort: 8700 });
  expect(readTunnelUnit("[Service]\n")).toBeUndefined();
  expect(() => renderTunnelUnit({ ssh: "ssh", target: "-x", hubPort: 8711, localPort: 8700 })).toThrow();
  expect(() => renderTunnelUnit({ ssh: "ssh", target: "hub", hubPort: 80, localPort: 8700 })).toThrow();
});
