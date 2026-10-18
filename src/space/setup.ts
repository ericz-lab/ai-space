import { chmod } from "node:fs/promises";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { cfCommands, parseWhoami, renderCfScript } from "./cloudflare.ts";
import { TRANSPORTS, parseChannelUrl } from "./notify/index.ts";
import type { Channel, ChannelKind } from "./notify/types.ts";
import { PEER_NAME_RE } from "./peers/config.ts";
import type { Workspace } from "./workspace.ts";

/**
 * `bun src/index.ts setup`: the interactive first-install walk-through.
 *
 * The basic install first: the tools it needs (bun, git, one AI runtime, a user service
 * manager), the core values and who runs the apps' services. Then the optional extensions
 * (github, ingress, backup, notifications, peers), each only when picked, or on its own as
 * `setup <extension>`; an extension's tools are checked only when it is on, so a machine
 * with no GitHub, Cloudflare, domain or bucket completes the basic install. Verifies what
 * can be verified from the machine (a test message, one S3 list call), writes
 * `<workspace>/.env` keeping every line it does not touch, and ends with the state of the
 * basic install and of each extension. Re-runnable: existing values are the defaults.
 * The full procedure is in docs/install.md.
 *
 * Every side effect goes through `SetupDeps`, so the flow runs unchanged
 * under a scripted terminal in tests.
 */

export type AskOptions = {
  /** Shown in brackets and returned on an empty answer. */
  default?: string;
  /** Mask the current value in the prompt (the default is still used). */
  secret?: boolean;
  /** Accepted answers; asked again otherwise. */
  choices?: readonly string[];
};

export type SetupIO = {
  ask(question: string, opts?: AskOptions): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  say(line?: string): void;
};

export type RunResult = { code: number; stdout: string; stderr: string };

export type SetupDeps = {
  io: SetupIO;
  ws: Workspace;
  /** Values in force now: the process environment with `.env` loaded. */
  env: Record<string, string | undefined>;
  /** Resolve a command on PATH; undefined when absent. */
  which(cmd: string): Promise<string | undefined>;
  /** Run a command and capture it; never throws (a missing binary is a non-zero code). */
  run(cmd: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** One `list` call against a bucket with the given credentials; throws on failure. */
  probeS3(t: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string }): Promise<void>;
  /** Send one message through a channel; throws on failure. */
  sendTest(channel: Channel, name: string): Promise<void>;
  fetch: typeof fetch;
  randomToken(): string;
  hostname(): string;
};

export type SetupOutcome = {
  /** Keys written, in order; secrets included (the caller masks when printing). */
  written: string[];
  /** Basic-install checks that did not pass (empty for `setup <extension>`). */
  missing: string[];
  /** The state of each extension reported at the end. */
  extensions: Partial<Record<Extension, ExtensionState>>;
  restarted: boolean;
};

/* ------------------------------------------------------------------------ */
/* .env editing                                                             */
/* ------------------------------------------------------------------------ */

const SECRET_RE = /(TOKEN|SECRET|KEY|PASSWORD)/;
const HEADER = "# Added by `bun src/index.ts setup`";

/** True for keys whose values are masked in the summary. */
export function isSecretKey(key: string): boolean {
  if (key === "SPACE_NOTIFY_TASKS" || key.endsWith("_ENABLED")) return false;
  return SECRET_RE.test(key) || key.startsWith("SPACE_NOTIFY_") || key === "SPACE_PG_ADMIN_URL";
}

