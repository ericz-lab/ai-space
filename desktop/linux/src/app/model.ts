import GLib from "gi://GLib";
import { type Agent, type Catalogue, NotASpaceError, agentBase, decodeCatalogue } from "../core/catalogue.ts";
import { groupById, groupKeyOf, preferredMachine } from "../core/agents.ts";
import { type Identity, type SpaceState, SpaceError, classifyIdentity, classifyLayout } from "../core/check.ts";
import { ChangeGate } from "../core/change.ts";
import { type Connection, ConnectionList, decodeConnections, encodeConnections } from "../core/connections.ts";
import { normalizeConnectionUrl, sameOrigin } from "../core/url.ts";
import { Conversation, type RunInfo } from "../core/conversation.ts";
import { type InboxItem, type InboxSummary, InboxSeen, decodeInbox } from "../core/desktop.ts";
import { dirs, exists, log, logError, newId, path, prefs, readText, readTextSync, savePrefs, sleep, t, writeText } from "./env.ts";
import { SpaceClient } from "./http.ts";
import { collectSoon } from "./memory.ts";
import { cookieHeader, forgetSession } from "./web.ts";

/**
 * The app's state: the saved Spaces and, for each, where it stands, its catalogue (the last one
 * kept on disk, shown marked as such while the Space cannot be reached), its inbox and its
 * conversations. Views listen for changes; the model never touches a widget.
 */

export type Change = "connections" | "state" | "catalogue" | "inbox" | "chat" | "selection";

export class Space {
  readonly client: SpaceClient;
  state: SpaceState = { kind: "connecting" };
  identity: Identity | undefined;
  catalogue: Catalogue | undefined;
  /** When the catalogue shown was fetched; with `stale`, it is the last known one. */
  catalogueAt = 0;
  stale = false;
  inbox: { items: InboxItem[]; summary: InboxSummary } = { items: [], summary: { unread: 0, open: 0 } };
  readonly seen = new InboxSeen();
  readonly conversations = new Map<string, Conversation>();
  refreshing: Promise<void> | undefined;
  /** What was last announced, so the same catalogue or inbox fetched again redraws nothing. */
  readonly shown = new ChangeGate();
  /** Counts the catalogue's changes, so a view can tell whether it already draws this one. */
  catalogueVersion = 0;
  /** When the catalogue was last kept on disk. */
  savedAt = 0;

  constructor(public conn: Connection) {
    this.client = new SpaceClient(conn.url, (uri) => cookieHeader(conn.id, uri));
  }

  get ready(): boolean {
    return this.state.kind === "ready";
  }

  /** Whether the catalogue, with its last-known mark, differs from what was last announced. */
  catalogueChanged(): boolean {
    if (!this.shown.changed("catalogue", [this.catalogue, this.stale])) return false;
    this.catalogueVersion++;
    return true;
  }
}

/** The catalogue on disk is rewritten when it changes, and at least this often for its date. */
const CACHE_EVERY_MS = 10 * 60_000;

const CONNECTIONS_FILE = path(dirs.config, "connections.json");

/** How often the Space is looked at; `AISPACE_POLL_SECONDS` shortens it for a soak test (desktop/linux/soak.ts). */
const POLL_SECONDS = Math.max(1, Number(GLib.getenv("AISPACE_POLL_SECONDS") ?? "30") || 30);

export class AppModel {
  readonly list: ConnectionList;
  /** Why the saved file could not be read; it was set aside under this name. */
  loadError: string | undefined;
  private readonly spaces = new Map<string, Space>();
  private currentId: string | undefined;
  private readonly listeners = new Set<(c: Change, space?: Space) => void>();
  private timer = 0;
  private ticks = 0;
  /** The Local edition signs in to its own Space with the device credential; set by LocalManager. */
  signIn: ((space: Space) => Promise<boolean>) | undefined;
  /** The saved Space the Local edition runs but that is not marked yet (`localToClaim`); set by LocalManager. */
  localToClaim: ((connections: readonly Connection[]) => string | undefined) | undefined;
  /** New unread inbox threads, for desktop notifications. */
  onFreshInbox: ((space: Space, items: InboxItem[]) => void) | undefined;

