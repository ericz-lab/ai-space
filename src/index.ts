import { basename, join } from "node:path";
import { NotifyService, NotifyStore, createNotifyRoutes, createTaskNotifier, loadChannels, parseNotifySpec } from "./space/notify/index.ts";
import { SessionStore, createAgentRoutes } from "./space/agents/index.ts";
import { AppRegistry, HealthProbe, LayoutStore, WidgetFeed, createPanelRoutes, runStopCommand } from "./space/panel/index.ts";
import { PeerHub, PeerStore, createPeerRoutes, createPeerServeRoutes, loadPeers } from "./space/peers/index.ts";
import { ModelService, ModelStore, createModelRoutes, recordAgentRun } from "./space/model/index.ts";
import { ChatService, ChatStore, createChatRoutes } from "./space/chat/index.ts";
import { buildWidget } from "./web/chat-widget/build.ts";
import { RuntimeRegistry, loadRuntimes } from "./space/runtimes/index.ts";
import { Bus, BusStore, createBusRoutes } from "./space/bus/index.ts";
import { type Manifest, Scheduler, Store, createRoutes, effectiveEnabled, loadManifest, runTarget } from "./space/scheduler/index.ts";
import { createStorageRoutes, parseStorageSpec } from "./space/storage/index.ts";
import { BACKUP_TASK, SPACE_APP, backupTask, createBackupRoutes, parseBackupSpec, spaceManifest } from "./space/storage/backup/index.ts";
import { type Workspace, discoverApps } from "./space/workspace.ts";
import { describeSkillLinks, linkSkills } from "./space/skills.ts";
import { applyEnvOverrides } from "./space/defaults.ts";
import { localMachine, syncGuide } from "./space/guide.ts";
import { TerminalService, TerminalStore, createTerminalRoutes, terminalWebSocket } from "./space/terminal/index.ts";
import { Router, createRouterRoutes } from "./space/router/index.ts";
import { createLogsRoutes } from "./space/logs/index.ts";
import { createWebRoutes } from "./web/routes.ts";
import { type Config, SHARED_SKILLS, backupTaskDefaults, openBackups, openStorage } from "./space/config.ts";
import { run } from "./cli/main.ts";

/**
 * ai-space entry point.
 *
 *   bun src/index.ts                     boot: ensure the workspace, sync app manifests, serve the Space API
 *   bun src/index.ts <command> …         the `space` CLI (`bin/space` is the same thing on PATH): `space help`
 *                                        lists the commands; docs/cli.md is the design. The older spellings
 *                                        (`init`, `setup`, `env <app>`, `notify …`, `backup <app>`, `backup-verify`,
 *                                        `backups`, `restore <app> …`, `model-import`, `chat-import`) still work
 *                                        as aliases of the CLI's nouns.
 *
 * Configuration comes from the environment, then from `<workspace>/.env`
 * (process values win); see `src/space/config.ts`, `.env.example`, `docs/scheduler.md`, `docs/storage.md`
 * `docs/events.md`, `docs/notify.md`, `docs/model.md`, `docs/chat.md`, `docs/panel.md`, `docs/peers.md`, `docs/terminal.md` and `docs/router.md`.
 */

export { type Config, loadConfig, openBackups, openStorage, backupTaskDefaults } from "./space/config.ts";
export { parseNotifyArgs } from "./cli/notify.ts";

