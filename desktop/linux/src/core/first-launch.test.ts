import { describe, expect, test } from "bun:test";
import { LOCAL_DEFAULT_URL } from "./connections.ts";
import {
  answersAsSpace,
  candidatePorts,
  type Clock,
  findLocalSpace,
  INSTALLER_ENV,
  INSTALLER_URL,
  installerCommand,
  installerEnviron,
  installerProblem,
  installerUrl,
  INSTALL_STAGES,
  InstallProgress,
  installStageOf,
  installLocalSpace,
  localSpaceUrl,
  outputTail,
  portFromEnv,
  type Probe,
  waitForLocalSpace,
  workspaceEnvFile,
} from "./first-launch.ts";

const IDENTITY = JSON.stringify({ product: "ai-space", api: 1, version: "0.3.0", edition: "server" });

/** A clock that only moves when something sleeps. */
function fakeClock(): Clock & { slept: number[] } {
  let t = 1_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
}

/** Answers per URL; anything else refuses the connection. */
function probeOf(answers: Record<string, { status: number; body: string }>): Probe & { asked: string[] } {
  const asked: string[] = [];
  const probe = async (url: string) => {
    asked.push(url);
    const a = answers[url];
    if (!a) throw new Error("connection refused");
    return a;
  };
  return Object.assign(probe, { asked });
}

describe("looking for a Space on this computer", () => {
  test("the workspace's .env is under SPACE_HOME, else ~/.ai-space", () => {
    expect(workspaceEnvFile("/home/ada")).toBe("/home/ada/.ai-space/.env");
    expect(workspaceEnvFile("/home/ada/", "")).toBe("/home/ada/.ai-space/.env");
    expect(workspaceEnvFile("/home/ada", "/srv/space/")).toBe("/srv/space/.env");
  });

  test("SPACE_PORT is read from the .env text", () => {
    expect(portFromEnv("SPACE_HOST=127.0.0.1\nSPACE_PORT=8710\n")).toBe(8710);
    expect(portFromEnv('export SPACE_PORT="9000"\n')).toBe(9000);
    expect(portFromEnv("# SPACE_PORT=8710\n")).toBeUndefined();
    expect(portFromEnv("SPACE_PORT=\n")).toBeUndefined();
    expect(portFromEnv("SPACE_PORT=http\n")).toBeUndefined();
    expect(portFromEnv("SPACE_PORT=0\n")).toBeUndefined();
    expect(portFromEnv("SPACE_PORT=70000\n")).toBeUndefined();
    expect(portFromEnv("")).toBeUndefined();
  });

  test("the candidates are the workspace's port, then 8700", () => {
    expect(candidatePorts()).toEqual([8700]);
    expect(candidatePorts("SPACE_NAME=home\n")).toEqual([8700]);
    expect(candidatePorts("SPACE_PORT=8710\n")).toEqual([8710, 8700]);
    expect(candidatePorts("SPACE_PORT=8700\n")).toEqual([8700]);
  });

  test("the standard port's address is the one the app already saves", () => {
    expect(localSpaceUrl(8700)).toBe(LOCAL_DEFAULT_URL);
    expect(localSpaceUrl(8710)).toBe("http://127.0.0.1:8710/");
  });

  test("only JSON that says product ai-space is a Space", () => {
    expect(answersAsSpace(200, IDENTITY)).toBe(true);
    expect(answersAsSpace(200, JSON.stringify({ product: "ai-space", api: 99 }))).toBe(true);
    expect(answersAsSpace(200, JSON.stringify({ product: "other" }))).toBe(false);
    expect(answersAsSpace(200, "<html>a router</html>")).toBe(false);
    expect(answersAsSpace(200, "null")).toBe(false);
    expect(answersAsSpace(200, '"ai-space"')).toBe(false);
    expect(answersAsSpace(404, IDENTITY)).toBe(false);
    expect(answersAsSpace(302, "")).toBe(false);
  });

  test("the first candidate that answers as a Space is found", async () => {
    const both = probeOf({ "http://127.0.0.1:8710/api/space": { status: 200, body: IDENTITY }, "http://127.0.0.1:8700/api/space": { status: 200, body: IDENTITY } });
    expect(await findLocalSpace([8710, 8700], both)).toBe("http://127.0.0.1:8710/");
    expect(both.asked).toEqual(["http://127.0.0.1:8710/api/space"]);

    const second = probeOf({ "http://127.0.0.1:8700/api/space": { status: 200, body: IDENTITY } });
    expect(await findLocalSpace([8710, 8700], second)).toBe("http://127.0.0.1:8700/");
    expect(second.asked).toEqual(["http://127.0.0.1:8710/api/space", "http://127.0.0.1:8700/api/space"]);
  });

  test("another program on the port, or nothing, is not found", async () => {
    expect(await findLocalSpace([8700], probeOf({ "http://127.0.0.1:8700/api/space": { status: 200, body: "<html></html>" } }))).toBeUndefined();
    expect(await findLocalSpace([8700], probeOf({ "http://127.0.0.1:8700/api/space": { status: 404, body: "" } }))).toBeUndefined();
    expect(await findLocalSpace([8700], probeOf({}))).toBeUndefined();
  });

  test("waiting looks again until a Space answers", async () => {
    const clock = fakeClock();
    let looks = 0;
    const url = await waitForLocalSpace(async () => (++looks < 4 ? undefined : "http://127.0.0.1:8700/"), clock);
    expect(url).toBe("http://127.0.0.1:8700/");
    expect(looks).toBe(4);
    expect(clock.slept).toEqual([1000, 1000, 1000]);
  });

  test("waiting gives up after about 30 seconds", async () => {
    const clock = fakeClock();
    let looks = 0;
    expect(await waitForLocalSpace(async () => void looks++, clock)).toBeUndefined();
    expect(looks).toBe(31);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(30_000);
  });

  test("a slow look counts against the time", async () => {
    const clock = fakeClock();
    let looks = 0;
    // Each look takes 4 s (two candidates timing out).
    const find = async () => {
      looks++;
      await clock.sleep(4000);
      return undefined;
    };
    expect(await waitForLocalSpace(find, clock)).toBeUndefined();
    expect(looks).toBeLessThanOrEqual(7);
  });
});