  constructor() {
    let saved: Connection[] = [];
    const text = readTextSync(CONNECTIONS_FILE);
    if (text !== undefined) {
      try {
        saved = decodeConnections(text);
      } catch {
        // Keep the unreadable file for the person instead of overwriting it on the next save.
        const aside = path(dirs.config, "connections.unreadable.json");
        GLib.rename(CONNECTIONS_FILE, aside);
        this.loadError = aside;
      }
    }
    this.list = new ConnectionList(saved, newId);
    this.currentId = this.list.default?.id;
  }

  on(fn: (c: Change, space?: Space) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change, space?: Space): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(c, space);
      } catch (e) {
        logError(e, `listener for ${c}`);
      }
    }
  }

  save(): void {
    void writeText(CONNECTIONS_FILE, encodeConnections(this.list.connections), 0o600).catch((e) => logError(e, "could not save the Spaces"));
    this.emit("connections");
  }

  space(id: string): Space | undefined {
    const conn = this.list.get(id);
    if (!conn) return undefined;
    let s = this.spaces.get(id);
    if (!s) {
      s = new Space(conn);
      this.spaces.set(id, s);
      void this.loadCachedCatalogue(s);
    } else if (s.conn.url !== conn.url) {
      // The address changed: a new client and a fresh look.
      s.client.close();
      s = new Space(conn);
      this.spaces.set(id, s);
    }
    s.conn = conn;
    return s;
  }

  get current(): Space | undefined {
    return this.currentId ? this.space(this.currentId) : undefined;
  }

  select(id: string): void {
    if (!this.list.get(id) || id === this.currentId) return;
    this.currentId = id;
    this.emit("selection", this.current);
    void this.refresh(this.current!);
  }

  add(name: string, url: string, opts: { managed?: boolean; makeDefault?: boolean } = {}): Space {
    const c = this.list.add(name, url, opts);
    this.markLocal();
    this.save();
    this.select(c.id);
    return this.space(c.id)!;
  }

  remove(id: string): void {
    this.list.remove(id);
    this.spaces.get(id)?.client.close();
    this.spaces.delete(id);
    forgetSession(id);
    if (this.currentId === id) this.currentId = this.list.default?.id;
    this.save();
    this.emit("selection", this.current);
    if (this.current) void this.refresh(this.current);
  }

  /**
   * A saved Space's new name or address. A new address gets a new client and a fresh look, and
   * the pages of the old one close (the window shows the Space again).
   */
  update(id: string, name: string, url: string): void {
    const before = this.list.get(id)?.url;
    this.list.update(id, name, url);
    const moved = before !== undefined && before !== url;
    if (moved) {
      // `space()` cannot see the change: the Space shares the list's connection object.
      this.spaces.get(id)?.client.close();
      this.spaces.delete(id);
    }
    this.markLocal();
    this.save();
    if (moved && this.currentId === id) {
      this.emit("selection", this.current);
      void this.refresh(this.current!);
    }
  }

  /** The Space the Local edition runs was saved without its mark (`localToClaim`): mark it, so the app signs in with the device credential. */
  claimLocal(id: string): void {
    const c = this.list.get(id);
    if (!c || c.managed) return;
    log("local", "marking", c.name, "as this computer's Space");
    this.list.setManaged(id, c.url);
    this.save();
    // It may already show "sign in": look again, now with the device credential.
    const space = this.spaces.get(id);
    if (space?.state.kind === "signin") void this.refresh(space);
  }

  /** A Space added or pointed at the Local edition's address after launch is its own too. */
  private markLocal(): void {
    const id = this.localToClaim?.(this.list.connections);
    const c = id ? this.list.get(id) : undefined;
    if (!c || c.managed) return;
    log("local", "marking", c.name, "as this computer's Space");
    this.list.setManaged(c.id, c.url);
  }

  /**
   * After the Local edition is set up or taken over: the Space it runs becomes the saved, default
   * and shown one, marked as the app's own so the app signs in to it with its device credential.
   */
  adoptLocal(address: string): Space {
    const url = normalizeConnectionUrl(address);
    const existing = this.list.managed ?? this.list.connections.find((c) => sameOrigin(c.url, url));
    let id: string;
    if (existing) {
      // A Space at another address gets a new client on the next look.
      if (!sameOrigin(existing.url, url)) {
        this.spaces.get(existing.id)?.client.close();
        this.spaces.delete(existing.id);
      }
      this.list.setManaged(existing.id, sameOrigin(existing.url, url) ? existing.url : url);
      id = existing.id;
    } else {
      id = this.list.add(t("thisComputer"), url, { makeDefault: true, managed: true }).id;
    }
    this.list.setDefault(id);
    this.save();
    const space = this.space(id)!;
    if (this.currentId !== id) {
      this.currentId = id;
      this.emit("selection", space);
    }
    void this.refresh(space);
    return space;
  }

  /** After the background service was removed: the Space stays saved but is no longer the app's own. */
  releaseLocal(): void {
    const c = this.list.managed;
    if (!c) return;
    this.list.setManaged(c.id, c.url, false);
    this.save();
  }

  // Refreshing

  /** One look at the Space: identity, session, catalogue, inbox. Overlapping asks share one look. */
  refresh(space: Space, opts: { catalogue?: boolean } = {}): Promise<void> {
    if (space.refreshing) return space.refreshing;
    space.refreshing = this.look(space, opts.catalogue ?? true).finally(() => (space.refreshing = undefined));
    return space.refreshing;
  }

  private setState(space: Space, state: SpaceState): void {
    const before = JSON.stringify(space.state);
    space.state = state;
    if (JSON.stringify(state) !== before) {
      log("state", space.conn.name, state);
      this.emit("state", space);
    }
  }

  private async look(space: Space, withCatalogue: boolean): Promise<void> {
    const c = space.client;
    try {
      const id = await c.answer("GET", "/api/space");
      const verdict = classifyIdentity(id.status, id.body);
      if ("state" in verdict && verdict.state.kind !== "signin") return this.setState(space, verdict.state);
      if ("identity" in verdict) space.identity = verdict.identity;

      let layout = await c.answer("GET", "/api/panel/layout");
      let state = classifyLayout(layout.status, layout.contentType, layout.body);
      if (state.kind === "signin" && space.conn.managed && this.signIn && (await this.signIn(space))) {
        layout = await c.answer("GET", "/api/panel/layout");
        state = classifyLayout(layout.status, layout.contentType, layout.body);
      }
      if (state.kind !== "ready") return this.setState(space, state);
      this.setState(space, { kind: "ready", ...(space.identity ? { version: space.identity.version, edition: space.identity.edition, ...(space.identity.name ? { name: space.identity.name } : {}) } : {}) });

      const [, , runs] = await Promise.all([
        this.loadInbox(space),
        withCatalogue || !space.catalogue ? this.loadCatalogue(space, JSON.parse(layout.body) as unknown) : Promise.resolve(),
        c.get("/api/agents/runs").catch(() => undefined),
      ]);
      this.attachRuns(space, runs);
    } catch (e) {
      if (e instanceof SpaceError && e.kind === "signin") return this.setState(space, { kind: "signin" });
      if (e instanceof NotASpaceError) return this.setState(space, { kind: "incompatible", detail: e.message });
      this.setState(space, { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) });
      if (space.catalogue) {
        space.stale = true;
        if (space.catalogueChanged()) this.emit("catalogue", space);
      }
    }
  }

  private async loadCatalogue(space: Space, layout: unknown): Promise<void> {
    const c = space.client;
    const optional = (p: string) => c.get(p).catch(() => undefined);
    const [apps, agents, widgets, peers, router] = await Promise.all([c.get("/api/apps"), c.get("/api/agents"), c.get("/api/widgets"), optional("/api/peers"), optional("/api/router")]);
    const raw = { apps, agents, widgets, peers, layout, router };
    space.catalogue = decodeCatalogue(raw);
    space.catalogueAt = Date.now();
    space.stale = false;
    const changed = space.catalogueChanged();
    if (changed) this.emit("catalogue", space);
    if (!changed && space.catalogueAt - space.savedAt < CACHE_EVERY_MS) return;
    space.savedAt = space.catalogueAt;
    void writeText(path(dirs.cache, `catalogue-${space.conn.id}.json`), JSON.stringify({ at: space.catalogueAt, raw }), 0o600).catch(() => {});
  }

  private async loadCachedCatalogue(space: Space): Promise<void> {
    const file = path(dirs.cache, `catalogue-${space.conn.id}.json`);
    if (!exists(file)) return;
    try {
      const { at, raw } = JSON.parse((await readText(file)) ?? "") as { at: number; raw: Parameters<typeof decodeCatalogue>[0] };
      if (space.catalogue) return;
      space.catalogue = decodeCatalogue(raw);
      space.catalogueAt = at;
      space.stale = true;
      if (space.catalogueChanged()) this.emit("catalogue", space);
    } catch {}
  }

  async loadInbox(space: Space): Promise<void> {
    try {
      space.inbox = decodeInbox(await space.client.get("/api/inbox?filter=open&limit=200"));
      const fresh = space.seen.fresh(space.inbox.items);
      if (fresh.length) this.onFreshInbox?.(space, fresh);
      if (space.shown.changed("inbox", space.inbox)) this.emit("inbox", space);
    } catch (e) {
      if (e instanceof SpaceError && e.kind === "signin") this.setState(space, { kind: "signin" });
    }
  }

  async markInbox(space: Space, threads: string[], change: { read?: boolean; done?: boolean }): Promise<void> {
    try {
      await space.client.send("POST", "/api/inbox/mark", { threads, ...change });
    } catch (e) {
      logError(e, "inbox");
    }
    await this.loadInbox(space);
  }

  async markAllRead(space: Space): Promise<void> {
    await space.client.send("POST", "/api/inbox/read-all", {}).catch((e) => logError(e, "inbox"));
    await this.loadInbox(space);
  }

  /** Picks up turns still running on the Space (started here before a restart, or on another client). */
  private attachRuns(space: Space, body: unknown): void {
    const runs = ((body as { runs?: RunInfo[] } | undefined)?.runs ?? []).filter((r) => r.status === "running");
    if (!runs.length || !space.catalogue) return;
    for (const run of runs) {
      const agent = space.catalogue.agentInfo.find((a) => !a.peer && `${a.app}/${a.name}` === run.agent);
      if (agent) this.conversation(space, agent).attachRunning(runs);
    }
  }

  // Conversations

  conversation(space: Space, agent: Agent): Conversation {
    let conv = space.conversations.get(agent.id);
    if (conv) return conv;
    conv = new Conversation({ id: `${agent.app}/${agent.name}`, base: agentBase(agent) }, space.client, {
      permission: () => prefs.permission,
      setPermission: (p) => {
        prefs.permission = p;
        savePrefs();
      },
      sleep,
      newId,
      onChange: () => this.emit("chat", space),
      // A turn may install or change apps.
      onTurnEnded: () => void this.refresh(space),
      text: { stopped: t("stopped"), signIn: t("signInFirst"), lost: t("connectionLost"), grantMessage: t("grantMessage"), noTurn: t("noTurn"), answerFailed: (why) => t("answerFailed", { why }) },
    });
    space.conversations.set(agent.id, conv);
    return conv;
  }

  /** The machine an agent's tile opens (any variant given): the one chosen last when it answers, else the group's own (agents.ts). */
  preferredAgent(space: Space, agent: Agent): Agent {
    const g = groupById(space.catalogue?.agentGroups ?? [], agent.id);
    return g ? preferredMachine(g, prefs.agentMachines?.[g.key]) : agent;
  }

  /** The person picked this machine for this agent in a chat: tiles open it next time. */
  rememberMachine(agent: Agent): void {
    prefs.agentMachines = { ...(prefs.agentMachines ?? {}), [groupKeyOf(agent)]: agent.peer ?? "" };
    savePrefs();
  }

  /** Space Assistant, or the first agent the Space lists. */
  assistant(space: Space): Agent | undefined {
    const agents = space.catalogue?.agentInfo ?? [];
    const found = agents.find((a) => a.id === "space/assistant") ?? agents.find((a) => !a.peer) ?? agents[0];
    return found && this.preferredAgent(space, found);
  }

  // Polling: the current Space every 30 s (its catalogue every other time), the inbox of the others too.

  startPolling(): void {
    if (this.timer) return;
    this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, POLL_SECONDS, () => {
      this.ticks++;
      const current = this.current;
      // Each look leaves answers behind whose bytes live outside the JavaScript heap, where its
      // collector does not look: collect once the look is done rather than when the heap fills.
      if (current) void this.refresh(current, { catalogue: this.ticks % 2 === 0 }).finally(() => collectSoon());
      for (const conn of this.list.connections) {
        if (conn.id === current?.conn.id) continue;
        const s = this.space(conn.id)!;
        if (s.ready) void this.loadInbox(s);
        else if (this.ticks % 4 === 0) void this.refresh(s, { catalogue: false });
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  /** A first look at every saved Space, so notifications start from what is there now. */
  refreshAll(): void {
    for (const conn of this.list.connections) void this.refresh(this.space(conn.id)!);
  }
}
