import { clientOf, clientLabel } from "./client.ts";
import { parseContext, parseImages, redact } from "./context.ts";
import { type FixResult, type FixTarget, fixMessage, parseResult, todoPlan, todoTitle } from "./prompt.ts";
import { FeedbackStore, recentView } from "./store.ts";
import type { TodoSink } from "./todo.ts";
import { type FeedbackRow, type FeedbackSettings, LIMITS, type RecentView, type Status } from "./types.ts";

/**
 * Feedback from app pages to a fix (docs/feedback.md): a submission becomes a row and an ai-todo
 * task; in `auto` mode the Fix Engineer (`space/ui-fixer`) starts on it at once, in `later` mode it
 * waits for a batch the person starts in Settings. One fix runs per app at a time; feedback that
 * arrives meanwhile is queued and goes to the next run, together.
 */

export class FeedbackError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type AppInfo = { title: string; zhTitle?: string; repo?: string; hasDeployCheck: boolean };

export type RunEnd = { status: string; error: string | null; text: string };

/** Starts the engineer on this machine ("") or a peer, and tells when its run ends. */
export type FixerPort = {
  start(machine: string, body: { message: string; model?: string; effort?: string; permissionMode: string }): Promise<string>;
  wait(machine: string, runId: string): Promise<RunEnd>;
};

export type FeedbackServiceOptions = {
  store: FeedbackStore;
  /** This space's name (SPACE_NAME): the machine the apps here run on. */
  name: string;
  app: (app: string) => AppInfo | undefined;
  /** ai-todo here or on a peer; undefined when neither has it. */
  todo: () => TodoSink | undefined;
  fixer: FixerPort;
  /** The peers the engineer may run on. */
  machines: () => string[];
  /** Takes a fix pushed from another machine (src/space/feedback/deploy.ts). */
  deploy?: (app: string) => Promise<{ ok: boolean; log: string }>;
  log?: (line: string) => void;
  now?: () => number;
};

type Lang = "en" | "zh";
const WORDS = {
  started: { en: "Handed to the Fix Engineer (run {run}, {where}).", zh: "已交给修复工程师（run {run}，{where}）。" },
  here: { en: "on this machine", zh: "在本机" },
  on: { en: "on {machine}", zh: "在 {machine}" },
  fixed: { en: "Fix Engineer: fixed, waiting for your review.", zh: "修复工程师：已修好，等你验收。" },
  needsPerson: { en: "Fix Engineer: not an app fix, needs you.", zh: "修复工程师：这不是 app 小修，需要你来决定。" },
  notFixed: { en: "Fix Engineer: not fixed.", zh: "修复工程师：没有修好。" },
  runFailed: { en: "The run ended with {status}: {error}", zh: "运行结束状态 {status}：{error}" },
  notStarted: { en: "The Fix Engineer could not start: {error}", zh: "修复工程师没能开始：{error}" },
  deployed: { en: "Deployed on {machine} from origin.", zh: "已在 {machine} 从 origin 拉取并部署。" },
  deployFailed: { en: "Not deployed on {machine}: {why}", zh: "没能在 {machine} 部署：{why}" },
  commit: { en: "Commit {commit}", zh: "提交 {commit}" },
  screenshot: { en: "Picture sent with the feedback.", zh: "反馈附带的截图。" },
} as const;