describe("the installer", () => {
  test("comes from the latest release, or from AI_SPACE_DOWNLOAD", () => {
    expect(INSTALLER_URL).toBe("https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh");
    expect(installerUrl()).toBe(INSTALLER_URL);
    expect(installerUrl("")).toBe(INSTALLER_URL);
    expect(installerUrl("  ")).toBe(INSTALLER_URL);
    expect(installerUrl("https://mirror.example/ai-space")).toBe("https://mirror.example/ai-space/install.sh");
    expect(installerUrl("file:///tmp/rel/")).toBe("file:///tmp/rel/install.sh");
  });

  test("is run by bash, told not to open a browser", () => {
    expect(installerCommand("/tmp/x/install.sh")).toEqual(["bash", "/tmp/x/install.sh"]);
    expect(INSTALLER_ENV).toEqual({ AI_SPACE_NO_OPEN: "1" });
    expect(installerEnviron(["HOME=/home/ada", "AI_SPACE_NO_OPEN=", "AI_SPACE_DOWNLOAD=file:///rel", "A=b=c"])).toEqual(["HOME=/home/ada", "AI_SPACE_DOWNLOAD=file:///rel", "A=b=c", "AI_SPACE_NO_OPEN=1"]);
  });

  test("a download that is not the script is refused", () => {
    expect(installerProblem(200, "#!/usr/bin/env bash\nset -e\n")).toBeUndefined();
    expect(installerProblem(404, "Not Found")).toBe("HTTP 404");
    expect(installerProblem(200, "<!doctype html><title>Sign in</title>")).toBe("not a shell script");
  });

  test("the tail is the last lines, without the empty end", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    expect(outputTail([...lines, "", " "], 3)).toEqual(["line 18", "line 19", "line 20"]);
    expect(outputTail(["only"], 3)).toEqual(["only"]);
    expect(outputTail([], 3)).toEqual([]);
  });

  /** The installer's world, with nothing real behind it. */
  function world(opts: { download?: () => Promise<string>; code?: number | Error; output?: string[]; answersAfter?: number } = {}) {
    const clock = fakeClock();
    const seen: { downloaded: string[]; ran: { argv: string[]; env: Record<string, string> }[]; cleaned: string[]; lines: string[]; starting: number; looks: number } = { downloaded: [], ran: [], cleaned: [], lines: [], starting: 0, looks: 0 };
    const run = (downloadBase?: string) =>
      installLocalSpace({
        downloadBase,
        download: async (url) => {
          seen.downloaded.push(url);
          return opts.download ? opts.download() : "/tmp/ai-space-desktop-abc/install.sh";
        },
        run: async (argv, env, onLine) => {
          seen.ran.push({ argv, env });
          for (const l of opts.output ?? ["ai-space: downloading", "ai-space is running."]) onLine(l);
          if (opts.code instanceof Error) throw opts.code;
          return opts.code ?? 0;
        },
        cleanup: (file) => seen.cleaned.push(file),
        find: async () => (++seen.looks > (opts.answersAfter ?? 2) ? "http://127.0.0.1:8700/" : undefined),
        clock,
        onLine: (l) => seen.lines.push(l),
        onStarting: () => seen.starting++,
      });
    return { run, seen, clock };
  }

  test("exit 0: looks again until the Space answers, then it is the result", async () => {
    const w = world();
    expect(await w.run()).toEqual({ ok: true, url: "http://127.0.0.1:8700/" });
    expect(w.seen.downloaded).toEqual([INSTALLER_URL]);
    expect(w.seen.ran).toEqual([{ argv: ["bash", "/tmp/ai-space-desktop-abc/install.sh"], env: { AI_SPACE_NO_OPEN: "1" } }]);
    expect(w.seen.lines).toEqual(["ai-space: downloading", "ai-space is running."]);
    expect(w.seen.cleaned).toEqual(["/tmp/ai-space-desktop-abc/install.sh"]);
    expect(w.seen.starting).toBe(1);
    expect(w.seen.looks).toBe(3);
  });

  test("AI_SPACE_DOWNLOAD names where the installer is", async () => {
    const w = world();
    await w.run("file:///rel");
    expect(w.seen.downloaded).toEqual(["file:///rel/install.sh"]);
  });

  test("a code other than 0: the output's tail, and no look", async () => {
    const w = world({ code: 1, output: ["ai-space: looking for the latest release", "ai-space install: curl is not installed", ""] });
    expect(await w.run()).toEqual({ ok: false, reason: "failed", code: 1, tail: ["ai-space: looking for the latest release", "ai-space install: curl is not installed"] });
    expect(w.seen.looks).toBe(0);
    expect(w.seen.starting).toBe(0);
    expect(w.seen.cleaned).toHaveLength(1);
  });

  test("bash that cannot be started is a failure with its reason", async () => {
    const w = world({ code: new Error("bash: no such file"), output: [] });
    expect(await w.run()).toEqual({ ok: false, reason: "failed", code: -1, tail: ["bash: no such file"] });
    expect(w.seen.cleaned).toHaveLength(1);
  });

  test("a failed download runs nothing", async () => {
    const w = world({ download: () => Promise.reject(new Error("HTTP 404")) });
    expect(await w.run()).toEqual({ ok: false, reason: "download", tail: ["HTTP 404"] });
    expect(w.seen.ran).toEqual([]);
    expect(w.seen.cleaned).toEqual([]);
    expect(w.seen.lines).toEqual(["HTTP 404"]);
  });

  test("exit 0 but no Space within the time", async () => {
    const w = world({ answersAfter: 1000 });
    const r = await w.run();
    expect(r).toEqual({ ok: false, reason: "silent", tail: ["ai-space: downloading", "ai-space is running."] });
    expect(w.seen.looks).toBe(31);
  });
});