export function mask(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Quote a value the way `loadWorkspaceEnv` reads it back. */
export function quoteEnvValue(value: string): string {
  return /[\s#"']/.test(value) || value === "" ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

/**
 * Apply `updates` to the text of a `.env` file: a `KEY=` line is replaced in
 * place, a commented `# KEY=` line is uncommented and replaced, anything else
 * is appended under one header. Every other line stays as it is.
 */
export function updateEnvText(text: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  const out: string[] = [];
  for (const raw of lines) {
    const m = /^(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(raw);
    const key = m?.[1];
    if (key && pending.has(key)) {
      out.push(`${key}=${quoteEnvValue(pending.get(key)!)}`);
      pending.delete(key);
    } else {
      out.push(raw);
    }
  }
  if (pending.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(HEADER);
    for (const [k, v] of pending) out.push(`${k}=${quoteEnvValue(v)}`);
  }
  return `${out.join("\n")}\n`;
}

/* ------------------------------------------------------------------------ */
/* Channel URL building                                                     */
/* ------------------------------------------------------------------------ */

export const CHANNEL_KINDS: readonly ChannelKind[] = ["telegram", "feishu", "discord", "slack", "dingtalk", "wecom", "bark", "ntfy", "webhook"];

type Field = { key: string; prompt: string; secret?: boolean; optional?: boolean; default?: string };

/** What each kind asks for, in order, and how the answers become a channel URL. */
export const CHANNEL_FORMS: Record<ChannelKind, { fields: Field[]; build: (a: Record<string, string>) => string; hint: string }> = {
  telegram: {
    hint: "@BotFather → /newbot gives the token; message the bot (or add it to a group) so the chat id can be looked up",
    fields: [
      { key: "token", prompt: "Bot token", secret: true },
      { key: "chat", prompt: "Chat id (negative for groups; several separated by commas)" },
      { key: "thread", prompt: "Topic (thread) id", optional: true },
    ],
    build: (a) => `telegram://${a.token}@${a.chat}${a.thread ? `?thread=${a.thread}` : ""}`,
  },
  feishu: {
    hint: "group settings → Bots → Custom bot; enable signature verification for the secret",
    fields: [
      { key: "host", prompt: "Host (open.larksuite.com for Lark)", default: "open.feishu.cn" },
      { key: "token", prompt: "Webhook token (the part after /hook/)", secret: true },
      { key: "secret", prompt: "Signing secret", secret: true, optional: true },
    ],
    build: (a) => `feishu://${a.host}/open-apis/bot/v2/hook/${a.token}${a.secret ? `?secret=${a.secret}` : ""}`,
  },
  discord: {
    hint: "channel → Integrations → Webhooks → copy the URL: https://discord.com/api/webhooks/<id>/<token>",
    fields: [
      { key: "id", prompt: "Webhook id" },
      { key: "token", prompt: "Webhook token", secret: true },
    ],
    build: (a) => `discord://${a.id}/${a.token}`,
  },
  slack: {
    hint: "Incoming webhook URL: https://hooks.slack.com/services/<a>/<b>/<c>",
    fields: [{ key: "path", prompt: "The part after hooks.slack.com/services/", secret: true }],
    build: (a) => `slack://hooks.slack.com/services/${a.path}`,
  },
  dingtalk: {
    hint: "group → Robot → Custom; the webhook carries access_token, enable signing for the secret",
    fields: [
      { key: "token", prompt: "access_token", secret: true },
      { key: "secret", prompt: "Signing secret", secret: true, optional: true },
    ],
    build: (a) => `dingtalk://oapi.dingtalk.com/robot/send?access_token=${a.token}${a.secret ? `&secret=${a.secret}` : ""}`,
  },
  wecom: {
    hint: "group → Add group robot; the webhook carries key=",
    fields: [{ key: "key", prompt: "Robot key", secret: true }],
    build: (a) => `wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${a.key}`,
  },
  bark: {
    hint: "the Bark app shows https://<host>/<device_key>",
    fields: [
      { key: "host", prompt: "Host", default: "api.day.app" },
      { key: "key", prompt: "Device key", secret: true },
    ],
    build: (a) => `bark://${a.host}/${a.key}`,
  },
  ntfy: {
    hint: "a topic on ntfy.sh or your own server",
    fields: [
      { key: "host", prompt: "Host", default: "ntfy.sh" },
      { key: "topic", prompt: "Topic" },
      { key: "token", prompt: "Access token", secret: true, optional: true },
    ],
    build: (a) => `ntfy://${a.host}/${a.topic}${a.token ? `?token=${a.token}` : ""}`,
  },
  webhook: {
    hint: "any endpoint that accepts a JSON POST",
    fields: [
      { key: "host", prompt: "Host" },
      { key: "path", prompt: "Path", default: "/" },
      { key: "token", prompt: "Bearer token", secret: true, optional: true },
    ],
    build: (a) => `webhook://${a.host}${(a.path ?? "/").startsWith("/") ? a.path : `/${a.path}`}${a.token ? `?token=${a.token}` : ""}`,
  },
  stdout: { hint: "", fields: [], build: () => "stdout://" },
};

/* ------------------------------------------------------------------------ */
/* Tool checks                                                              */
/* ------------------------------------------------------------------------ */

/** `optional`: a failure is shown with its hint but not counted as missing. */
type Check = { name: string; ok: boolean; detail: string; hint?: string; optional?: boolean };

/**
 * What the basic install needs: bun, git with an identity (a new app is a local repository),
 * one AI runtime that answers, and a user service manager when the space runs the apps' services.
 * Nothing here needs an account other than the runtime's, a domain, or a network service.
 */
export async function checkBasicTools(d: SetupDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const bun = await d.run(["bun", "--version"]);
  checks.push({ name: "bun", ok: bun.code === 0, detail: bun.stdout.trim(), hint: "curl -fsSL https://bun.sh/install | bash" });
  const git = await d.run(["git", "--version"]);
  checks.push({ name: "git", ok: git.code === 0, detail: git.stdout.trim(), hint: "apt-get install git" });
  const gitUser = await d.run(["git", "config", "--global", "user.email"]);
  checks.push({
    name: "git identity",
    ok: gitUser.code === 0 && gitUser.stdout.trim() !== "",
    detail: gitUser.stdout.trim(),
    hint: 'git config --global user.name "…" && git config --global user.email "…"',
  });

  // One runtime is enough: each is shown, and only "none answers" counts as missing.
  const runtimes: Check[] = [];
  const claudeBin = (d.env.SPACE_CHAT_BIN?.trim().split(/\s+/)[0] ?? "") || "claude";
  if (await d.which(claudeBin)) {
    const v = await d.run([claudeBin, "--version"]);
    const smoke = await d.run([claudeBin, "-p", "Reply with the single word ok", "--output-format", "json", "--model", "haiku"], { timeoutMs: 90_000 });
    const loggedIn = smoke.code === 0 && /"result"/.test(smoke.stdout);
    runtimes.push({
      name: "claude",
      ok: loggedIn,
      detail: loggedIn ? v.stdout.trim() : (smoke.stderr || smoke.stdout).trim().split("\n").slice(-1)[0] ?? "",
      hint: "run `claude` once and /login (or put ANTHROPIC_API_KEY in the workspace .env)",
      optional: true,
    });
  }
  if (await d.which("codex")) {
    const status = await d.run(["codex", "login", "status"], { timeoutMs: 30_000 });
    const loggedIn = status.code === 0;
    runtimes.push({ name: "codex", ok: loggedIn, detail: (status.stdout || status.stderr).trim().split("\n")[0] ?? "", hint: "codex login", optional: true });
  }
  checks.push(...runtimes);
  if (!runtimes.some((r) => r.ok)) {
    checks.push({
      name: "AI runtime",
      ok: false,
      detail: runtimes.length ? "none logged in" : "neither claude nor codex on PATH",
      hint: "install and log in to one: curl -fsSL https://claude.ai/install.sh | bash, or Codex (docs/runtimes.md)",
    });
  }

  // Service supervision (docs/supervision.md) needs a user manager: systemd's outliving the login session, or launchd's GUI domain.
  const sd = await userSystemd(d);
  if (sd) checks.push({ name: "systemd user", ok: sd.ok, detail: sd.detail, hint: `sudo loginctl enable-linger ${d.env.USER ?? "$USER"} (SPACE_SUPERVISOR=space needs it; docs/supervision.md)` });
  const ld = sd ? undefined : await userLaunchd(d);
  if (ld) checks.push({ name: "launchd", ok: ld.ok, detail: ld.detail, hint: "log in on the Mac (automatic login keeps a session after a reboot); SPACE_SUPERVISOR=space needs it (docs/supervision.md#macos)" });
  return checks;
}

/**
 * Whether this machine can run `SPACE_SUPERVISOR=space`: a systemd user manager that answers and
 * lingering on, so the units keep running with nobody logged in. Undefined without systemd at all.
 */
export async function userSystemd(d: SetupDeps): Promise<{ ok: boolean; detail: string } | undefined> {
  if (!(await d.which("systemctl"))) return undefined;
  const manager = await d.run(["systemctl", "--user", "is-system-running"]);
  if (!/^(running|degraded|starting|initializing|maintenance)/.test(manager.stdout.trim())) return { ok: false, detail: "no user manager answers (systemctl --user)" };
  const linger = await d.run(["loginctl", "show-user", d.env.USER ?? "", "-p", "Linger"]);
  if (linger.stdout.trim() !== "Linger=yes") return { ok: false, detail: "user manager up, lingering off: units stop at logout" };
  return { ok: true, detail: "user manager, lingering on" };
}

/**
 * Whether this Mac can run `SPACE_SUPERVISOR=space`: a launchd GUI domain for the user, where the
 * space's LaunchAgents load now and at every login. Undefined without launchd at all.
 */
export async function userLaunchd(d: SetupDeps): Promise<{ ok: boolean; detail: string } | undefined> {
  if (!(await d.which("launchctl"))) return undefined;
  const r = await d.run(["launchctl", "print", `gui/${process.getuid?.() ?? 0}`]);
  if (r.code !== 0) return { ok: false, detail: "no GUI session for this user (launchctl print gui/<uid>)" };
  return { ok: true, detail: "GUI session: LaunchAgents load now and at login" };
}

/* ------------------------------------------------------------------------ */
/* Extensions                                                               */
/* ------------------------------------------------------------------------ */

/**
 * What a space can do beyond the basic install, each added on its own, after it and in any order
 * (`space setup <extension>`). None is needed to install, start or use a space on loopback.
 */
export const EXTENSIONS = ["github", "ingress", "backup", "notifications", "peers"] as const;
export type Extension = (typeof EXTENSIONS)[number];

export const EXTENSION_TITLES: Record<Extension, string> = {
  github: "GitHub: new apps get a repository under your account (gh)",
  ingress: "Outside access: the panel and apps on a domain, through a tunnel and an access layer (e.g. Cloudflare)",
  backup: "Backups: daily snapshots to an S3-compatible bucket (e.g. Cloudflare R2) or a directory",
  notifications: "Notifications: a chat channel for task failures and app messages",
  peers: "Peers: one panel over several machines",
};

/** `off`: not turned on; `on`: turned on and its tools pass; `incomplete`: turned on, something missing. */
export type ExtensionState = "off" | "on" | "incomplete";
export type ExtensionReport = { state: ExtensionState; checks: Check[] };

/**
 * Where the tunnel's connector runs: the user unit of install.md, a system unit from
 * `cloudflared service install`, or any running cloudflared (a LaunchAgent on a Mac).
 */
async function tunnelRunning(d: SetupDeps): Promise<string | undefined> {
  if (!(await d.which("cloudflared"))) return undefined;
  if ((await d.run(["systemctl", "--user", "is-active", "cloudflared"])).stdout.trim() === "active") return "tunnel user unit active";
  if ((await d.run(["systemctl", "is-active", "cloudflared"])).stdout.trim() === "active") return "tunnel system unit active";
  if ((await d.run(["pgrep", "-x", "cloudflared"])).code === 0) return "cloudflared running";
  return undefined;
}

/** Whether the values in force turn an extension on (a running tunnel counts as outside access; an installed binary does not). */
export async function extensionEnabled(d: SetupDeps, ext: Extension, env: Record<string, string | undefined>): Promise<boolean> {
  const v = (k: string) => env[k]?.trim() ?? "";
  switch (ext) {
    case "github":
      return Boolean(v("SPACE_GITHUB_OWNER"));
    case "ingress":
      return Boolean(v("SPACE_PANEL_HOST") || v("SPACE_DOMAIN") || v("SPACE_ROUTER") === "caddy" || (await tunnelRunning(d)));
    case "backup":
      return Boolean(v("SPACE_BACKUP_URL") || (v("SPACE_S3_ACCESS_KEY_ID") && v("SPACE_S3_SECRET_ACCESS_KEY") && v("SPACE_S3_BUCKET")));
    case "notifications":
      return Boolean(v("SPACE_NOTIFY_DEFAULT"));
    case "peers":
      return Boolean(v("SPACE_HUB_TOKEN") || Object.keys(env).some((k) => /^SPACE_PEER_[A-Z0-9_]+$/.test(k) && !/_(TOKEN|HEADERS|REFRESH)$/.test(k) && v(k)));
  }
}

/** The tools an extension needs; asked only for an extension that is on. */
export async function checkExtensionTools(d: SetupDeps, ext: Extension, env: Record<string, string | undefined>): Promise<Check[]> {
  const checks: Check[] = [];
  if (ext === "github") {
    if (await d.which("gh")) {
      const gh = await d.run(["gh", "auth", "status"]);
      checks.push({ name: "gh", ok: gh.code === 0, detail: gh.code === 0 ? "logged in" : "not logged in", hint: "gh auth login --web && gh auth setup-git" });
    } else {
      checks.push({ name: "gh", ok: false, detail: "not on PATH", hint: "install GitHub CLI (https://cli.github.com), then gh auth login --web && gh auth setup-git" });
    }
  }
  if (ext === "ingress") {
    if (await d.which("cloudflared")) {
      const running = await tunnelRunning(d);
      checks.push({ name: "cloudflared", ok: Boolean(running), detail: running ?? "installed, not running", hint: "see docs/install.md (outside access)" });
    } else {
      checks.push({ name: "cloudflared", ok: false, detail: "not on PATH", hint: "see docs/install.md (outside access)" });
    }
    // cf makes the Cloudflare changes (docs/cloudflare.md); optional, since any machine with the login can run them.
    if (await d.which("cf")) {
      const who = parseWhoami((await d.run(["cf", "auth", "whoami"], { timeoutMs: 30_000 })).stdout);
      checks.push({ name: "cf", ok: who.ok, detail: who.detail, hint: "cf auth login (or CLOUDFLARE_API_TOKEN); optional", optional: true });
    } else {
      checks.push({ name: "cf", ok: false, detail: "not on PATH", hint: "bun add -g cf (Node 22+; optional: Cloudflare changes, docs/cloudflare.md)", optional: true });
    }
    // The router (docs/router.md): checked when it is on, or when caddy is there anyway.
    const caddy = await d.which("caddy");
    if (env.SPACE_ROUTER?.trim() === "caddy" || caddy) {
      const hint = "see docs/install.md (wildcard and router)";
      if (!caddy) checks.push({ name: "caddy", ok: false, detail: "not on PATH", hint });
      else if (!(await d.which("systemctl"))) checks.push({ name: "caddy", ok: true, detail: "installed (no systemd here; keep it running with a LaunchAgent)", hint });
      else {
        const unit = await d.run(["systemctl", "--user", "is-active", "caddy"]);
        const active = unit.stdout.trim() === "active";
        checks.push({ name: "caddy", ok: active, detail: active ? "router unit active" : "installed, user unit not active", hint });
      }
    }
  }
  if (ext === "backup") {
    for (const tool of ["tar", "zstd"]) {
      const found = await d.which(tool);
      checks.push({ name: tool, ok: Boolean(found), detail: found ?? "not on PATH", hint: `apt-get install ${tool} (backups archive with it; see docs/backup.md)` });
    }
  }
  return checks;
}

export async function extensionReport(d: SetupDeps, ext: Extension, env: Record<string, string | undefined>): Promise<ExtensionReport> {
  if (!(await extensionEnabled(d, ext, env))) return { state: "off", checks: [] };
  const checks = await checkExtensionTools(d, ext, env);
  return { state: checks.every((c) => c.ok || c.optional) ? "on" : "incomplete", checks };
}

/** Parse the extensions picked at the prompt: names separated by commas or spaces; undefined when one is unknown. */
export function parseExtensionList(raw: string): Extension[] | undefined {
  const names = raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.some((n) => !(EXTENSIONS as readonly string[]).includes(n))) return undefined;
  return EXTENSIONS.filter((e) => names.includes(e));
}

/* ------------------------------------------------------------------------ */
/* The walk-through                                                         */
/* ------------------------------------------------------------------------ */

export type SetupOptions = {
  /** Configure this extension only (`space setup <extension>`); the basic questions are skipped. */
  only?: Extension;
};

/** What a section needs: ask, record a change, read the value in force. */
type Section = {
  d: SetupDeps;
  set(k: string, v: string): void;
  current(k: string): string;
  /** The values in force with this run's changes on top. */
  merged(): Record<string, string | undefined>;
};

function sayChecks(io: SetupIO, checks: Check[]): void {
  for (const c of checks) io.say(`  ${c.ok ? "ok  " : "--  "} ${c.name.padEnd(13)} ${c.detail}${c.ok || !c.hint ? "" : `  →  ${c.hint}`}`);
}

export async function runSetup(d: SetupDeps, opts: SetupOptions = {}): Promise<SetupOutcome> {
  const { io } = d;
  const updates: Record<string, string> = {};
  const set = (k: string, v: string) => {
    if ((d.env[k] ?? "") !== v) updates[k] = v;
    else delete updates[k];
  };
  const current = (k: string) => (k in updates ? updates[k]! : (d.env[k]?.trim() ?? ""));
  const sec: Section = { d, set, current, merged: () => ({ ...d.env, ...updates }) };

  io.say(opts.only ? `ai-space setup ${opts.only}` : "ai-space setup");
  io.say(`workspace ${d.ws.home}`);
  io.say(`config    ${d.ws.envFile}`);
  io.say("Enter keeps the value in brackets. Nothing is written before the summary at the end.");
  io.say();

  const missing: string[] = [];
  let selected: Extension[];
  if (opts.only) {
    selected = [opts.only];
  } else {
    /* 1. tools */
    io.say("[1/3] Tools");
    const checks = await checkBasicTools(d);
    sayChecks(io, checks);
    for (const c of checks) if (!c.ok && !c.optional) missing.push(c.name);
    io.say();

    /* 2. core */
    io.say("[2/3] Core");
    set("SPACE_HOST", await io.ask("Bind address (keep loopback; outside access goes through a tunnel)", { default: current("SPACE_HOST") || "127.0.0.1" }));
    set("SPACE_PORT", await askNumber(io, "Port", current("SPACE_PORT") || "8700"));
    const token = current("SPACE_API_TOKEN");
    if (token) {
      io.say(`  SPACE_API_TOKEN is set (${mask(token)}); kept.`);
    } else {
      const t = d.randomToken();
      io.say("  SPACE_API_TOKEN protects the mutating API routes; generated:");
      io.say(`  ${t}`);
      set("SPACE_API_TOKEN", t);
    }
    set("SPACE_MAX_CONCURRENCY", await askNumber(io, "Task runs at the same time (agent tasks hold a slot for minutes)", current("SPACE_MAX_CONCURRENCY") || "4"));
    set("SPACE_CHAT_MODEL", await io.ask("Default chat model", { default: current("SPACE_CHAT_MODEL") || "sonnet" }));
    set("SPACE_NAME", await io.ask("Name of this space (shown in the panel and to other machines)", { default: current("SPACE_NAME") || d.hostname() }));
    io.say();

    /* 3. services */
    io.say("[3/3] Services (docs/supervision.md)");
    await sectionServices(sec);
    io.say();

    /* extensions */
    io.say("Optional extensions (each one later with: space setup <name>)");
    for (const ext of EXTENSIONS) {
      const on = await extensionEnabled(d, ext, sec.merged());
      io.say(`  ${on ? "on " : "off"}  ${ext.padEnd(13)} ${EXTENSION_TITLES[ext]}`);
    }
    for (;;) {
      const picked = parseExtensionList(await io.ask(`Configure any now? (${EXTENSIONS.join(", ")}; Enter for none)`, { default: "" }));
      if (picked) {
        selected = picked;
        break;
      }
      io.say(`  names from: ${EXTENSIONS.join(", ")}`);
    }
    io.say();
  }

  for (const ext of selected) {
    io.say(`[${ext}] ${EXTENSION_TITLES[ext]}`);
    await SECTIONS[ext](sec);
    io.say();
  }

  /* summary and write */
  const keys = Object.keys(updates);
  if (!keys.length) {
    io.say("Nothing changed.");
  } else {
    io.say(`Changes to ${d.ws.envFile}:`);
    for (const k of keys) io.say(`  ${k}=${isSecretKey(k) ? mask(updates[k]!) : updates[k]}`);
    if (await io.confirm("Write them?", true)) {
      const file = Bun.file(d.ws.envFile);
      const text = (await file.exists()) ? await file.text() : "";
      await Bun.write(d.ws.envFile, updateEnvText(text, updates));
      await chmod(d.ws.envFile, 0o600);
      io.say("  written.");
    } else {
      io.say("  not written.");
      keys.length = 0;
      for (const k of Object.keys(updates)) delete updates[k];
    }
  }
  io.say();

  /* restart */
  let restarted = false;
  const unit = await d.run(["systemctl", "--user", "is-enabled", "ai-space"]);
  if (keys.length && unit.stdout.trim() === "enabled") {
    if (await io.confirm("Restart the ai-space unit now?", true)) {
      const r = await d.run(["systemctl", "--user", "restart", "ai-space"]);
      restarted = r.code === 0;
      io.say(restarted ? "  restarted; journalctl --user -u ai-space -n 30" : `  restart failed: ${r.stderr.trim()}`);
    }
  } else if (unit.stdout.trim() !== "enabled") {
    io.say("The ai-space unit is not installed yet: bash deploy/install.sh");
  }

  /* where things stand */
  const env = sec.merged();
  const extensions: Partial<Record<Extension, ExtensionState>> = {};
  io.say();
  if (!opts.only) io.say(missing.length ? `Basic install: missing ${missing.join(", ")} (hints above).` : "Basic install: ready.");
  io.say("Extensions:");
  for (const ext of opts.only ? [opts.only] : EXTENSIONS) {
    const r = await extensionReport(d, ext, env);
    extensions[ext] = r.state;
    io.say(`  ${ext.padEnd(13)} ${r.state}`);
    if (r.state === "incomplete") sayChecks(io, r.checks.filter((c) => !c.ok && !c.optional).map((c) => ({ ...c, name: `  ${c.name}` })));
  }
  io.say();
  if (extensions.ingress === "off") {
    sayLocalAccess(io, env);
  } else if (extensions.ingress !== undefined) {
    const r = await checkExtensionTools(d, "ingress", env);
    if (r.find((c) => c.name === "cloudflared")?.ok) io.say("The tunnel is up. Later Cloudflare changes (a hostname, Access, a bucket) go through cf: docs/cloudflare.md");
    else await sayEdgePlan(d, env);
  }
  return { written: keys, missing, extensions, restarted };
}

/** Without outside access: how to open the panel and the apps from another machine. */
function sayLocalAccess(io: SetupIO, env: Record<string, string | undefined>): void {
  const port = Number(env.SPACE_PORT?.trim() || 8700);
  io.say(`The panel is on http://127.0.0.1:${port}, on this machine only. From another machine:`);
  io.say(`  ssh -L ${port}:127.0.0.1:${port} <this host>     then open http://127.0.0.1:${port}`);
  io.say("  An app with its own port needs that port forwarded the same way (-L <port>:127.0.0.1:<port>);");
  io.say("  a packaged app opens through the gateway port (SPACE_PACKAGE_PORT) when it is on.");
  io.say("Outside access on a domain: space setup ingress");
}

/* ------------------------------------------------------------------------ */
/* Sections                                                                 */
/* ------------------------------------------------------------------------ */

async function sectionServices({ d, set, current }: Section): Promise<void> {
  const { io } = d;
  const operatorTemplates = ["SPACE_SERVICE_STOP", "SPACE_SERVICE_LOGS"].filter((k) => current(k));
  const sd = await userSystemd(d);
  const ld = sd ? undefined : await userLaunchd(d);
  const host = sd ?? ld;
  const was = current("SPACE_SUPERVISOR") || "operator";
  let supervisor = was;
  if (!host?.ok) {
    io.say(`  Only operator here: ${host ? host.detail : "neither systemd nor launchd on this machine"}. The apps' services are units you install.`);
    supervisor = "operator";
  } else {
    io.say(`  space: ai-space writes one ${ld ? "LaunchAgent" : "user unit"} per app and starts, restarts and removes it with the manifest.`);
    io.say("  operator: units you install yourself; ai-space only probes them and stops them on uninstall.");
    // A fresh machine gets the space; one whose .env already names the operator's templates keeps them.
    const def = current("SPACE_SUPERVISOR") || (operatorTemplates.length ? "operator" : "space");
    supervisor = (await io.ask("Who runs the apps' services", { default: def, choices: ["space", "operator"] })).trim();
  }
  if (supervisor !== was) set("SPACE_SUPERVISOR", supervisor);
  if (supervisor === "space" && operatorTemplates.length) {
    for (const k of operatorTemplates) set(k, "");
    io.say(`  ${operatorTemplates.join(" and ")} cleared: they describe the operator's units.`);
    io.say("  Apps whose own unit is still enabled keep running under it and show `conflict` until you");
    io.say("  hand them over (space app supervise <app>), or disable that unit");
    io.say(`  (${ld ? "launchctl bootout gui/$(id -u)/<app> && launchctl disable gui/$(id -u)/<app>" : "systemctl --user disable --now <app>"}) and run \`space app sync <app>\`.`);
  }
}

async function sectionGithub(sec: Section): Promise<void> {
  const { d, set, current } = sec;
  const { io } = d;
  io.say("  `space app new` then creates a repository for each new app under this owner and pushes to it.");
  io.say("  Without an owner, new apps stay local git repositories; cloning public apps needs only git.");
  const owner = (await io.ask("GitHub owner (user or organisation; empty turns it off)", { default: current("SPACE_GITHUB_OWNER") })).trim();
  set("SPACE_GITHUB_OWNER", owner);
  if (owner) set("SPACE_GITHUB_VISIBILITY", await io.ask("Visibility of new repositories", { default: current("SPACE_GITHUB_VISIBILITY") || "private", choices: ["private", "public"] }));
  if (owner) sayChecks(io, await checkExtensionTools(d, "github", sec.merged()));
}

async function sectionIngress(sec: Section): Promise<void> {
  const { d, set, current } = sec;
  const { io } = d;
  io.say("  ai-space keeps listening on loopback; the way in is a tunnel with an access layer in front (docs/ingress.md).");
  const router = (await io.ask("Router: none (one tunnel rule per app) or caddy (one wildcard rule; docs/router.md)", { default: current("SPACE_ROUTER") || "none", choices: ["none", "caddy"] })).trim().toLowerCase();
  if (router !== "none" || current("SPACE_ROUTER")) set("SPACE_ROUTER", router);
  if (router === "caddy") set("SPACE_DOMAIN", await io.ask("Domain of the wildcard rule (apps get <app>.<domain>)", { default: current("SPACE_DOMAIN") }));
  else set("SPACE_PANEL_HOST", await io.ask("Hostname of the panel (e.g. space.example.com)", { default: current("SPACE_PANEL_HOST") }));
  sayChecks(io, await checkExtensionTools(d, "ingress", sec.merged()));
}

async function sectionBackup(sec: Section): Promise<void> {
  const { d, set, current } = sec;
  const { io } = d;
  const hasS3 = Boolean(current("SPACE_S3_ACCESS_KEY_ID"));
  if (hasS3) io.say(`  S3 configured: ${current("SPACE_S3_ENDPOINT") || "aws"} bucket ${current("SPACE_S3_BUCKET") || "(per app)"}`);
  if (current("SPACE_BACKUP_URL")) io.say(`  SPACE_BACKUP_URL=${current("SPACE_BACKUP_URL")}`);
  io.say("  With S3 credentials, backups go to s3://<default bucket>/backups/<name>/ and apps that declare");
  io.say("  `storage.blobs: s3` use the bucket too. A directory (a mounted disk) needs no account (docs/backup.md).");
  const where = (await io.ask("Back up to: s3, dir, or skip", { default: hasS3 ? "skip" : "s3", choices: ["s3", "dir", "skip"] })).trim();
  if (where === "s3") {
    const s3 = await askS3(d);
    if (s3) for (const [k, v] of Object.entries(s3)) set(k, v);
  } else if (where === "dir") {
    const cur = current("SPACE_BACKUP_URL").startsWith("file://") ? current("SPACE_BACKUP_URL").slice("file://".length) : "";
    const dir = (await io.ask("  Absolute directory", { default: cur })).trim().replace(/\/?$/, "/");
    if (!dir.startsWith("/")) io.say("  not an absolute path; skipped");
    else set("SPACE_BACKUP_URL", `file://${dir}`);
  }
  sayChecks(io, await checkExtensionTools(d, "backup", sec.merged()));
}

async function sectionNotifications({ d, set, current }: Section): Promise<void> {
  const { io } = d;
  const existingDefault = current("SPACE_NOTIFY_DEFAULT");
  if (existingDefault) io.say(`  default channel is set (${existingDefault.split("://")[0]}://…)`);
  if (await io.confirm(existingDefault ? "Replace the default channel?" : "Configure a notification channel now?", !existingDefault)) {
    const url = await askChannel(d);
    if (url) {
      set("SPACE_NOTIFY_DEFAULT", url);
      if (await io.confirm("Report tasks that fail three times in a row to it (SPACE_NOTIFY_TASKS=default)?", true)) set("SPACE_NOTIFY_TASKS", "default");
    }
  } else if (existingDefault && !current("SPACE_NOTIFY_TASKS")) {
    if (await io.confirm("Report failing tasks to the default channel (SPACE_NOTIFY_TASKS=default)?", true)) set("SPACE_NOTIFY_TASKS", "default");
  }
}

async function sectionPeers({ d, set, current }: Section): Promise<void> {
  const { io } = d;
  io.say("  Only with a second machine; see docs/peers.md.");
  const hub = current("SPACE_HUB_TOKEN");
  if (hub) io.say(`  SPACE_HUB_TOKEN is set (${mask(hub)}): a hub may list this machine.`);
  if (await io.confirm(hub ? "Rotate the hub token?" : "Will a hub on another machine list this one as a peer?", false)) {
    const t = d.randomToken();
    set("SPACE_HUB_TOKEN", t);
    io.say(`  SPACE_HUB_TOKEN=${t}`);
    io.say(`  On the hub: SPACE_PEER_${(current("SPACE_NAME") || d.hostname()).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN=<that value>`);
  }
  const peers = Object.keys(d.env).filter((k) => /^SPACE_PEER_[A-Z0-9_]+$/.test(k) && !/_(TOKEN|HEADERS|REFRESH)$/.test(k));
  if (peers.length) io.say(`  peers listed here: ${peers.map((k) => k.slice("SPACE_PEER_".length).toLowerCase()).join(", ")}`);
  while (await io.confirm("Add a peer this panel should merge?", false)) {
    const p = await askPeer(d);
    if (!p) break;
    for (const [k, v] of Object.entries(p)) set(k, v);
  }
}

const SECTIONS: Record<Extension, (sec: Section) => Promise<void>> = {
  github: sectionGithub,
  ingress: sectionIngress,
  backup: sectionBackup,
  notifications: sectionNotifications,
  peers: sectionPeers,
};

/**
 * What is left on Cloudflare: the `cf` commands of cloudflare.ts when the
 * hostnames are known (the router's domain or SPACE_PANEL_HOST), else in words.
 */
async function sayEdgePlan(d: SetupDeps, env: Record<string, string | undefined>): Promise<void> {
  const { io } = d;
  const v = (k: string) => env[k]?.trim() ?? "";
  const port = Number(v("SPACE_PORT") || 8700);
  const domain = v("SPACE_DOMAIN").replace(/\.$/, "");
  const panelHost = v("SPACE_PANEL_HOST") || (domain ? `space.${domain}` : "");
  const zone = domain || panelHost.split(".").slice(1).join(".");
  if (!panelHost || !zone.includes(".")) {
    io.say("Next, for outside access (docs/install.md; the cf commands for Cloudflare are in docs/cloudflare.md):");
    io.say(`  - a tunnel with the hostname  space.<your-domain>  →  http://127.0.0.1:${port}`);
    io.say("  - an access layer on that hostname allowing only you, before it goes live (Cloudflare Access)");
    io.say("  - one hostname per app page (or SPACE_ROUTER=caddy and one wildcard), then that hostname as `url` in the app's space.yaml");
    return;
  }
  const git = await d.run(["git", "config", "--global", "user.email"]);
  const email = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : "you@example.com";
  const machine = v("SPACE_NAME") || d.hostname();
  const cmds = cfCommands({
    machine,
    zone,
    panelHost,
    panelPort: port,
    ...(v("SPACE_ROUTER") === "caddy" ? { routerPort: Number(v("SPACE_ROUTER_PORT") || 8080) } : {}),
    email,
  });
  io.say(`Next, on Cloudflare, from any machine with cf (docs/cloudflare.md). Access allows ${email}; change the body if that is wrong.`);
  for (const line of renderCfScript(cmds)) io.say(`  ${line}`);
  io.say("Then the cloudflared unit of docs/install.md with that token.");
}

/* ------------------------------------------------------------------------ */
/* Questions                                                                */
/* ------------------------------------------------------------------------ */

async function askNumber(io: SetupIO, q: string, def: string): Promise<string> {
  for (;;) {
    const v = await io.ask(q, { default: def });
    if (/^\d+$/.test(v) && Number(v) > 0) return v;
    io.say("  a positive whole number, please");
  }
}

async function askChannel(d: SetupDeps): Promise<string | undefined> {
  const { io } = d;
  const kind = (await io.ask(`Kind (${CHANNEL_KINDS.join(", ")}, or skip)`, { default: "telegram", choices: [...CHANNEL_KINDS, "skip"] })) as ChannelKind | "skip";
  if (kind === "skip") return undefined;
  const form = CHANNEL_FORMS[kind];
  if (form.hint) io.say(`  ${form.hint}`);
  const answers: Record<string, string> = {};
  for (const f of form.fields) {
    if (kind === "telegram" && f.key === "chat" && answers.token) {
      const found = await telegramChats(d, answers.token);
      if (found.length) {
        io.say("  chats that wrote to the bot recently:");
        for (const c of found) io.say(`    ${c.id}  ${c.title}`);
        f.default = found[0]!.id;
      } else {
        io.say("  no recent message to the bot found; send it one and re-run, or type the id");
      }
    }
    for (;;) {
      const v = await io.ask(`  ${f.prompt}${f.optional ? " (optional)" : ""}`, { default: f.default, secret: f.secret });
      if (v || f.optional) {
        answers[f.key] = v;
        break;
      }
      io.say("  required");
    }
  }
  const url = form.build(answers);
  let channel: Channel;
  try {
    channel = parseChannelUrl("default", url);
  } catch (e) {
    io.say(`  ${(e as Error).message}`);
    return undefined;
  }
  if (await io.confirm("Send a test message now?", true)) {
    try {
      await d.sendTest(channel, "default");
      io.say("  sent; check the chat.");
    } catch (e) {
      io.say(`  failed: ${(e as Error).message}`);
      if (!(await io.confirm("Keep this channel anyway?", false))) return undefined;
    }
  }
  return url;
}

async function telegramChats(d: SetupDeps, token: string): Promise<{ id: string; title: string }[]> {
  try {
    const res = await d.fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { ok?: boolean; result?: { message?: { chat?: { id: number; title?: string; username?: string; first_name?: string } } }[] };
    if (!body.ok) return [];
    const seen = new Map<string, string>();
    for (const u of body.result ?? []) {
      const c = u.message?.chat;
      if (c) seen.set(String(c.id), c.title ?? c.username ?? c.first_name ?? "");
    }
    return [...seen].map(([id, title]) => ({ id, title }));
  } catch {
    return [];
  }
}

async function askS3(d: SetupDeps): Promise<Record<string, string> | undefined> {
  const { io } = d;
  io.say("  R2: bucket → Manage R2 API Tokens → Object Read & Write scoped to the bucket; endpoint https://<account-id>.r2.cloudflarestorage.com");
  const cur = (k: string) => d.env[k]?.trim() ?? "";
  const endpoint = await io.ask("  Endpoint (empty for AWS S3)", { default: cur("SPACE_S3_ENDPOINT") });
  const region = await io.ask("  Region", { default: cur("SPACE_S3_REGION") || (endpoint.includes("r2.cloudflarestorage.com") ? "auto" : "us-east-1") });
  const accessKeyId = await io.ask("  Access key id", { default: cur("SPACE_S3_ACCESS_KEY_ID"), secret: true });
  const secretAccessKey = await io.ask("  Secret access key", { default: cur("SPACE_S3_SECRET_ACCESS_KEY"), secret: true });
  const bucket = await io.ask("  Default bucket", { default: cur("SPACE_S3_BUCKET") });
  if (!accessKeyId || !secretAccessKey || !bucket) {
    io.say("  incomplete; skipped");
    return undefined;
  }
  try {
    await d.probeS3({ endpoint, region, accessKeyId, secretAccessKey, bucket });
    io.say("  bucket reachable.");
  } catch (e) {
    io.say(`  list failed: ${(e as Error).message}`);
    if (!(await io.confirm("Keep these credentials anyway?", false))) return undefined;
  }
  return {
    SPACE_S3_ENDPOINT: endpoint,
    SPACE_S3_REGION: region,
    SPACE_S3_ACCESS_KEY_ID: accessKeyId,
    SPACE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    SPACE_S3_BUCKET: bucket,
  };
}

async function askPeer(d: SetupDeps): Promise<Record<string, string> | undefined> {
  const { io } = d;
  const name = await io.ask("  Peer name (lowercase; its apps show as <name>/<app>)");
  if (!PEER_NAME_RE.test(name)) {
    io.say("  invalid name; skipped");
    return undefined;
  }
  const url = await io.ask("  Peer URL (its panel hostname on its tunnel)");
  const token = await io.ask("  Its SPACE_HUB_TOKEN", { secret: true });
  if (!/^https?:\/\//.test(url) || !token) {
    io.say("  incomplete; skipped");
    return undefined;
  }
  const key = `SPACE_PEER_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const out: Record<string, string> = { [key]: url, [`${key}_TOKEN`]: token };
  if (await io.confirm("  Is an access layer in front of it that does not exempt /api/peer/*?", false)) {
    const id = await io.ask("  CF-Access-Client-Id", { secret: true });
    const secret = await io.ask("  CF-Access-Client-Secret", { secret: true });
    if (id && secret) out[`${key}_HEADERS`] = `CF-Access-Client-Id: ${id}; CF-Access-Client-Secret: ${secret}`;
  }
  try {
    const res = await d.fetch(`${url.replace(/\/$/, "")}/api/peer/snapshot`, {
      headers: { authorization: `Bearer ${token}`, ...(out[`${key}_HEADERS`] ? headersFrom(out[`${key}_HEADERS`]!) : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const snap = (await res.json()) as { name?: string; apps?: unknown[] };
      io.say(`  reachable: ${snap.name ?? "?"} with ${snap.apps?.length ?? 0} apps.`);
    } else {
      io.say(`  ${res.status} from the peer${res.status === 401 ? " (token rejected)" : res.status === 302 ? " (an access layer answered; add its service token)" : ""}`);
      if (!(await io.confirm("  Keep it anyway?", false))) return undefined;
    }
  } catch (e) {
    io.say(`  not reachable: ${(e as Error).message}`);
    if (!(await io.confirm("  Keep it anyway?", false))) return undefined;
  }
  return out;
}

function headersFrom(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Real dependencies                                                        */
/* ------------------------------------------------------------------------ */

/** Thrown by the terminal when stdin ends before the walk-through does. */
export class SetupAborted extends Error {}

/**
 * A terminal on stdin/stdout. One readline for the whole session; lines that
 * arrive before they are asked for (a pipe) are queued in order, and end of
 * input aborts the walk-through instead of answering every later question
 * with an empty line.
 */
export function terminalIO(): SetupIO {
  const write = (s: string) => process.stdout.write(s);
  const queue: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;
  let started = false;
  const start = () => {
    started = true;
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queue.push(line)));
    rl.on("close", () => {
      closed = true;
      while (waiting.length) waiting.shift()!(undefined);
    });
  };
  const readLine = (): Promise<string> => {
    if (!started) start();
    if (queue.length) return Promise.resolve(queue.shift()!);
    if (closed) throw new SetupAborted("input closed");
    return new Promise((resolve, reject) => {
      waiting.push((line) => (line === undefined ? reject(new SetupAborted("input closed")) : resolve(line)));
    });
  };
  return {
    say: (line = "") => write(`${line}\n`),
    async ask(question, opts = {}) {
      for (;;) {
        const shown = opts.default === undefined || opts.default === "" ? "" : ` [${opts.secret ? mask(opts.default) : opts.default}]`;
        write(`${question}${shown}: `);
        const raw = (await readLine()).trim();
        const v = raw === "" ? (opts.default ?? "") : raw;
        if (!opts.choices || opts.choices.includes(v)) return v;
        write(`  one of: ${opts.choices.join(", ")}\n`);
      }
    },
    async confirm(question, def) {
      write(`${question} [${def ? "Y/n" : "y/N"}]: `);
      const raw = (await readLine()).trim().toLowerCase();
      if (raw === "") return def;
      return raw === "y" || raw === "yes";
    },
  };
}

export function realDeps(io: SetupIO, ws: Workspace, env: Record<string, string | undefined> = process.env): SetupDeps {
  return {
    io,
    ws,
    env,
    which: async (cmd) => Bun.which(cmd) ?? undefined,
    async run(cmd, opts = {}) {
      try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...env, TERM: "dumb" } as Record<string, string> });
        const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (timer) clearTimeout(timer);
        return { code, stdout, stderr };
      } catch (e) {
        return { code: 127, stdout: "", stderr: (e as Error).message };
      }
    },
    async probeS3(t) {
      const { S3Client } = await import("bun");
      const client = new S3Client({
        accessKeyId: t.accessKeyId,
        secretAccessKey: t.secretAccessKey,
        bucket: t.bucket,
        ...(t.endpoint ? { endpoint: t.endpoint } : {}),
        ...(t.region ? { region: t.region } : {}),
      });
      await client.list({ maxKeys: 1 });
    },
    async sendTest(channel, name) {
      await TRANSPORTS[channel.kind](
        {
          channel,
          appTitle: "space",
          notification: {
            id: `setup-${Date.now()}`,
            app: "space",
            level: "success",
            title: "ai-space setup",
            text: `Channel "${name}" on ${hostname()} works.`,
            createdAt: Date.now(),
          },
        },
        fetch,
        () => {},
      );
    },
    fetch,
    randomToken: () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    hostname: () => hostname().split(".")[0]!.toLowerCase(),
  };
}