function say(lang: Lang, key: keyof typeof WORDS, vars: Record<string, string> = {}): string {
  return WORDS[key][lang].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

const langOf = (r: FeedbackRow): Lang => (/^zh/i.test(r.context.lang) || /[一-鿿]/.test(r.text) ? "zh" : "en");
/** The app's name in the language the feedback was written in. */
const titleFor = (info: AppInfo, r: FeedbackRow): string => (langOf(r) === "zh" && info.zhTitle ? info.zhTitle : info.title);

export class FeedbackService {
  private readonly store: FeedbackStore;
  private readonly now: () => number;
  /** Apps with a fix running, by app. */
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly opts: FeedbackServiceOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
  }

  settings(): FeedbackSettings {
    return this.store.settings();
  }

  saveSettings(patch: unknown): FeedbackSettings {
    const p = patch as Partial<FeedbackSettings> | null;
    if (p && typeof p.machine === "string" && p.machine && !this.opts.machines().includes(p.machine)) throw new FeedbackError(400, `${p.machine} is not a peer of this space`);
    try {
      return this.store.saveSettings(patch);
    } catch (e) {
      throw new FeedbackError(400, (e as Error).message);
    }
  }

  /** Whether `app`'s pages show the button. */
  enabledFor(app: string, s = this.settings()): boolean {
    if (!s.enabled) return false;
    const own = s.apps[app];
    return own ? own === "on" : s.appsDefault;
  }

  /** What the script reads at load: nothing about the settings beyond what the button needs. */
  config(app: string, ua: string) {
    const s = this.settings();
    const info = this.opts.app(app);
    const on = Boolean(info) && this.enabledFor(app, s);
    if (!on) return { ok: true, enabled: false };
    const client = clientOf(ua);
    return {
      ok: true,
      enabled: true,
      mode: s.mode,
      errors: s.errors,
      app: { name: app, title: info!.title, zh: info!.zhTitle ?? info!.title },
      client: { kind: client.kind, en: clientLabel(client, "en"), zh: clientLabel(client, "zh") },
      shortcut: "Alt+Shift+F",
    };
  }

  recent(app: string): RecentView[] {
    return this.store.list({ app, limit: 5 }).map(recentView);
  }

  list(limit = 50): FeedbackRow[] {
    return this.store.list({ limit });
  }

  counts(): Record<Status, number> {
    const out = { later: 0, queued: 0, fixing: 0, review: 0, failed: 0, skipped: 0, recorded: 0 } as Record<Status, number>;
    for (const r of this.store.list({ limit: 500 })) out[r.status]++;
    return out;
  }

  /** A submission from a page of `app` (named by the router, never by the page). */
  async submit(app: string, body: unknown, ua: string): Promise<{ id: number; status: Status; todoId: number | null; todoUrl: string | null; repeated?: boolean }> {
    const info = this.opts.app(app);
    if (!info) throw new FeedbackError(404, "unknown app");
    const s = this.settings();
    if (!this.enabledFor(app, s)) throw new FeedbackError(403, "feedback is turned off for this app");
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const text = typeof b.text === "string" ? redact(b.text.replace(/\r\n/g, "\n").trim()) : "";
    if (!text) throw new FeedbackError(400, "text is required");
    if (text.length > LIMITS.text) throw new FeedbackError(400, `text is longer than ${LIMITS.text} characters`);
    const mode = b.mode === "later" ? "later" : b.mode === "now" ? "auto" : s.mode;
    let images;
    try {
      images = parseImages(b.images);
    } catch (e) {
      throw new FeedbackError(400, (e as Error).message);
    }
    const context = parseContext(b.context);
    if (!s.errors) context.errors = [];
    const repeated = this.store.duplicate(app, text, context.path);
    if (repeated) return { id: repeated.id, status: repeated.status, todoId: repeated.todoId, todoUrl: repeated.todoUrl, repeated: true };
    if (this.store.countSince(app, this.now() - 3600_000) >= LIMITS.perHour) throw new FeedbackError(429, `at most ${LIMITS.perHour} pieces of feedback per app in an hour`);

    let row = this.store.add({ app, text, context, client: clientOf(ua), status: mode === "later" ? "later" : "queued" });
    const sink = this.opts.todo();
    if (!sink) {
      row = this.store.patch(row.id, { status: "recorded", note: "no ai-todo on this space or its peers" })!;
      return { id: row.id, status: row.status, todoId: null, todoUrl: null };
    }
    try {
      const todoId = await sink.add({ title: todoTitle(row, titleFor(info, row)), notes: this.notes(row, info), tags: ["feedback", app] });
      row = this.store.patch(row.id, { todoId, todoPeer: sink.peer, todoUrl: sink.url(todoId) })!;
    } catch (e) {
      // The feedback is kept; without a task the engineer has nothing to report to.
      this.log(`#${row.id}: no todo: ${(e as Error).message}`);
      row = this.store.patch(row.id, { status: "recorded", note: `ai-todo: ${(e as Error).message}`.slice(0, 500) })!;
      return { id: row.id, status: row.status, todoId: null, todoUrl: null };
    }
    const fixer = s.machine ? `Fix Engineer: space/ui-fixer on ${s.machine}.` : "Fix Engineer: space/ui-fixer.";
    await sink.plan(row.todoId!, todoPlan(row, titleFor(info, row), { images: images.length, fixer })).catch((e) => this.log(`#${row.id}: plan: ${(e as Error).message}`));
    if (images.length) await sink.record(row.todoId!, say(langOf(row), "screenshot"), images).catch((e) => this.log(`#${row.id}: picture: ${(e as Error).message}`));
    if (row.status === "queued") this.schedule(app);
    return { id: row.id, status: this.store.get(row.id)!.status, todoId: row.todoId, todoUrl: row.todoUrl };
  }

  /**
   * Start the waiting feedback now: the `later` ones of one app (or every app), or the given rows
   * again (a failed fix, or one the person rejected in ai-todo).
   */
  fix(sel: { app?: string; ids?: number[] }): { queued: number } {
    const rows = sel.ids?.length
      ? sel.ids.map((id) => this.store.get(id)).filter((r): r is FeedbackRow => !!r && r.status !== "fixing" && r.status !== "queued" && r.todoId !== null)
      : this.store.list({ status: ["later"], limit: 500, ...(sel.app ? { app: sel.app } : {}) });
    for (const r of rows) this.store.patch(r.id, { status: "queued" });
    for (const app of new Set(rows.map((r) => r.app))) this.schedule(app);
    return { queued: rows.length };
  }

  /** At boot: a local fix that was running died with the old process; a peer's goes on, so it is watched again. */
  resume(): void {
    const byRun = new Map<string, FeedbackRow[]>();
    for (const r of this.store.interrupted()) {
      if (!r.runMachine || !r.runId) {
        this.store.patch(r.id, { status: "failed", note: "ai-space restarted during the fix; start it again in Settings" });
        continue;
      }
      byRun.set(`${r.runMachine}\0${r.runId}`, [...(byRun.get(`${r.runMachine}\0${r.runId}`) ?? []), r]);
    }
    for (const rows of byRun.values()) {
      const app = rows[0]!.app;
      const done = this.watch(app, rows, rows[0]!.runMachine, rows[0]!.runId!).finally(() => this.afterRun(app));
      this.active.set(app, done);
    }
    for (const app of new Set(this.store.list({ status: ["queued"], limit: 500 }).map((r) => r.app))) this.schedule(app);
  }

  /** Resolves when no fix is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()]);
  }

  private notes(r: FeedbackRow, info: AppInfo): string {
    return [`${titleFor(info, r)} · ${r.context.path || "/"} · ${clientLabel(r.client, langOf(r))}`, r.context.viewport.w ? `${r.context.viewport.w}×${r.context.viewport.h} · ${r.context.theme} · ${r.context.lang}` : ""].filter(Boolean).join("\n");
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.error(`[feedback] ${l}`)))(line);
  }

  /** Start the app's queued feedback unless a fix of the app is running; that one starts the next. */
  private schedule(app: string): void {
    if (this.active.has(app)) return;
    const rows = this.store.list({ app, status: ["queued"], limit: 20 }).reverse();
    if (!rows.length) return;
    const done = this.dispatch(app, rows)
      .catch((e) => this.log(`${app}: ${(e as Error).message}`))
      .finally(() => this.afterRun(app));
    this.active.set(app, done);
  }

  private afterRun(app: string): void {
    this.active.delete(app);
    this.schedule(app);
  }

  private async dispatch(app: string, rows: FeedbackRow[]): Promise<void> {
    const s = this.settings();
    const info = this.opts.app(app);
    const sink = this.opts.todo();
    const lang = langOf(rows[0]!);
    const fail = async (note: string) => {
      for (const r of rows) {
        this.store.patch(r.id, { status: "failed", note: note.slice(0, 1000) });
        if (r.todoId !== null) await sink?.record(r.todoId, note).catch(() => {});
      }
    };
    if (!info) return fail(`${app} is no longer registered here`);
    const machine = s.machine;
    if (machine && !this.opts.machines().includes(machine)) return fail(`the Fix Engineer's machine ${machine} is not a peer of this space`);
    // A second try carries the task's records: the last attempt's report, the person's reason for rejecting it.
    const history = new Map<number, string[]>();
    for (const r of rows) {
      if (!r.runId || r.todoId === null || !sink) continue;
      const task = await sink.task(r.todoId);
      if (task) history.set(r.id, task.records.slice(0, 5).map((x) => `${x.createdAt} (${x.source}): ${x.content.slice(0, 800)}`));
    }
    const target: FixTarget = { app, appTitle: info.title, appMachine: this.opts.name, sameMachine: !machine, ...(info.repo ? { repo: info.repo } : {}), hasDeployCheck: info.hasDeployCheck };
    let runId: string;
    try {
      runId = await this.opts.fixer.start(machine, { message: fixMessage(target, rows, history), ...(s.model ? { model: s.model } : {}), effort: s.effort, permissionMode: "bypassPermissions" });
    } catch (e) {
      return fail(say(lang, "notStarted", { error: (e as Error).message.slice(0, 500) }));
    }
    for (const r of rows) {
      this.store.patch(r.id, { status: "fixing", runId, runMachine: machine, note: null });
      if (r.todoId !== null && sink) {
        await sink.status(r.todoId, "doing").catch(() => false);
        await sink.record(r.todoId, say(lang, "started", { run: runId, where: machine ? say(lang, "on", { machine }) : say(lang, "here") })).catch(() => {});
      }
    }
    await this.watch(app, rows.map((r) => this.store.get(r.id)!), machine, runId);
  }

  /** Wait for the run, then report it on every row and its task. */
  private async watch(app: string, rows: FeedbackRow[], machine: string, runId: string): Promise<void> {
    const sink = this.opts.todo();
    const lang = langOf(rows[0]!);
    let end: RunEnd;
    try {
      end = await this.opts.fixer.wait(machine, runId);
    } catch (e) {
      end = { status: "error", error: (e as Error).message, text: "" };
    }
    const result: FixResult = parseResult(end.text, rows.map((r) => r.id));
    const extra: string[] = [];
    if (end.status !== "done") {
      extra.push(say(lang, "runFailed", { status: end.status, error: (end.error ?? "").slice(0, 500) }));
      for (const it of result.items) if (it.status === "fixed") it.status = "not-fixed";
    }
    // A fix made elsewhere reaches this machine through the app's origin and its deploy remote.
    let deployFailed = false;
    if (machine && result.items.some((i) => i.status === "fixed") && result.pushed && this.opts.deploy) {
      const d = await this.opts.deploy(app).catch((e) => ({ ok: false, log: (e as Error).message }));
      extra.push(d.ok ? say(lang, "deployed", { machine: this.opts.name }) : say(lang, "deployFailed", { machine: this.opts.name, why: d.log.split("\n")[0] ?? "" }));
      if (d.log) extra.push(d.log.split("\n").slice(-12).join("\n"));
      deployFailed = !d.ok;
    }
    for (const r of rows) {
      const it = result.items.find((i) => i.id === r.id)!;
      const status: Status = it.status === "fixed" && !deployFailed ? "review" : it.status === "needs-person" ? "skipped" : "failed";
      const head = it.status === "fixed" ? say(lang, "fixed") : it.status === "needs-person" ? say(lang, "needsPerson") : say(lang, "notFixed");
      const lines = [head, result.summary, it.note ?? "", ...extra, result.commit ? say(lang, "commit", { commit: result.commit }) : "", `run ${runId}${machine ? ` · ${machine}` : ""}`].filter(Boolean);
      this.store.patch(r.id, { status, note: [it.note, result.summary, ...extra].filter(Boolean).join("\n").slice(0, 2000) || null });
      if (r.todoId === null || !sink) continue;
      await sink.record(r.todoId, lines.join("\n\n")).catch((e) => this.log(`#${r.id}: record: ${(e as Error).message}`));
      if (status === "review") await sink.status(r.todoId, "review").catch(() => false);
    }
  }
}