describe("the install progress bar", () => {
  test("the installer's lines mark its steps, on Linux and Windows alike", () => {
    expect(installStageOf("ai-space: looking for the latest release for linux-x64")).toBe("looking");
    expect(installStageOf("ai-space: downloading ai-space-0.3.0-linux-x64.tar.gz")).toBe("downloading");
    expect(installStageOf("ai-space 0.3.0 (bd7cae0) in /home/a/.local/share/ai-space/releases/0.3.0")).toBe("placing");
    expect(installStageOf("ai-space 0.3.0 (bd7cae0) in C:\\Users\\a\\AppData\\Local\\ai-space\\releases\\0.3.0")).toBe("placing");
    expect(installStageOf("ai-space core: installed, answering on 127.0.0.1:8700 (workspace /home/a/.ai-space)")).toBe("apps");
    expect(installStageOf("ai-space is running. Open the panel: http://127.0.0.1:8700/")).toBe("starting");
    expect(installStageOf("default apps: an installer failed")).toBeUndefined();
  });

  test("the bar only goes forward and stays below 1", () => {
    let t = 1_000_000;
    const p = new InstallProgress(t);
    let last = p.value(t);
    expect(last).toBe(0);
    for (const line of ["ai-space: looking for x", "ai-space: downloading x.tar.gz", "noise", "ai-space 0.3.0 (abc) in /x", "ai-space core: installed, answering", "ai-space is running."]) {
      t += 600_000;
      const creeping = p.value(t);
      expect(creeping).toBeGreaterThanOrEqual(last);
      p.read(line, t);
      last = p.value(t);
      expect(last).toBeGreaterThanOrEqual(creeping);
    }
    expect(p.stage).toBe("starting");
    expect(p.value(t + 3_600_000)).toBeLessThan(1);
    p.read("ai-space: downloading again", t);
    expect(p.stage).toBe("starting");
  });

  test("the ceilings rise and stay below 1", () => {
    for (let i = 1; i < INSTALL_STAGES.length; i++) expect(INSTALL_STAGES[i - 1]!.to).toBeLessThan(INSTALL_STAGES[i]!.to);
    expect(INSTALL_STAGES.at(-1)!.to).toBeLessThan(1);
  });

  test("a step that ends early makes no jump", () => {
    const p = new InstallProgress(0);
    const before = p.value(1_000);
    p.read("ai-space: downloading x.tar.gz", 1_000);
    expect(p.value(1_000)).toBeCloseTo(before, 9);
    expect(p.value(2_000)).toBeGreaterThan(before);
  });

  test("steps of their usual length move the bar evenly", () => {
    // Each step taking its usual length, the bar moves at one pace, 1 % at most off a straight line.
    const total = INSTALL_STAGES.reduce((sum, s) => sum + s.seconds, 0);
    const p = new InstallProgress(0);
    let t = 0;
    for (const s of INSTALL_STAGES) {
      p.enter(s.stage, t);
      for (let x = 0; x < s.seconds; x += 0.5) {
        const at = t + x * 1000;
        expect(Math.abs(p.value(at) - (0.95 * at) / 1000 / total)).toBeLessThanOrEqual(0.01);
      }
      t += s.seconds * 1000;
    }
  });
});
