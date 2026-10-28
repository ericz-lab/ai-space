import { expect, test } from "bun:test";
import { cliCell, cliColumns, decodeInventory, lastChecked, machineNote, usableClis } from "./inventory.ts";

const body = {
  machines: [
    {
      machine: "",
      via: "local",
      clis: [
        { cli: "claude", kind: "claude", installed: true, signedIn: true, version: "2.1.0", path: "/usr/bin/claude", checkedAt: "2026-10-27T10:00:00Z", configured: true, runtimes: ["claude"] },
        { cli: "codex", kind: "codex", installed: true, signedIn: false, checkedAt: "2026-10-27T11:00:00Z", configured: false, runtimes: [] },
        { cli: "gemini", kind: "gemini", installed: false, configured: false, runtimes: [] },
        { kind: "broken" },
      ],
    },
    { machine: "david", via: "peer", stale: true, clis: [{ cli: "claude", kind: "claude", configured: true, runtimes: ["claude"] }] },
    { machine: "old", via: "peer", old: true, clis: [] },
    { machine: "box", via: "ssh", reachable: false, clis: [] },
    { via: "local" },
  ],
};

test("the inventory decodes, skipping malformed rows", () => {
  const rows = decodeInventory(body);
  expect(rows.map((r) => r.machine)).toEqual(["", "david", "old", "box"]);
  expect(rows[0]!.clis.map((c) => c.cli)).toEqual(["claude", "codex", "gemini"]);
  expect(cliColumns(rows)).toEqual(["claude", "codex", "gemini"]);
  expect(lastChecked(rows)).toBe("2026-10-27T11:00:00Z");
  expect(rows.map(machineNote)).toEqual([undefined, "clis.offline", "clis.old", "clis.unreachable"]);
  expect(decodeInventory({})).toEqual([]);
});

test("cells as the web's CliCell shows them", () => {
  const [here, david] = decodeInventory(body);
  expect(cliCell(here!.clis[0], true)).toEqual({ kind: "found", version: "2.1.0", sign: "clis.signedIn", signTone: "ok", runtime: { text: "clis.runtime", names: "claude" }, tip: "/usr/bin/claude" });
  expect(cliCell(here!.clis[1], true)).toMatchObject({ sign: "clis.signedOut", signTone: "warn", runtime: "add" });
  expect(cliCell(here!.clis[1], false)).toMatchObject({ runtime: { text: "clis.notConfigured" } });
  expect(cliCell(here!.clis[2], true)).toEqual({ kind: "dim", text: "clis.missing" });
  expect(cliCell(david!.clis[0], false)).toEqual({ kind: "dim", text: "clis.unknown" });
  expect(cliCell(undefined, false)).toEqual({ kind: "dim", text: "clis.unknown" });
});

test("the chat's machine menu names the CLIs a machine can run", () => {
  const rows = decodeInventory(body);
  expect(usableClis(rows, undefined)).toEqual(["claude"]);
  expect(usableClis(rows, "david")).toEqual([]);
});
