import { createVoiceRoutes, voiceTarget } from "./space/bus/voice.ts";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { NotifyService, NotifyStore, createNotifyRoutes, createTaskNotifier, loadChannels, parseNotifySpec } from "./space/notify/index.ts";
import { RunRegistry, SessionStore, callerAppOf, createAgentRoutes } from "./space/agents/index.ts";
import { AppRegistry, HealthProbe, IconPacks, LayoutStore, PetFeed, WidgetFeed, createPanelRoutes, runStopCommand } from "./space/panel/index.ts";
import { PeerHub, PeerStore, createPeerRoutes, createPeerServeRoutes, loadPeers } from "./space/peers/index.ts";
import { ModelService, ModelStore, createModelRoutes, recordAgentRun } from "./space/model/index.ts";
import { ModelPreferences, createModelPreferenceRoutes } from "./space/model/preferences.ts";
import { AppModels, createAppModelRoutes } from "./space/model/app-models.ts";
import { ChatService, ChatStore, createChatRoutes } from "./space/chat/index.ts";
import { buildWidget } from "./web/chat-widget/build.ts";
import { RuntimeRegistry, loadRuntimes } from "./space/runtimes/index.ts";
import { refreshCodexTiers } from "./space/runtimes/codex-upgrade.ts";
import { Bus, BusStore, Consumers, createBusRoutes, isConsumerKey } from "./space/bus/index.ts";
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
import { UsageService, UsageStore, createUsageRoutes } from "./space/usage/index.ts";
import { Launchctl, Supervisor, Systemctl, createServiceRoutes } from "./space/services/index.ts";
import { createWebRoutes } from "./web/routes.ts";
import { createIdentityRoutes } from "./space/identity.ts";
import { readVersion } from "./space/version.ts";
import { withUserToolDirs } from "./space/host-tools.ts";
import { readOwnership } from "./space/local.ts";
import { createPackageRoutes } from "./space/packages/api.ts";
import { createStudioRoutes } from "./space/studio.ts";
import { createActivityRoutes } from "./space/activity.ts";
import { PackageStore } from "./space/packages/store.ts";
import { PackageInstaller } from "./space/packages/install.ts";
import { PackageRuntime } from "./space/packages/runtime.ts";
import { Connections } from "./space/packages/connections.ts";
import { PackageLinks, createConnectionRoutes } from "./space/packages/links.ts";
import { RemoteCatalogue, sharedIcon, sharedIconResponse } from "./space/packages/catalogue.ts";
import { PackageGateway, createPackageOpenRoutes } from "./space/packages/gateway.ts";
import { runPackageTask } from "./space/packages/tasks.ts";
import { loadAppEnv } from "./space/scheduler/targets.ts";
import { PackageLifecycle } from "./space/packages/lifecycle.ts";
import { createPackagePanelRoutes } from "./space/packages/panel.ts";
import { type Config, SHARED_SKILLS, SPACE_ROOT, backupTaskDefaults, openBackups, openStorage } from "./space/config.ts";
import { run } from "./cli/main.ts";
import { bearer, guardBrowserWrites, tokenEquals } from "./space/auth.ts";
import { guardHosts, hostRules } from "./space/hosts.ts";
import { AUTH_PUBLIC, AUTH_SELF, AuthService, AuthStore, composeRoutes, createAuthRoutes, ensureOperatorToken, gateRoutes } from "./space/auth/index.ts";
import { ShortcutStore, Shortcuts, createShortcutRoutes } from "./space/shortcuts/index.ts";

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
  // The Local edition runs under launchd with a bare PATH; agent CLIs live in the user's tool directories (docs/editions.md#ai-space-local).
  // Its own bin/ first, so agents and the terminal run this release's `space` (the app-studio skill uses it).
  if (config.edition === "local") env.PATH = `${join(SPACE_ROOT, "bin")}:${withUserToolDirs(env.PATH, homedir())}`;
  // Built-in sign-in (docs/auth.md): the operator token is never empty then, or every caller past the gate would be the operator.
  if (config.auth === "builtin") config = { ...config, apiToken: await ensureOperatorToken(ws.home, config.apiToken) };
  const store = new Store(config.dbPath, { eventRetentionMs: config.eventRetentionMs });
  const auth = new AuthService(new AuthStore(store.db));
  if (config.auth === "builtin" && !auth.initialized()) console.error("[auth] SPACE_AUTH=builtin and no owner yet: every management route refuses until `space auth init` sets the password on this machine");
  const packageStore = new PackageStore(store.db);
  const packageInstaller = new PackageInstaller(ws, packageStore);
  await packageInstaller.recover();
  const version = await readVersion();
  const packageTrustKeys = await Promise.all(config.packageTrustKeys.map((path) => Bun.file(path).text()));
  const storage = await openStorage(ws, config);
  const packageEnvFor = async (app: string) => ({ ...await loadAppEnv(storage.appDataDir(app)), ...await storage.envFor(app) });
  const appEnvFor = (app: string) => packageStore.list().some((o) => o.app === app && o.state === "installed") ? packageEnvFor(app) : storage.envFor(app);
  const packageRuntime = new PackageRuntime({ envFor: packageEnvFor, logDir: ws.logs });
  let registerPackage: ((dir: string) => Promise<void>) | undefined;
  const activatePackage = async (app: string) => {
    const installed = await packageInstaller.load(app);
    await storage.syncApp(app, parseStorageSpec(installed.manifest.storage));
    await packageRuntime.register(installed);
    await registerPackage?.(installed.dir);
  };
  const packageLifecycle = new PackageLifecycle(packageInstaller, {
    suspend: (app) => packageRuntime.suspend(app),
    activate: activatePackage,
    verify: (app) => packageRuntime.verify(app),
    remove: async (app) => {
      await packageRuntime.remove(app);
      scheduler.forget(app); registry.remove(app); bus.forget(app);
      await discover();
    },
  });
  const blockedPackages = new Set<string>();
  for (const { change, error } of await packageLifecycle.recover()) {
    blockedPackages.add(change.app);
    console.error(`[packages] ${change.app}: interrupted ${change.kind} ${change.id} could not be recovered and the app stays off: ${error}`);
  }
  for (const operation of packageStore.list().filter((o) => o.state === "installed" && !blockedPackages.has(o.app))) {
    await activatePackage(operation.app).catch((e) => console.error(`[packages] ${operation.app}: ${(e as Error).message}`));
  }
  const packageConnections = new Connections(store.db, packageStore.spaceId);
  let packageGateway: PackageGateway;
  const packageLinks = new PackageLinks(packageConnections, {
    env,
    name: config.name,
    handle: (_connection, meta, body, signal) => packageGateway.local(meta, body, signal),
    apps: () => packageStore.list().filter((o) => o.state === "installed" && packageRuntime.get(o.app)).map((o) => {
      const app = packageRuntime.get(o.app)!;
      const icon = sharedIcon(app);
      return { app: o.app, title: app.manifest.title ?? o.app, version: o.version, page: !!app.manifest.launch, ...(icon.text ? { icon: icon.text } : {}), ...(icon.file ? { iconFile: true } : {}) };
    }),
    icon: (app) => sharedIconResponse(packageRuntime.get(app)),
  });
  packageGateway = new PackageGateway(packageRuntime, packageLinks, packageStore.spaceId);
  if (config.packagePort !== undefined) packageGateway.start(config.packagePort, config.packageBaseUrl);
  packageLinks.refresh();
  const packageCatalogue = new RemoteCatalogue(packageLinks);
  setTimeout(() => void packageCatalogue.refresh(), 8000).unref();
  const backups = await openBackups(config);
  // No target means backups are off: no task is registered, so none fails or shows as stale.
  const backupsOn = Boolean(config.backupUrl);
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
  // Codex tiers from the installed CLI's catalogue, in the background: the built-in names serve until it answers.
  void refreshCodexTiers(runtimes, loaded.config.runtimes, (l) => console.log(`[runtimes] ${l}`));
  const registry = new AppRegistry();
  // The bus (docs/events.md): http and stream deliveries of every stored event, and calls between apps.
  const busStore = new BusStore(config.dbPath);
  const bus = new Bus({
    store: busStore,
    events: store,
    servicePort: (app) => registry.get(app)?.manifest.service?.port,
    appFetch: (app) => packageRuntime.get(app)?.manifest.launch?.kind === "process" ? (path, init) => packageGateway.request(app, path, init) : undefined,
    onDead: (d, event) =>
      void notify
        .send(isConsumerKey(d.app) ? "space" : d.app, { level: "alert", title: `event ${d.event} not delivered${isConsumerKey(d.app) ? ` to ${d.app}` : ""}`, text: `Delivery #${d.id} (${d.kind}) gave up after ${d.attempts} attempt(s): ${d.lastError ?? "no error text"}${event ? `\nEvent #${event.id} from ${event.app} at ${new Date(event.at).toISOString()}` : ""}`, key: `bus:${d.app}:${d.event}`, windowMs: 3_600_000 })
        .catch((e) => console.error(`[bus] ${d.app}: dead-delivery notification rejected: ${(e as Error).message}`)),
  });
  // External consumers (docs/events.md#external-consumers): loaded into the bus now, so their deliveries resume.
  const consumers = new Consumers({ store: busStore, bus });
  const modelPreferences = new ModelPreferences(store.db, runtimes);
  const appDefaultModel = () => modelPreferences.read() ?? config.model.defaultModel;
  const baseDefaultModel = () => modelPreferences.read() ?? config.chatModel;
  const modelStore = new ModelStore(config.dbPath, { retentionDays: config.model.retentionDays });
  const model = new ModelService({ store: modelStore, runtimes, maxConcurrency: config.model.maxConcurrency });
  // Per app and tag, when a call names no model (docs/model.md#app-models): panel overrides, the manifest, then the default above.
  const appModels = new AppModels(store.db, {
    manifest: (app) => registry.get(app)?.manifest.model,
    fallback: appDefaultModel,
    runnable: (m) => {
      try {
        model.resolve(m);
        return true;
      } catch {
        return false;
      }
    },
    options: () => modelPreferences.options(),
  });
  const chatStore = new ChatStore(config.dbPath);
  const chat = new ChatService({ store: chatStore, model, defaultModel: (app, tag) => appModels.resolve(app, tag), fileDir: (app) => join(storage.appDataDir(app), "chat") });
  // A chat turn the last process did not live to finish is closed here, with the text it had saved (docs/chat.md#turn).
  chat.settleInterrupted();
  // The widget apps embed is bundled once at boot; SPACE_DEV=1 rebuilds it on every request.
  const widget = buildWidget({ dev: process.env.SPACE_DEV === "1" });
  // Agent tasks run on their runtime from the scheduler; their usage reaches the ledger from the run result.
  const recordAgent = recordAgentRun(model);
  const scheduler = new Scheduler({
    store,
    maxConcurrency: config.maxConcurrency,
    envFor: appEnvFor,
    runner: async (task, ctx) => {
      const startedAt = Date.now();
      const result = packageStore.list().some((o) => o.app === task.app && o.state === "installed")
        ? await runPackageTask(packageRuntime, task, { ...ctx, runtimes })
        : await runTarget(task.target, { ...ctx, runtimes });
      recordAgent(task, result, startedAt, Date.now());
      return result;
    },
    onFinish: createTaskNotifier({ notify, tasksChannel: config.notifyTasks }),
    onPublish: (event) => bus.onEvent(event),
  });
  const layout = new LayoutStore(store.db);
  const icons = new IconPacks(ws.home, store.db);
  const sessions = new SessionStore(store.db);
  // How often apps, agents and the panel's windows are opened, and for how long (docs/usage.md).
  const usage = new UsageService(new UsageStore(store.db, { retentionDays: config.usageRetentionDays }));
  // Panel chat turns run in the background: a page closing does not stop them (docs/panel.md#chat).
  const agentRuns = new RunRegistry(store.db, { timeoutMs: config.chatTimeoutMs, onRunStart: usage.runStarted, onRunEnd: usage.runEnded });
  const health = new HealthProbe();
  const widgets = new WidgetFeed(registry, { appFetch: (app, path, init) => packageGateway.request(app, path, init) });
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
  // Shortcuts (docs/shortcuts.md): the actions the command box and the Shortcuts panel run, as the operator.
  const shortcutStore = new ShortcutStore(config.dbPath);
  const shortcuts = new Shortcuts({
    store: shortcutStore,
    bus,
    scheduler: { runNow: (id) => scheduler.runNow(id), getTask: (id) => store.getTask(id), listTasks: () => store.listTasks(), listRuns: (id, limit) => store.listRuns(id, limit) },
    running: (app) => Boolean(registry.get(app)?.manifest.service?.port || packageRuntime.get(app)),
    peers: {
      capabilities: () => peers.capabilities(),
      call: async (peer, app, capability, body) => {
        const client = peers.get(peer);
        if (!client) throw new Error(`unknown peer: ${peer}`);
        const res = await client.forward(new Request("http://peer/", { method: "POST", headers: { "content-type": "application/json" }, body }), `/api/peer/call/${encodeURIComponent(app)}/${encodeURIComponent(capability)}`, { headers: { "x-space-caller": `${config.name}/space`, accept: "application/json" } });
        return { status: res.status, body: await res.text() };
      },
    },
    log: (m) => console.log(`[shortcuts] ${m}`),
  });
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

  // Service supervision (docs/supervision.md): under SPACE_SUPERVISOR=space one user unit per app
  // (systemd on Linux, a LaunchAgent on macOS), kept in step with its manifest on every sync;
  // under operator, the operator's units as before.
  const manager = process.platform === "darwin" ? new Launchctl({ logDir: ws.logs }) : new Systemctl({ unitDir: join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "systemd", "user") });
  const supervisor = new Supervisor({
    mode: config.supervisor,
    envDir: join(ws.run, "env"),
    manager,
    envFor: (app) => storage.envFor(app),
    probe: async (port, path) => {
      try {
        return (await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) })).ok ? "ok" : "down";
      } catch {
        return "down";
      }
    },
    log: (l) => console.error(`[services] ${l}`),
  });
  if (config.supervisor === "space" && !(await manager.available())) console.error(`[services] SPACE_SUPERVISOR=space, but services cannot start: ${manager.unavailable}`);
  // launchd appends to one file per app and never rotates it: keep each under its cap, hourly.
  if (config.supervisor === "space" && manager instanceof Launchctl) {
    const rotate = () => void manager.rotateLogs().then((apps) => apps.forEach((a) => console.error(`[services] ${a}: log rotated`)), (e) => console.error(`[services] log rotation: ${(e as Error).message}`));
    rotate();
    setInterval(rotate, 3_600_000).unref();
  }

  // Storage first, so a command task started right after sync already sees its DATABASE_URL.
  // Returns the tasks the services contribute for the app: its backup task, unless the manifest opts out.
  const provision = async (manifest: Manifest) => {
    if (manifest.app === SPACE_APP) throw new Error(`the app name "${SPACE_APP}" is reserved for ai-space itself`);
    const result = await storage.syncApp(manifest.app, parseStorageSpec(manifest.storage));
    for (const p of result.created) console.log(`[storage] ${manifest.app}: created ${p}`);
    for (const n of result.orphaned) console.log(`[storage] ${manifest.app}: ${n} left the manifest, kept as orphaned`);
    notify.syncApp(manifest.app, parseNotifySpec(manifest.notify, { title: manifest.title }));
    bus.syncApp(manifest.app, { events: manifest.events, provides: manifest.provides });
    const backup = backupsOn ? backupTask(manifest.app, parseBackupSpec(manifest.backup), taskDefaults) : undefined;
    if (backup && manifest.tasks.some((t) => t.name === BACKUP_TASK)) throw new Error(`task name "${BACKUP_TASK}" is reserved for ai-space's backup task; rename it, or set backup: false to bring your own`);
    await registry.set(manifest.spec === 2 && packageRuntime.get(manifest.app)?.manifest.launch ? { ...manifest, url: `/_space/apps/${encodeURIComponent(manifest.app)}` } : manifest);
    // After storage, so the unit's environment has the app's space.env. Never throws: a unit that
    // fails is recorded and shows on the Services list, the rest of the app still registers.
    if (manifest.spec !== 2) await supervisor.apply(manifest);
    void router.sync();
    return backup ? [backup] : [];
  };

  // What this machine registers for a manifest: boot and the sync routes go through the same step.
  const resolve = (manifest: Manifest) => manifest.spec === 2 ? manifest : applyEnvOverrides(manifest, env, { domain: config.router.domain });
  const loadApp = async (dir: string, changing = false): Promise<Manifest> => {
    if (!changing && packageLifecycle.list().some((c) => c.app === basename(dir) && c.state === "pending")) throw new Error("package is changing version");
    const operation = packageStore.list().find((o) => o.app === basename(dir) && o.state === "installed");
    if (!operation) return loadManifest(dir);
    const installed = await packageInstaller.load(operation.app);
    if (installed.dir !== dir) throw new Error("package identity conflicts with an extra app directory");
    await packageRuntime.register(installed);
    return installed.manifest;
  };
  const syncDir = async (dir: string, changing = false) => {
    const manifest = resolve(await loadApp(dir, changing));
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
  registerPackage = async (dir) => { await syncDir(dir, true); await discover(); };
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
  scheduler.syncBuiltin(spaceManifest(taskDefaults, undefined, { backups: backupsOn }));
  // After the built-in: tasks of an app whose directory disappeared while ai-space was down: no sync registered
  // it, so nothing would ever forget it. A skipped directory of that name is not gone, only broken.
  for (const app of scheduler.leftovers()) {
    if (skippedNames.has(app)) continue;
    const s = scheduler.forget(app);
    if (!s) continue;
    bus.forget(app);
    console.error(`[space] ${app}: no directory in the workspace, ${s.orphaned.length} task(s) orphaned`);
  }
  // The units of apps that left while the space was down; a skipped directory still owns its unit.
  for (const app of await supervisor.sweep(new Set([...registry.list().map((e) => e.manifest.app), ...skippedNames]))) console.error(`[services] ${app}: no app of that name, its unit was removed`);
  notify.start();
  bus.start();
  await scheduler.start();
  peers.start();
  void router.sync();

  const panelRoutes = createPanelRoutes({
    sharedApps: (hidden) => packageCatalogue.views(hidden),
    sharedIcon: (connection, app) => packageCatalogue.icon(connection, app),
    packageCheckUrl: (app, check) => `http://127.0.0.1:${config.port}/api/panel/packages/apps/${encodeURIComponent(app)}/checks/${encodeURIComponent(check)}`,
    ws,
    registry,
    layout,
    widgets,
    pets: new PetFeed(registry),
    health,
    peers,
    icons,
    onCreate: syncDir,
    runningTasks: (app) => scheduler.runningTasks(app),
    onRemove: async (app) => {
      scheduler.forget(app);
      bus.forget(app);
      void router.sync();
    },
    supervision: { mode: supervisor.mode, lastOf: (app) => (supervisor.mode === "space" ? supervisor.lastOf(app) : undefined) },
    ...(supervisor.mode === "space"
      ? {
          stopService: async (app: string) => {
            try {
              await supervisor.remove(app);
              return { ok: true };
            } catch (e) {
              return { ok: false, error: (e as Error).message };
            }
          },
        }
      : config.serviceStop
        ? { stopService: (app: string) => runStopCommand(config.serviceStop, app) }
        : {}),
  });
  const agentRoutes = createAgentRoutes({ actionCatalogue: () => shortcuts.catalogue(), shortcuts: shortcutStore, holdApp: async (app) => packageRuntime.get(app) ? (await packageRuntime.acquire(app, false)).release : undefined, ws, registry, layout, sessions, runs: agentRuns, runtimes, defaultModel: config.chatModel, baseDefaultModel, appModel: (app) => ({ override: appModels.overrides(app).app, manifest: registry.get(app)?.manifest.model?.default }), envFor: appEnvFor, peers, icons, capabilities: () => [...bus.capabilities(), ...peers.capabilities()], sharedSkills: SHARED_SKILLS,
    callerApp: (req) => callerAppOf(req, { operatorToken: config.apiToken, hubToken: config.hubToken, isDevice: (t) => Boolean(auth.verifyDevice(t)), appForToken: (t) => storage.appForToken(t) }), agentCallers: config.agentCallers });
  // A shell in the workspace root, opt-in; on a peer it is offered to the hub only while enabled here.
  const terminal = new TerminalService({ config: config.terminal, cwd: ws.home, store: new TerminalStore(store.db), env, extraEnv: { SPACE_HOME: ws.home } });
  if (config.terminal.enabled && !terminal.backend) console.error("[terminal] enabled, but this runtime has no Bun.Terminal and no python3 on PATH; sessions cannot open");
  const terminalRoutes = createTerminalRoutes({ service: terminal, name: config.name, hub: peers });

  // Every route table with the callers it serves under SPACE_AUTH=builtin (docs/auth.md#access-policy); later tables win a shared key.
  const { routes, policies } = composeRoutes(
    [
      ["app", createRoutes({
        scheduler,
        store,
        runtimes,
        token: config.apiToken,
        resolve,
        load: loadApp,
        onManifest: provision,
        discover,
        onGone: async (app) => {
          await supervisor.remove(app).catch((e) => console.error(`[services] ${app}: unit not removed: ${(e as Error).message}`));
          registry.remove(app);
          bus.forget(app);
          void router.sync();
          console.log(`[space] ${app}: directory gone, deregistered`);
        },
        appForToken: (t) => storage.appForToken(t),
      })],
      ["app", createVoiceRoutes(() => voiceTarget(bus, remote, (app) => registry.get(app)?.manifest.service?.port))],
      ["app", createBusRoutes({ bus, store: busStore, events: store, token: config.apiToken, appForToken: (t) => storage.appForToken(t), remote, consumers })],
      ["owner", createShortcutRoutes({ shortcuts })],
      ["owner", createStorageRoutes({ storage, token: config.apiToken })],
      ["owner", createBackupRoutes({
        store: backups.store,
        target: backups.target,
        enabled: backupsOn,
        token: config.apiToken,
        maxAgeMs: config.backupMaxAgeMs,
        taskFor: (app) => {
          const t = store.findTask(app, BACKUP_TASK);
          return t ? { id: t.id, nextRunAt: t.state.nextRunAt, enabled: effectiveEnabled(t), orphaned: t.orphaned } : undefined;
        },
        runNow: (id) => scheduler.runNow(id),
        apps: () => scheduler.apps().filter((app) => store.findTask(app, BACKUP_TASK)?.orphaned === false),
      })],
      ["app", createNotifyRoutes({ notify, store: notifyStore, token: config.apiToken, appForToken: (t) => storage.appForToken(t) })],
      ["owner", createModelPreferenceRoutes(modelPreferences, { model: config.model.defaultModel, base: config.chatModel })],
      ["app", createModelRoutes({ service: model, token: config.apiToken, appForToken: (t) => storage.appForToken(t), resolveModel: (app, tag) => appModels.resolve(app, tag) })],
      ["owner", createAppModelRoutes({ appModels, apps: () => registry.list().map((e) => e.manifest.app), seenTags: (app) => modelStore.tags(app, Date.now() - 30 * 86400_000) })],
      ["app", createChatRoutes({ service: chat, token: config.apiToken, appForToken: (t) => storage.appForToken(t), widget })],
      ["public", createIdentityRoutes({ version, edition: config.edition, id: packageStore.spaceId, name: config.name, token: config.apiToken, managed: Boolean(await readOwnership(ws.home)) })],
      ["owner", panelRoutes],
      ["owner", createPackageRoutes({ installer: packageInstaller, token: config.apiToken, trustedKeys: packageTrustKeys, runtime: packageRuntime, lifecycle: packageLifecycle, activate: activatePackage })],
      ["owner", createActivityRoutes({ token: config.apiToken, tasks: () => scheduler.running(), modelCalls: () => model.inFlight(), agentTurns: () => agentRuns.running(), terminals: () => terminal.status().active, packageChanges: () => packageInstaller.busy + packageLifecycle.busy })],
      ["owner", createStudioRoutes({ ws, installer: packageInstaller, lifecycle: packageLifecycle, store: packageStore, activate: activatePackage, token: config.apiToken, log: (l) => console.error(`[studio] ${l}`) })],
      ["owner", createPackagePanelRoutes({ installer: packageInstaller, token: config.apiToken, trustedKeys: packageTrustKeys, runtime: packageRuntime, lifecycle: packageLifecycle, activate: activatePackage, gateway: packageGateway, links: packageLinks })],
      ["owner", createConnectionRoutes({ links: packageLinks, token: config.apiToken })],
      ["owner", createPackageOpenRoutes(packageGateway, config.apiToken)],
      ["owner", createRouterRoutes({ router })],
      ["owner", createUsageRoutes({ service: usage, knownApp: (app) => Boolean(registry.get(app)) })],
      ["owner", createLogsRoutes({ template: config.serviceLogs, token: config.apiToken, knownApp: (app) => Boolean(registry.get(app)), ...(supervisor.mode !== "space" ? {} : manager instanceof Launchctl ? { appTemplate: manager.logsTemplate() } : { unitOf: (app: string) => manager.unitName(app) }) })],
      ["owner", createServiceRoutes({ supervisor, hasService: (app) => { const e = registry.get(app); return e ? Boolean(e.manifest.service) : undefined; }, manifest: (app) => registry.get(app)?.manifest })],
      ["owner", agentRoutes],
      ["owner", createPeerRoutes({ hub: peers, layout, registry })],
      ["owner", terminalRoutes],
      ["self", createPeerServeRoutes({ token: config.hubToken, name: config.name, panel: panelRoutes, agents: agentRoutes, allowApp: (app) => !packageStore.list().some((o) => o.app === app && o.state === "installed"), servicePort: (app) => registry.get(app)?.manifest.service?.port, bus, events: store, ...(terminal.enabled ? { terminal: terminalRoutes } : {}) })],
      ["public", createWebRoutes()],
      ["owner", createAuthRoutes({ mode: config.auth, auth })],
    ],
    {
      ...Object.fromEntries(AUTH_PUBLIC.map((k) => [k, "public" as const])),
      ...Object.fromEntries(AUTH_SELF.map((k) => [k, "self" as const])),
      "/healthz": "public",
      "/api/chat/widget.js": "public",
      "/api/chat/widget.css": "public",
      "/_space/usage.js": "public",
      // Heartbeats arrive through the router from app pages, which hold no panel session; they only count time in use.
      "/_space/usage/beat": "public",
      // Checked by the connection's own token and the remote space's id.
      "/api/connections/channel": "self",
      // What apps read about the space today (space-ops, ai-usage, ai-spark, voice-chat), with their app token.
      "/api/apps": "app-read",
      "/api/apps/:app": "app-read",
      "/api/peers/:peer/apps/:app": "app-read",
      "/api/services": "app-read",
      "/api/peers": "app-read",
      "/api/agents": "app-read",
      // An app runs its own agents from its page through its own proxy, with its token (docs/panel.md#apps-and-their-agents);
      // the routes refuse another app's agents.
      "/api/agents/:app/:agent/chat": "app",
      "/api/agents/:app/:agent/runs": "app",
      "/api/agents/:app/:agent/runs/:id": "app",
      "/api/agents/:app/:agent/runs/:id/events": "app",
      "/api/agents/:app/:agent/runs/:id/stop": "app",
      "/api/agents/:app/:agent/runs/:id/steer": "app",
      "/api/agents/:app/:agent/runs/:id/approvals/:rid": "app",
      "/api/agents/:app/:agent/sessions": "app",
      "/api/agents/:app/:agent/sessions/:sid": "app",
      "/api/checks": "app-read",
      "/api/panel/packages/apps/:app/checks/:check": "app-read",
      // An app's /api/ paths on a peer, as an app on this machine reaches another app's port directly (space-ops, ai-usage, asset-center).
      "/api/peers/:peer/apps/:app/proxy/*": "app",
    },
  );

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun closes a connection idle for 10 s by default, which cuts a chat stream during a long tool
    // call; 255 s is the maximum, and the chat heartbeat (20 s) keeps proxies in between alive.
    idleTimeout: 255,
    // The web UI is bundled once at boot; SPACE_DEV=1 turns on Bun's dev server (hot reload) instead.
    development: process.env.SPACE_DEV === "1",
    // Panel routes carry no token: a write from another site's page is refused (src/space/auth.ts).
    // Under SPACE_AUTH=builtin each route also needs the caller its policy names (src/space/auth/gate.ts).
    // Each module types its own table; the merged one is a plain record, hence the cast.
    // A name this space does not know, without a credential, is refused (DNS rebinding; src/space/hosts.ts).
    routes: guardHosts(guardBrowserWrites(gateRoutes(routes, policies, { mode: config.auth, auth, operatorToken: config.apiToken, isAppCredential: async (t) => Boolean(await storage.appForToken(t)) || Boolean(consumers.authenticate(t)) })), policies, {
      rules: hostRules({ panelHost: config.router.panelHost, domain: config.router.domain, allowed: config.allowedHosts }),
      hasCredential: async (req) => {
        const t = bearer(req);
        if (!t) return false;
        return tokenEquals(t, config.apiToken) || tokenEquals(t, config.hubToken) || Boolean(auth.verifyDevice(t)) || Boolean(await storage.appForToken(t)) || Boolean(consumers.authenticate(t));
      },
      log: (l) => console.error(l),
    }) as never,
    websocket: terminalWebSocket,
    fetch: () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }),
  });
  console.log(`[space] listening on http://${config.host}:${server.port} · workspace ${ws.home} · apps ${registry.list().length}${peers.names().length ? ` · peers ${peers.names().join(", ")}` : ""}${config.hubToken ? " · serving /api/peer as " + config.name : ""}${terminal.enabled ? ` · terminal ${terminal.backend}` : ""}${router.enabled ? ` · router ${config.router.backend} :${config.router.port}` : ""} · services by ${supervisor.mode} · runtimes ${runtimes.describe()} (${loaded.source})`);

  // A restart must not cut the work in flight: no new runs are started, then the task runs and the
  // model calls apps are blocked on get SPACE_DRAIN_SECONDS to finish. The server keeps serving while
  // they do, because a command task in flight still calls /api/model/run. What is still going when the
  // grace is over is aborted and recorded, so nothing disappears silently. The unit must give the
  // process more than this: KillMode=mixed (children survive until the drain is over) and a
  // TimeoutStopSec above SPACE_DRAIN_SECONDS. See deploy/ai-space.service and docs/scheduler.md.
  const shutdown = async () => {
    console.log("[space] shutting down");
    scheduler.stop();
    bus.stop();
    notify.stop();
    peers.stop();
    terminal.stop();
    router.stop();
    packageCatalogue.close();
    packageLinks.close();
    packageGateway.close();
    const at = Date.now();
    const [runs, calls, chats] = await Promise.all([scheduler.drain(config.drainMs), model.drain(config.drainMs), agentRuns.shutdown(config.drainMs)]);
    console.log(`[space] drained in ${Date.now() - at}ms: ${runs.finished} run(s) finished, ${runs.aborted} aborted; ${calls.finished} model call(s) finished, ${calls.interrupted} interrupted; ${chats.finished} chat turn(s) finished, ${chats.interrupted} interrupted`);
    // Conversations' live processes waiting for their next turn (docs/runtimes.md#live-chat).
    runtimes.closeLive();
    server.stop();
    await packageInstaller.drain();
    await packageLifecycle.drain();
    await packageRuntime.close(config.drainMs);
    await bus.idle();
    await notify.idle();
    await shortcuts.idle();
    store.close();
    busStore.close();
    shortcutStore.close();
    notifyStore.close();
    modelStore.close();
    chatStore.close();
    await backups.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { supervisor, store, storage, scheduler, bus, busStore, notify, notifyStore, model, modelStore, chat, chatStore, registry, peers, server, backups, agentRuns };
}
if (import.meta.main) {
  // The unit runs `bun src/index.ts` with no word: that is `start`. `bin/space` with no word is `help`.
  process.exit(await run(process.argv.length > 2 ? process.argv.slice(2) : ["start"], { boot }));
}