export async function boot(ws: Workspace, config: Config, env: Record<string, string | undefined> = process.env) {
  const store = new Store(config.dbPath, { eventRetentionMs: config.eventRetentionMs });
  const storage = await openStorage(ws, config);
  const backups = await openBackups(config);
  const taskDefaults = backupTaskDefaults(ws, config);
  const { channels, errors: channelErrors } = loadChannels(env);
  const notifyStore = new NotifyStore(config.dbPath);
  const notify = new NotifyService({
    store: notifyStore,
    channels,
    channelErrors,
    imageDir: (app) => join(storage.appDataDir(app), "notify"),
  });
  const loaded = await loadRuntimes(ws.home, env);
  for (const w of loaded.warnings) console.warn(`[runtimes] ${w}`);
  const runtimes = new RuntimeRegistry(loaded.config);
  const modelStore = new ModelStore(config.dbPath, { retentionDays: config.model.retentionDays });
  const model = new ModelService({ store: modelStore, runtimes, maxConcurrency: config.model.maxConcurrency });
  const chatStore = new ChatStore(config.dbPath);
  const chat = new ChatService({ store: chatStore, model, defaultModel: config.model.defaultModel, fileDir: (app) => join(storage.appDataDir(app), "chat") });
  // The widget apps embed is bundled once at boot; SPACE_DEV=1 rebuilds it on every request.
  const widget = buildWidget({ dev: process.env.SPACE_DEV === "1" });
  // Agent tasks run on their runtime from the scheduler; their usage reaches the ledger from the run result.
  const recordAgent = recordAgentRun(model);
  const scheduler = new Scheduler({
    store,
    maxConcurrency: config.maxConcurrency,
    envFor: (app) => storage.envFor(app),
    runner: async (task, ctx) => {
      const startedAt = Date.now();
      const result = await runTarget(task.target, { ...ctx, runtimes });
      recordAgent(task, result, startedAt, Date.now());
      return result;
    },
    onFinish: createTaskNotifier({ notify, tasksChannel: config.notifyTasks }),
    onPublish: (event) => bus.onEvent(event),
  });
  const registry = new AppRegistry();
  // The bus (docs/events.md): http and stream deliveries of every stored event, and calls between apps.
  const busStore = new BusStore(config.dbPath);
  const bus = new Bus({
    store: busStore,
    events: store,
    servicePort: (app) => registry.get(app)?.manifest.service?.port,
    onDead: (d, event) =>
      void notify
        .send(d.app, { level: "alert", title: `event ${d.event} not delivered`, text: `Delivery #${d.id} (${d.kind}) gave up after ${d.attempts} attempt(s): ${d.lastError ?? "no error text"}${event ? `\nEvent #${event.id} from ${event.app} at ${new Date(event.at).toISOString()}` : ""}`, key: `bus:${d.app}:${d.event}`, windowMs: 3_600_000 })
        .catch((e) => console.error(`[bus] ${d.app}: dead-delivery notification rejected: ${(e as Error).message}`)),
  });
  const layout = new LayoutStore(store.db);
  const sessions = new SessionStore(store.db);
  const health = new HealthProbe();
  const widgets = new WidgetFeed(registry);
  const { peers: peerConfigs, errors: peerErrors } = loadPeers(env);
  for (const [name, reason] of peerErrors) console.error(`[peers] ${name}: ${reason}`);
  // Peers' events are mirrored here (docs/events.md): published under the same app name, marked with the peer.
  const peers = new PeerHub(peerConfigs, {
    store: new PeerStore(store.db),
    onEvents: (peer, list) => {
      for (const e of list) {
        try {
          scheduler.publish(e);
        } catch (err) {
          console.error(`[peers] ${peer}: event ${e.app}/${e.name} not mirrored: ${(err as Error).message}`);
        }
      }
    },
  });
  const remote = { name: config.name, capabilities: () => peers.capabilities(), providerOf: (app: string, cap?: string) => peers.providerOf(app, cap), get: (name: string) => peers.get(name) };
  // The proxy's configuration follows the registry (docs/router.md); a failed write never stops a sync.
  const router = new Router({
    config: config.router,
    apps: () => registry.list().map((e) => e.manifest),
    panelPort: config.port,
    file: join(ws.run, "Caddyfile"),
    socket: join(ws.run, "caddy.sock"),
    logDir: join(ws.logs, "router"),
    log: (l) => console.error(`[router] ${l}`),
  });

  // Storage first, so a command task started right after sync already sees its DATABASE_URL.
  // Returns the tasks the services contribute for the app: its backup task, unless the manifest opts out.
  const provision = async (manifest: Manifest) => {
    if (manifest.app === SPACE_APP) throw new Error(`the app name "${SPACE_APP}" is reserved for ai-space itself`);
    const result = await storage.syncApp(manifest.app, parseStorageSpec(manifest.storage));
    for (const p of result.created) console.log(`[storage] ${manifest.app}: created ${p}`);
    for (const n of result.orphaned) console.log(`[storage] ${manifest.app}: ${n} left the manifest, kept as orphaned`);
    notify.syncApp(manifest.app, parseNotifySpec(manifest.notify, { title: manifest.title }));
    bus.syncApp(manifest.app, { events: manifest.events, provides: manifest.provides });
    await registry.set(manifest);
    void router.sync();
    const backup = backupTask(manifest.app, parseBackupSpec(manifest.backup), taskDefaults);
    if (backup && manifest.tasks.some((t) => t.name === BACKUP_TASK)) throw new Error(`task name "${BACKUP_TASK}" is reserved for ai-space's backup task; rename it, or set backup: false to bring your own`);
    return backup ? [backup] : [];
  };

  const syncDir = async (dir: string) => {
    const manifest = applyEnvOverrides(await loadManifest(dir), env, { domain: config.router.domain });
    const extra = await provision(manifest);
    scheduler.syncManifest(Scheduler.schedulable(manifest), extra);
  };

  // Everything under apps/ plus SPACE_APPS; read again by `POST /api/apps/sync`.
  // Each pass also refreshes the workspace skill links and the guide, so a session started by hand
  // sees every app's skills and the operator's latest AGENTS.local.md.
  const discover = async () => {
    const dirs = [...(await discoverApps(ws)), ...config.extraAppDirs];
    try {
      const links = await linkSkills(ws.home, SHARED_SKILLS, dirs);
      if (links.removed.length || links.renamed.length) console.error(`[space] skills: ${describeSkillLinks(links)}`);
      for (const p of (await syncGuide(ws.home, localMachine(ws.home, config.name))).updated) console.error(`[space] regenerated ${p}`);
    } catch (e) {
      console.error(`[space] skills: could not refresh ${ws.home}/.claude/skills: ${(e as Error).message}`);
    }
    return dirs;
  };
  const skippedNames = new Set<string>();
  for (const dir of await discover()) {
    try {
      await syncDir(dir);
    } catch (e) {
      skippedNames.add(basename(dir));
      console.error(`[space] skipping ${dir}: ${(e as Error).message}`);
    }
  }
  // A peer named like a local app would make `<name>/` ambiguous on the panel.
  for (const p of peerConfigs) {
    if (registry.get(p.name)) {
      console.error(`[peers] peer "${p.name}" has the name of a local app; rename one of them`);
      process.exit(1);
    }
  }
  // ai-space's own tasks: the space.db snapshot and the weekly verification of every app's newest snapshot.
  scheduler.syncBuiltin(spaceManifest(taskDefaults));
  // After the built-in: tasks of an app whose directory disappeared while ai-space was down: no sync registered
  // it, so nothing would ever forget it. A skipped directory of that name is not gone, only broken.
  for (const app of scheduler.leftovers()) {
    if (skippedNames.has(app)) continue;
    const s = scheduler.forget(app);
    if (!s) continue;
    bus.forget(app);
    console.error(`[space] ${app}: no directory in the workspace, ${s.orphaned.length} task(s) orphaned`);
  }
  notify.start();
  bus.start();
  await scheduler.start();
  peers.start();
  void router.sync();

  const panelRoutes = createPanelRoutes({
    ws,
    registry,
    layout,
    widgets,
    health,
    peers,
    onCreate: syncDir,
    onRemove: async (app) => {
      scheduler.forget(app);
      void router.sync();
    },
    ...(config.serviceStop ? { stopService: (app: string) => runStopCommand(config.serviceStop, app) } : {}),
  });
  const agentRoutes = createAgentRoutes({ ws, registry, layout, sessions, runtimes, defaultModel: config.chatModel, envFor: (app) => storage.envFor(app), peers, capabilities: () => [...bus.capabilities(), ...peers.capabilities()] });
  // A shell in the workspace root, opt-in; on a peer it is offered to the hub only while enabled here.
  const terminal = new TerminalService({ config: config.terminal, cwd: ws.home, store: new TerminalStore(store.db), env, extraEnv: { SPACE_HOME: ws.home } });
  if (config.terminal.enabled && !terminal.backend) console.error("[terminal] enabled, but this runtime has no Bun.Terminal and no python3 on PATH; sessions cannot open");
  const terminalRoutes = createTerminalRoutes({ service: terminal, name: config.name, hub: peers });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun closes a connection idle for 10 s by default, which cuts a chat stream during a long tool
    // call; 255 s is the maximum, and the chat heartbeat (20 s) keeps proxies in between alive.
    idleTimeout: 255,
    // The web UI is bundled once at boot; SPACE_DEV=1 turns on Bun's dev server (hot reload) instead.
    development: process.env.SPACE_DEV === "1",
    routes: {
      ...createRoutes({
        scheduler,
        store,
        token: config.apiToken,
        onManifest: provision,
        discover,
        onGone: async (app) => {
          registry.remove(app);
          bus.forget(app);
          void router.sync();
          console.log(`[space] ${app}: directory gone, deregistered`);
        },
        appForToken: (t) => storage.appForToken(t),
      }),
      ...createBusRoutes({ bus, store: busStore, events: store, token: config.apiToken, appForToken: (t) => storage.appForToken(t), remote }),
      ...createStorageRoutes({ storage, token: config.apiToken }),
      ...createBackupRoutes({
        store: backups.store,
        target: backups.target,
        token: config.apiToken,
        maxAgeMs: config.backupMaxAgeMs,
        taskFor: (app) => {
          const t = store.findTask(app, BACKUP_TASK);
          return t ? { id: t.id, nextRunAt: t.state.nextRunAt, enabled: effectiveEnabled(t), orphaned: t.orphaned } : undefined;
        },
        runNow: (id) => scheduler.runNow(id),
        apps: () => scheduler.apps().filter((app) => store.findTask(app, BACKUP_TASK)?.orphaned === false),
      }),
      ...createNotifyRoutes({ notify, store: notifyStore, token: config.apiToken, appForToken: (t) => storage.appForToken(t) }),
      ...createModelRoutes({ service: model, token: config.apiToken, appForToken: (t) => storage.appForToken(t), defaultModel: config.model.defaultModel }),
      ...createChatRoutes({ service: chat, token: config.apiToken, appForToken: (t) => storage.appForToken(t), widget }),
      ...panelRoutes,
      ...createRouterRoutes({ router }),
      ...createLogsRoutes({ template: config.serviceLogs, token: config.apiToken, knownApp: (app) => Boolean(registry.get(app)) }),
      ...agentRoutes,
      ...createPeerRoutes({ hub: peers, layout, registry }),
      ...terminalRoutes,
      ...createPeerServeRoutes({ token: config.hubToken, name: config.name, panel: panelRoutes, agents: agentRoutes, servicePort: (app) => registry.get(app)?.manifest.service?.port, bus, events: store, ...(terminal.enabled ? { terminal: terminalRoutes } : {}) }),
      ...createWebRoutes(),
    },
    websocket: terminalWebSocket,
    fetch: () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }),
  });
  console.log(`[space] listening on http://${config.host}:${server.port} · workspace ${ws.home} · apps ${registry.list().length}${peers.names().length ? ` · peers ${peers.names().join(", ")}` : ""}${config.hubToken ? " · serving /api/peer as " + config.name : ""}${terminal.enabled ? ` · terminal ${terminal.backend}` : ""}${router.enabled ? ` · router ${config.router.backend} :${config.router.port}` : ""} · runtimes ${runtimes.describe()} (${loaded.source})`);

  const shutdown = async () => {
    console.log("[space] shutting down");
    scheduler.stop();
    bus.stop();
    notify.stop();
    peers.stop();
    terminal.stop();
    router.stop();
    server.stop();
    await scheduler.idle();
    await bus.idle();
    await notify.idle();
    store.close();
    busStore.close();
    notifyStore.close();
    modelStore.close();
    chatStore.close();
    await backups.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { store, storage, scheduler, bus, busStore, notify, notifyStore, model, modelStore, chat, chatStore, registry, peers, server, backups };
}
if (import.meta.main) {
  // The unit runs `bun src/index.ts` with no word: that is `start`. `bin/space` with no word is `help`.
  process.exit(await run(process.argv.length > 2 ? process.argv.slice(2) : ["start"], { boot }));
}
