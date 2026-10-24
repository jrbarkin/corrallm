import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { AdapterId, ConnectionId, UsageBackendId } from '../../shared/adapter';
import { canvasIdOf } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { OpResult } from '../../shared/api/errors';
import { MAX_CREATED_AGENTS } from '../../shared/api/limits';
import { OPS } from '../../shared/api/registry';
import { topicRequest } from '../../shared/api/topics';
import type { ResultOf } from '../../shared/api/registry';
import { SURFACE } from '../../shared/api/surface';
import type { OpName, Party, Reach } from '../../shared/api/surface';
import { engineCatalog } from '../../shared/engine/catalog';
import { needs } from '../../shared/engine/needs';
import type { NeedsItem } from '../../shared/model/needs';
import { agentName } from '../../shared/model/queries';
import { nodeKey } from '../../shared/model/rows';
import { MAX_CANVAS_BYTES } from '../../shared/ipc';
import type { SessionMode } from '../../shared/session';
import { CanvasFiles } from '../canvas';
import { LinkOpener } from '../links';
import { FileRevealer } from '../reveal';
import { ProjectFiles } from '../files';
import { CanvasMemory } from '../memory';
import { ProjectFolders } from '../project';
import { ProjectDirectories } from './workspaces/resolver';
import type { ProjectRootResolver } from './workspaces/resolver';
import type { SetupService } from './workspaces/setup';
import { treeOf, WorkspaceGate } from './workspaces/gate';
import { WorkspacePlanner } from './workspaces/planner';
import { WorkspaceStore } from './workspaces/store';
import type { TreeKey } from './workspaces/gate';
import { ownerNode } from './workspaces/planner';
import type { WorkspaceCleanup } from './workspaces/cleanup';
import { WorkspaceChanges } from './workspaces/rebind';
import type { WorktreeRecord } from './workspaces/store';
import { RunJournal } from '../run-journal';
import { ADAPTERS, CATALOG, DEFAULT_ADAPTER, isConversationId } from '../sessions/adapters';
import type { OptionsReader } from '../sessions/adapter';
import type { Connector } from '../sessions/connector';
import { createConnectors, createConversations, createOptions } from '../sessions/connectors';
import { locate, parseAgentPaths } from '../sessions/locate';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { ConversationClaims } from '../sessions/claims';
import { SessionManager } from '../sessions/manager';
import { Settings } from '../settings';
import { UsageReadings } from '../usage';
import { committer, refusalOf } from './canvas/commit';
import { Documents } from './canvas/documents';
import { Lifecycle } from './canvas/lifecycle';
import { Proposals } from './canvas/proposals';
import { FileReviews } from './canvas/reviews';
import { CanvasStates } from './canvas/states';
import { FileWatch } from './canvas/watch';
import type { WatchFolder } from './canvas/watch';
import { seesAll, viewOf } from './canvas/view';
import { Channels } from './channels';
import { Windows } from './windows';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import type { Caller, OutsideCaller } from './caller';
import { MessageTable } from './delivery/messages';
import { Engines, needsInput } from './engines';
import type { Watcher } from './engines';
import type { HostServices, WindowId } from './host';
import { implementations } from './ops';
import { PREPARED_OPS, preparedOps, preparedRules } from './ops/prepared';
import { PREPARED_SURFACE } from '../../shared/api/prepared';
import type { AgentId } from '../../shared/api/ids';
import { SessionControl } from './session-control';
import { runReplies } from './run-replies';
import { discardChecks } from './ops/files';
import { nameOf, quotedName } from './parties';
import { holder, resolvers } from './reach';
import { changeChecks, heldBy, ruleChecks } from './rules';
import { lockProfile } from './lock';
import { answerTokenRequest } from './token-requests';
import { privateTokenProfile } from './token-profile';
import type { TokenAnswer, TokenRequest } from './token-socket';
import { TokenStore } from './tokens';
import { RuntimeSource } from './runtime-topics';
import { Topics } from './topics';
import { UsageProbe } from './usage-probe';
import type { UsageRead } from './usage-probe';
import { Children } from './children';
import { StalledTurns } from './stalled';
import type { WatchdogClock, WatchdogNetwork } from './stalled';
import type { ChildSystem } from './children';
import { openStore, STORE_FILE } from './store/open';
import { unopened } from './store/store';
import type { Database, StoreDeps } from './store/store';

/*
 * corrallm's core, composed: the registry's operations over the Electron-free services they act
 * on, kept in a profile folder (the app's user data, or `corrallm serve --profile`), and asking
 * whatever needs the desktop of its host. It runs each canvas it opens with an engine of its own
 * (engines.ts), whose agents' sessions its SessionManager runs in this process, and keeps the
 * outside tokens orchestrators call it with (tokens.ts). It is composed in the app's core process,
 * under `corrallm serve`, and in tests.
 */

export interface CoreConfig {
  /** The silent-turn watchdog's wall clock and timers, injected independently of disk IO. */
  watchdog?: WatchdogClock;
  /** The silent-turn watchdog's local interface snapshot, injectable without real network changes. */
  watchdogNetwork?: WatchdogNetwork;
  /** For tests: process identity and group signalling instead of the OS. */
  children?: ChildSystem;
  /** For tests: the database's clock, timers and log flushes instead of the system's. */
  store?: StoreDeps;
  /** The profile folder, where the core keeps its stores. */
  profile: string;
  /** Which app this is, as app.info says. */
  app: { name: string; version: string };
  /**
   * Whether every call's arguments and result are checked to be plain data, and every result
   * against its schema: in dev and tests (CoreLink checks what crosses a port the same way).
   */
  check: boolean;
  /** How this build is offered: the CORRALLM_DISTRIBUTION its host was built with. */
  distribution: typeof CORRALLM_DISTRIBUTION;
  /** The locale what the core says tells times of day in (the host's): Node's own, when none. */
  locale?: string;
  /**
   * Which agents are leads now. None is until leads are kept on this machine (B24); tests say
   * which, to call as a lead.
   */
  leads?: (canvas: CanvasId, agent: string) => boolean;
  /**
   * The clock the limits per token read (Core Server §6.7): the real one, but in tests that make
   * many calls as one token at once.
   */
  limitsClock?: () => number;
  /**
   * The most live agents a token's party may have created (R11), read at each of its commits:
   * MAX_CREATED_AGENTS, but in tests that meet the cap without making that many.
   */
  maxCreatedAgents?: () => number;
  /** For tests: the id each proposal raised takes (its Needs item's is proposal/<it>). */
  proposalIds?: () => string;
  /** For tests: what watches the folders of the open canvases' files, instead of fs.watch. */
  watchFolder?: WatchFolder;
  /** Fake connectors and options for an unpackaged app's tests, admitted by its host. */
  fakeSessions?: boolean;
  /**
   * For the core's tests alone: B11 C6's prepared operations (shared/api/prepared.ts) registered
   * beside the live ones, until X9 registers them. No host sets it.
   */
  preparedOps?: boolean;
  /**
   * For tests: what runs agents' sessions instead of each connection's own connector
   * (sessions/fake.ts), the environment they run in instead of the login shell's, what reads a
   * held usage backend instead of its adapter's reader (none, for a backend left out), and what
   * reads what an agent of each adapter can be set to run with, and its user's own defaults,
   * instead of its CLI's settings (the adapters' fake options, for an adapter left out).
   */
  sessions?: {
    connectors: Readonly<Partial<Record<ConnectionId, Connector<SessionMode>>>>;
    environment: () => Promise<Readonly<Record<string, string>>>;
    readUsage?: Readonly<Partial<Record<UsageBackendId, UsageRead>>>;
    options?: Readonly<Partial<Record<AdapterId, OptionsReader>>>;
  };
  /**
   * For tests, until B9a X11b composes the workspaces: the worktrees' setup service, made over the
   * core's database, process owner and project folders, told when a canvas's setup cards change.
   * None: no setup card is ever raised, and setting a setup command is unavailable.
   */
  setups?: (core: {
    store: Database;
    processes: Children;
    directories: ProjectRootResolver;
    profile: string;
    changed: (canvas: CanvasId) => void;
  }) => SetupService;
  /**
   * For tests, until B9a X11b composes the workspaces: their cleanup (B9a C7), made over the
   * core's workspace records and process owner, told who may still write in a tree and whether its
   * setup runs, what to forget of its setup, and the names its trees' owners have. None: a tree no
   * agent works in any more is only ever retained, and a deletion asks nothing of it.
   */
  cleanup?: (core: {
    workspaces: WorkspaceStore;
    processes: Children;
    profile: string;
    writers: (tree: WorktreeRecord) => readonly string[];
    setupRunning: (workspace: string) => boolean;
    forgetSetup: (workspace: string) => Promise<void>;
    nameOf: (canvas: CanvasId, owner: string) => string | undefined;
    changed: (canvas: CanvasId) => void;
  }) => WorkspaceCleanup;
}

export interface Core extends Dispatcher {
  topics: Topics;
  call<N extends OpName>(
    name: N,
    raw: unknown,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<OpResult<ResultOf<N>>>;
  /** The canvases it runs, each with its engine. */
  engines: Engines;
  /** The app's hand-written channels, over these same services. */
  channels: Channels;
  shown(windows: WindowId[]): WindowId[];
  /** Finishes fallible writes after the renderer froze, keeping the core usable if saving fails. */
  flush(): Promise<void>;
  /** The outside tokens, kept in the profile's tokens.json. */
  tokens: TokenStore;
  /**
   * The outside orchestrator a token names, if it is one that hasn't expired: reaching the
   * canvases it was granted, and those its party made (canvas.create: document.created_by),
   * kept across renewals.
   */
  clientOf(token: string): OutsideCaller | undefined;
  /**
   * Answers what `corrallm token new|renew|revoke` asks over the token socket (Build Plan B30), as
   * `owner` (the app or `corrallm serve`), whose MCP server listens at `url` (null: none yet). A
   * new token reaches only canvases whose files `keptCanvas` accepts.
   */
  tokenRequest(
    request: TokenRequest,
    host: { owner: 'app' | 'serve'; url: string | null },
  ): Promise<TokenAnswer>;
  /** What the user chose for corrallm as a whole: the port its API server keeps, here. */
  settings: Pick<Settings, 'apiPort' | 'keepApiPort'>;
  /**
   * The canvas kept in `file`, as `corrallm serve --canvas` names it: only if canvas memory names
   * that file for the canvas it holds, and keeps a project folder for it that is still there, both
   * picked in the app. Rejects, naming the file and saying what to do in the app, for any other:
   * one corrallm doesn't keep, a copy of one it does, or one with no project folder.
   */
  keptCanvas(file: string): Promise<CanvasId>;
  /**
   * Opens a canvas held: nothing is delivered on it until `deliver()`. Rejects, saying why, if it
   * can't open. What opening it found to say (its run discarded, its messages unread, the database
   * restored).
   */
  openHeld(canvas: CanvasId): Promise<readonly string[]>;
  /** Starts delivering on every canvas opened held: what waits on each goes once it can. */
  deliver(): Promise<void>;
  /** Hears every canvas it runs: each message, and what newly waits for an answer. */
  watch(watcher: Watcher): () => void;
  /**
   * A window gained focus (main says so): the file of the canvas it shows, if it shows one, is
   * checked for a change on disk (B9 Design §5). Resolves once it is.
   */
  focused(window: WindowId): Promise<void>;
  /** The host woke from sleep: old turns get a short period of fresh silence before warning. */
  resumed(): void;
  /**
   * Stops: each canvas's run held where it is and journaled, every session closed, and what the
   * core keeps written out. Rejects, once all that is done, if a run couldn't be journaled.
   */
  close(): Promise<void>;
}

export async function createCore(config: CoreConfig, host: HostServices): Promise<Core> {
  parseAgentPaths(process.env.CORRALLM_AGENT_PATHS);
  const { profile } = config;
  // Before anything reads what it keeps. One that can't be opened fails every read and write of
  // what it keeps, saying why: the core journals nothing, and sends nothing whose record can't be
  // on disk first.
  const opened = await openStore(profile, config.store);
  if (opened.store === undefined) console.error(opened.said.join(' '));
  const store = opened.store ?? unopened(opened.said.join(' '));
  const children = new Children(profile, config.children);
  await children.recover();
  const usage = new UsageReadings({
    file: path.join(profile, 'usage.json'),
    backends: CATALOG.usageBackends.map((backend) => backend.id),
  });
  await usage.load();
  const tokens = new TokenStore(path.join(profile, 'tokens.json'));
  await tokens.load();
  // A canvas with edits not saved is never forgotten (B9 Design §2), nor one open.
  const memory: CanvasMemory = new CanvasMemory(
    store,
    undefined,
    (canvas: CanvasId): boolean => documents.unsaved(canvas),
    isConversationId,
  );
  // The reviews of canvas files changed on disk (B9 Design §5): what waits on a canvas is read
  // again as one is raised or settled.
  const reviews = new FileReviews({
    store,
    changed: (canvas, by) => {
      topics.changed(`needs:${canvas}`, by);
      engines.needsChanged(canvas);
    },
  });
  const workspaceStore = new WorkspaceStore({ store });
  /**
   * A tree's owner's name: as its canvas names its agent or group now, else as it last did (a
   * deleted agent's, from the canvas's kept changes): none once neither does.
   */
  const ownerName = (canvas: CanvasId, owner: string): string | undefined => {
    const nodes = documents.loaded(canvas)?.document.nodes;
    const id = ownerNode(owner);
    if (nodes?.some((node) => node.id === id) === true) return nameOf(nodes, id);
    try {
      const row = store
        .prepare(
          `SELECT before_data FROM change WHERE canvas_id = ? AND entity = ?
             AND before_data IS NOT NULL ORDER BY rev DESC LIMIT 1`,
        )
        .get(canvas, nodeKey(id));
      const before: unknown = row === undefined ? undefined : JSON.parse(String(row.before_data));
      const label = (before as { label?: unknown } | undefined)?.label;
      return typeof label === 'string' && label !== '' ? label : undefined;
    } catch {
      return undefined;
    }
  };
  // A tree no agent works in any more (B9a C7): removed with its last agent once safe, else kept
  // unless you discard it, its removal finished across restarts.
  const cleanup = config.cleanup?.({
    workspaces: workspaceStore,
    processes: children,
    profile,
    writers: (tree) => sessions.writingIn(tree.canvas, tree.id),
    setupRunning: (workspace) => setups?.running(workspace) === true,
    forgetSetup: (workspace) => setups?.forget(workspace) ?? Promise.resolve(),
    nameOf: (canvas, owner) => ownerName(canvas, owner),
    changed: (canvas) => {
      topics.changed(`needs:${canvas}`, 'corrallm');
      engines.needsChanged(canvas);
    },
  });
  // Who works where, at every document commit's seam (B9a C6): inert until a canvas's project is
  // a repository the core keeps (discovery and provisioning are composed with the resolver, X11b).
  const planner = new WorkspacePlanner({
    workspaces: workspaceStore,
    holding: (canvas, agent) => gate.holding(canvas, agent),
    ...(cleanup === undefined ? {} : { cleanup }),
  });
  const documents: Documents = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
    reviews,
    workspaces: planner,
    baselineChanged: (canvas) => {
      void states.refresh(canvas).catch((error: unknown) => {
        console.error('Could not publish the canvas’s saved baseline:', error);
      });
    },
  });
  const settings = new Settings(path.join(profile, 'settings.json'));
  // What the canvases the core runs publish beside their documents (B11 §5): their run, sessions
  // and messages, from their engines once they open.
  const runtime = new RuntimeSource({
    get engines() {
      return engines;
    },
    isLead: (canvas, agent) => isLead(canvas, agent),
    problem: (canvas) => journal.problem(canvas),
  });
  const projects = new ProjectFolders({ host, memory });
  const directories = new ProjectDirectories(projects);
  // The worktrees' setup (B9a C9, C10): its cards in Needs, yours alone, and their answers.
  const setups = config.setups?.({
    store,
    processes: children,
    directories,
    profile,
    changed: (canvas) => {
      topics.changed(`needs:${canvas}`, 'corrallm');
      engines.needsChanged(canvas);
    },
  });
  const journal = new RunJournal({
    store,
    memory,
    // Each canvas's one store of messages, the core's, which keeps a run's submissions.
    messages: (canvas) => engines.messagesOf(canvas),
    problemChanged: (canvas) => {
      topics.changed(`needs:${canvas}`, 'corrallm');
      engines.needsChanged(canvas);
      runtime.problemChanged(canvas);
    },
    // What it set aside or restored, said with the first canvas restored, as its runs' are.
    ...(opened.store === undefined ? {} : { said: opened.said }),
  });
  const fake = config.fakeSessions ?? false;
  let shell: Promise<Record<string, string>> | undefined;
  // Read once, when first needed.
  const environment =
    config.sessions?.environment ??
    (() =>
      (shell ??= fake
        ? Promise.resolve(agentEnvironment(process.env))
        : loginShellEnvironment().then(agentEnvironment)));
  // A held backend's usage, read by its adapter (as a CLI the core owns, in the home folder: the
  // limits are the account's, not a folder's); none for fake sessions.
  const readerOf = (backend: UsageBackendId): UsageRead | undefined => {
    if (config.sessions !== undefined) return config.sessions.readUsage?.[backend];
    const adapter = ADAPTERS.find((adapter) =>
      adapter.usageBackends.some(({ id }) => id === backend),
    );
    const read = adapter?.readUsage;
    if (fake || read === undefined || adapter === undefined) return undefined;
    return () =>
      children.run(async () => {
        const env = await environment();
        const executable = await locate(adapter, env);
        return executable === undefined
          ? undefined
          : read(backend, { env, cwd: homedir(), executable });
      });
  };
  const probe = new UsageProbe({
    usage,
    backends: CATALOG.usageBackends.map((backend) => backend.id),
    readerOf,
  });
  const conversations = createConversations();
  const sessions = new SessionManager({
    catalog: CATALOG,
    connectors:
      config.sessions?.connectors ??
      createConnectors({
        fake,
        clientApp: `${config.app.name}/${config.app.version}`,
        distribution: config.distribution,
        consent: (adapter, key) => settings.consent(adapter, key),
        usage: (backend, windows) => {
          usage.take(backend, windows);
        },
      }),
    environment,
    // Tests never read a real CLI's settings.
    options: {
      ...createOptions({ fake: fake || config.sessions !== undefined }),
      ...config.sessions?.options,
    },
    conversations,
    adapterOf: async (canvas, agentId) => {
      const node = (await documents.load(canvas)).document.nodes.find(
        (node) => node.id === agentId,
      );
      if (node?.type !== 'agent') throw new Error('That agent is not on this canvas.');
      return node.data.adapter ?? DEFAULT_ADAPTER;
    },
    directories,
    memory,
    // The process's one map of live claims on native conversations (B11 Design §7).
    claims: new ConversationClaims(),
    // A claim's holder named as a notice names an agent: quoted, escaped and capped.
    nameOf: (canvas, agent) =>
      quotedName(agentName(documents.loaded(canvas)?.document.nodes ?? [], agent)),
    sending: (canvas, agentId, message, send) => engines.sending(canvas, agentId, message, send),
    emit: (canvas, agentId, connection, event) => {
      stalled.event(canvas, agentId, connection, event);
      void engines.emit(canvas, agentId, connection, event).then(
        (taken) => {
          channels.emit(canvas, 'session:event', agentId, connection, taken);
        },
        (error: unknown) => {
          console.error('Could not deliver a session event:', error);
        },
      );
    },
    terminal: (canvas, agentId, event) => {
      channels.emit(canvas, 'terminal', agentId, event);
    },
    activity: (canvas, agent) => {
      stalled.activity(canvas, agent);
    },
    ended: (canvas, agent) => {
      stalled.ended(canvas, agent);
      engines.ended(canvas, agent);
    },
    // A restore of a tree holds new work for the other agents working in it until it is done.
    gate: {
      pass: (canvas, agent, own): Promise<void> => gate.pass(canvas, agent, own),
      holding: (canvas, agent): Promise<string | undefined> => gate.holding(canvas, agent),
    },
  });
  /** The trees an agent works in: its running session's, then its working directory's now. */
  const treesOf = async (canvas: CanvasId, agent: string): Promise<TreeKey[]> => {
    const running = sessions.binding(canvas, agent);
    const trees: TreeKey[] = running === undefined ? [] : [treeOf(running)];
    const directory = await directories.workingDirectory(canvas, agent as AgentId);
    if (directory.state === 'ready' && !trees.includes(treeOf(directory))) {
      trees.push(treeOf(directory));
    }
    return trees;
  };
  // The workspace mutation gate (B11 R5, B9a's shared-tree seam): every agent of a tree protected.
  const gate: WorkspaceGate = new WorkspaceGate({
    canvases: () => engines.opened(),
    agents: (canvas) =>
      (engines.canvas(canvas)?.document.nodes ?? []).flatMap((node) =>
        node.type === 'agent' ? [node.id] : [],
      ),
    session: (canvas, agent): TreeKey | undefined => {
      const running = sessions.binding(canvas, agent);
      return running === undefined ? undefined : treeOf(running);
    },
    trees: treesOf,
    writing: (canvas, agent) => {
      const open = engines.canvas(canvas);
      const session = open?.engine.sessions.of(agent);
      if (
        session?.status === 'working' ||
        session?.status === 'waiting' ||
        open?.delivery.current(agent) !== undefined
      ) {
        return 'has a turn going on';
      }
      if ((session?.tasks?.length ?? 0) > 0) return 'runs background tasks';
      if (sessions.closing(canvas, agent)) return 'hasn’t finished stopping its last session';
      return undefined;
    },
    nameOf: (canvas, agent) => nameOf(engines.canvas(canvas)?.document.nodes ?? [], agent),
  });
  // A workspace change waiting for you (B9a C7): its card, and its Switch.
  const changes = new WorkspaceChanges({
    workspaces: workspaceStore,
    gate,
    close: async (canvas, agent) => {
      const open = engines.canvas(canvas);
      if (open === undefined) await sessions.close(canvas, agent);
      else await open.engine.sessions.close(agent);
    },
    nameOf: (canvas, id) => {
      const nodes = documents.loaded(canvas)?.document.nodes ?? [];
      return nameOf(nodes, id);
    },
    messages: (canvas) => engines.messagesOf(canvas),
    messagesNow: (canvas) => engines.canvas(canvas)?.messages,
    changed: (canvas) => {
      topics.changed(`needs:${canvas}`, 'corrallm');
      engines.needsChanged(canvas);
    },
  });
  const windows = new Windows({
    restore: async () => {
      const canvas = await journal.last();
      await projects.restore(canvas);
      return canvas;
    },
    // A canvas the core runs runs on whatever window shows it, or none (decision 5); the app's,
    // whose run is its window's until B11's cutover, ends its sessions as the window leaves it.
    left: (canvas) => engines.left(canvas),
  });
  const files = new ProjectFiles({ environment });
  const links = new LinkOpener({
    file: path.join(profile, 'links.json'),
    ask: (window, site, url) => host.askOpenLink(window, site, url),
    openExternal: async (url) => {
      await host.openExternal(url);
    },
  });
  const reveal = new FileRevealer({
    // Reveal checks the picked project root's containment, not an agent's working directory.
    folderOf: (canvas) => directories.projectRoot(canvas),
    show: async (file) => {
      await host.showFile(file);
    },
  });
  const canvasFiles = new CanvasFiles({ host, memory, documents });
  const channels = new Channels({
    processes: children,
    catalog: CATALOG,
    windows,
    runs: journal,
    shutdown: { ready: (window, request, error) => host.runReady(window, request, error) },
    sessions,
  });
  const isLead = config.leads ?? (() => false);
  // What the core says of each canvas it keeps: its `canvas:<c>` topic, from each commit, and the
  // list of them, which changes as canvas memory, the journal and the windows do.
  const states = new CanvasStates({
    documents,
    memory,
    store,
    shownIn: (canvas) => windows.showing(canvas),
    running: () => engines.opened(),
    live: (canvas) => engines.canvas(canvas)?.engine.run.snapshot().running,
  });
  const topics = new Topics({
    read: (name, args, caller, signal) => dispatcher.call(name, args, caller, signal),
    // A canvas's entities as a subscriber sees them: as canvas.get gives them to it.
    view: (canvas, caller) => {
      const { rev, entities, document } = states.now(canvas);
      const party = dispatcher.partyOf(caller);
      const access = SURFACE['canvas.get'].access as Readonly<Partial<Record<Party, Reach>>>;
      const reach = party === 'you' ? 'all' : (access[party] ?? 'own');
      const lead = caller.kind === 'agent' && isLead(canvas, caller.agent);
      return {
        rev,
        entities: viewOf(document, entities, caller, reach, lead),
        all: seesAll(caller, reach),
      };
    },
    runtime: {
      source: runtime,
      // A runtime topic is read through its projection, under its reading op's audience and reach.
      project: (topic, caller, signal) => {
        const { topic: kind, ...args } = topicRequest(topic);
        return dispatcher.project(runtime.projections[kind], args, caller, signal);
      },
    },
  });
  states.listen({
    canvas: (canvas, change) => {
      topics.publish(canvas, change);
    },
    list: () => {
      topics.changed('canvases', 'corrallm');
    },
  });
  // Each commit to a canvas's document: its agents, how they run, who reaches what.
  documents.subscribe(({ canvas }) => {
    runtime.documentChanged(canvas);
  });
  memory.subscribe((canvas) => {
    follow();
    if (canvas === undefined) states.listChanged();
    else
      void states.refresh(canvas).catch((error: unknown) => {
        console.error('Could not say what changed of the canvas:', error);
      });
  });
  journal.subscribe((canvas) => {
    follow();
    states.runChanged(canvas);
  });
  windows.subscribe(() => {
    follow();
    states.listChanged();
  });
  usage.subscribe((_state, by) => {
    topics.changed('usage', by);
  });
  settings.subscribe(() => {
    topics.changed('settings', 'you');
  });
  // The proposals waiting for you (R4): their proposers' records go to each canvas's messages,
  // and what waits on a canvas is read again as one is raised or settled.
  const proposals = new Proposals({
    store,
    messages: (canvas) => engines.messagesOf(canvas),
    // The agents with a conversation kept, in any workspace and any adapter's CLI.
    conversations: async (canvas) => {
      const { conversations } = await memory.get(canvas);
      return new Set(
        Object.values(conversations).flatMap((byAdapter) =>
          Object.values(byAdapter).flatMap((byAgent) => Object.keys(byAgent)),
        ),
      );
    },
    changed: (canvas, by) => {
      topics.changed(`needs:${canvas}`, by);
      engines.needsChanged(canvas);
    },
    ...(config.proposalIds === undefined ? {} : { newId: config.proposalIds }),
  });
  /**
   * What waits for you on a canvas: its run's holds and sessions' prompts, the proposals, and the
   * review of its file changed on disk.
   */
  const waitingFor = (canvas: CanvasId, reach?: readonly string[]): NeedsItem[] => {
    const open = engines.canvas(canvas);
    return [
      ...(open ? needs(needsInput(open, config.locale)) : []),
      ...proposals.items(canvas, reach),
      ...reviews.items(canvas),
      ...stalled.items(canvas),
      ...journal.items(canvas),
      ...(setups?.items(canvas) ?? []),
      ...changes.items(canvas),
    ];
  };
  const needOf = (canvas: CanvasId, id: string, reach?: readonly string[]) =>
    waitingFor(canvas, reach).find((item) => item.id === id);
  const stores = () =>
    Promise.all([
      memory.flush(),
      journal.flush(),
      settings.flush(),
      usage.flush(),
      tokens.flush(),
      links.flush(),
    ]);
  // A canvas's lifetime: made, opened, saved, closed, its folder chosen (B9 Design §1).
  const lifecycle = new Lifecycle({
    documents,
    memory,
    journal,
    windows,
    projects,
    directories,
    sessions,
    engines: { closeCanvas: (canvas) => engines.closeCanvas(canvas) },
    files: canvasFiles,
    // The repository a new pick is isn't discovered yet (X11b composes discovery): none known.
    workspaces: { projectChosen: (canvas) => planner.projectChosen(canvas, undefined) },
  });
  const engines: Engines = new Engines({
    // The windows that own their canvases' runs until B11's cutover hear their retry decisions.
    windowRuns: {
      retry: (canvas, agent, connection, event) => {
        channels.emit(canvas, 'session:event', agent, connection, event);
      },
    },
    processes: children,
    engineCatalog: engineCatalog(CATALOG, DEFAULT_ADAPTER),
    sessions,
    projects,
    directories,
    journal,
    documents,
    messages: new MessageTable(store, memory),
    store,
    usage,
    files,
    environment,
    ...(config.locale === undefined ? {} : { locale: config.locale }),
    needs: (canvas) => [
      ...proposals.items(canvas),
      ...reviews.items(canvas),
      ...stalled.items(canvas),
      ...journal.items(canvas),
      ...(setups?.items(canvas) ?? []),
      ...changes.items(canvas),
    ],
  });
  const warnings = new Set<Promise<void>>();
  const stalled = new StalledTurns({
    catalog: CATALOG,
    ...(config.watchdog === undefined ? {} : { clock: config.watchdog }),
    ...(config.watchdogNetwork === undefined ? {} : { network: config.watchdogNetwork }),
    changed: (canvas) => {
      topics.changed(`needs:${canvas}`, 'corrallm');
      engines.needsChanged(canvas);
    },
    warning: (canvas, agent, connection, messages, text) => {
      // This is our own notice, not CLI activity. Never feed it back into the watchdog.
      const warning = Promise.all([
        engines
          .emit(canvas, agent, connection, {
            type: 'notice',
            id: crypto.randomUUID(),
            level: 'warning',
            text,
          })
          .then((event) => {
            channels.emit(canvas, 'session:event', agent, connection, event);
          }),
        engines.stalled(canvas, agent, messages, text),
      ])
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('Could not record a silent turn’s warning:', error);
        });
      warnings.add(warning);
      void warning.finally(() => {
        warnings.delete(warning);
      });
    },
  });
  // Whether the run of each canvas the core runs is running, as canvas.list says it from the live
  // run (B11 §5), not the journal's coalesced write: the list is read again as that changes.
  const live = new Map<CanvasId, { running: boolean; stop?: () => void }>();
  engines.watch({
    needs: (canvas) => {
      topics.changed(`needs:${canvas}`, 'corrallm');
    },
    opened: (canvas) => {
      follow();
      const run = engines.canvas(canvas)?.engine.run;
      if (run) {
        live.get(canvas)?.stop?.();
        const it: { running: boolean; stop?: () => void } = { running: run.snapshot().running };
        it.stop = run.subscribe(() => {
          const running = run.snapshot().running;
          if (running === it.running) return;
          it.running = running;
          states.listChanged();
        });
        live.set(canvas, it);
      }
      states.listChanged();
    },
    closed: (canvas) => {
      live.get(canvas)?.stop?.();
      live.delete(canvas);
      states.listChanged();
    },
  });
  /** The checks of canvas files going on: what closing waits for. */
  const checking = new Set<Promise<void>>();
  let closing = false;
  /** Checks a canvas's file for a change on disk (B9 Design §5): resolves once it is checked. */
  const check = (canvas: CanvasId): Promise<void> => {
    if (closing) return Promise.resolve();
    const checked = documents.review(canvas).then(
      () => undefined,
      (error: unknown) => {
        console.error('Could not check the canvas’s file for a change on disk:', error);
      },
    );
    checking.add(checked);
    void checked.then(() => checking.delete(checked));
    return checked;
  };
  // The files of the canvases open (open until closed, run, or shown in a window) are watched.
  const watching = new FileWatch({
    check: (canvas) => {
      void check(canvas);
    },
    ...(config.watchFolder === undefined ? {} : { watch: config.watchFolder }),
  });
  let following = false;
  /** Soon watches the files of the canvases open then, and no others. */
  function follow(): void {
    if (following || closing) return;
    following = true;
    queueMicrotask(() => {
      following = false;
      if (closing) return;
      try {
        const open = new Set<CanvasId>([
          ...store
            .prepare('SELECT canvas_id FROM open_canvas')
            .all()
            .map(({ canvas_id: id }) => String(id) as CanvasId),
          ...engines.opened(),
          ...windows.canvases(),
        ]);
        const files = new Map<CanvasId, string>();
        for (const canvas of open) {
          const file = memory.fileOf(canvas);
          if (file !== undefined) files.set(canvas, file);
        }
        watching.follow(files);
      } catch (error) {
        console.error('Could not watch the open canvases’ files for changes on disk:', error);
      }
    });
  }
  // B11 C6's session services: live and saved settings, Continue in Terminal, restart, new
  // conversation and rewind, with R5's proposal (registered by X9; tests: preparedOps).
  const control = new SessionControl({
    engines,
    sessions,
    gate,
    proposals,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
  const prepared = config.preparedOps === true;
  // Every change rule a token's commit is checked against (B9 Design §4).
  const changeRules = changeChecks({
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
    held: (canvas) => heldBy(engines.canvas(canvas)?.engine.run.snapshot()),
    created: (party, canvas, removing) => documents.created(party, canvas, removing),
    maxCreated: config.maxCreatedAgents ?? (() => MAX_CREATED_AGENTS),
  });
  const dispatcher = createDispatcher(
    {
      surface: prepared ? { ...SURFACE, ...PREPARED_SURFACE } : SURFACE,
      ops: prepared ? { ...OPS, ...PREPARED_OPS } : OPS,
      implementations: {
        ...(prepared
          ? preparedOps(control, {
              ...(cleanup === undefined ? {} : { cleanup }),
              proposals,
              nameOf: ownerName,
              workspaces: workspaceStore,
            })
          : {}),
        ...implementations({
          topics,
          app: config.app,
          catalog: CATALOG,
          defaultAdapter: DEFAULT_ADAPTER,
          directories,
          files,
          settings,
          links,
          reveal,
          windows,
          sessions,
          stalled,
          runProblems: (canvas) => journal.items(canvas),
          environment,
          usage,
          engines,
          states,
          lifecycle,
          documents,
          proposals,
          reviews,
          needOf,
          isLead,
          host,
          tokens,
          ...(config.locale === undefined ? {} : { locale: config.locale }),
          ...(setups === undefined ? {} : { setups }),
          workspaceReplies: [changes.handler()],
          workspaceItems: (canvas) => changes.items(canvas),
          // B11 C7: the reply router answers what the runtime asks once its typed reply is
          // registered (X9; the core's tests register it early).
          ...(prepared
            ? {
                replies: runReplies({
                  engines,
                  sessions,
                  ...(config.locale === undefined ? {} : { locale: config.locale }),
                }),
              }
            : {}),
        }),
      },
      rules: {
        ...(prepared ? preparedRules(control) : {}),
        ...ruleChecks(engines, needOf),
        discard: discardChecks({
          lifecycle,
          proposals,
          catalog: CATALOG,
          defaultAdapter: DEFAULT_ADAPTER,
          refusal: (document, call) =>
            refusalOf(document, call, changeRules, {
              catalog: CATALOG,
              defaultAdapter: DEFAULT_ADAPTER,
            }),
        }),
      },
    },
    {
      check: config.check,
      isLead,
      resolvers: resolvers(engines, isLead, needOf),
      commit: committer({
        documents,
        rules: changeRules,
        committed: (canvas) => {
          engines.changed(canvas);
        },
        // A token's change only you may make waits for you (R4), and so does a deletion of yours
        // leaving a worktree that holds work (B9a C7: its confirmation, through the same proposals).
        propose: (canvas, change, call, before, trees) =>
          proposals.raise(canvas, {
            op: call.op,
            args: call.args ?? {},
            by: call.by,
            change,
            before,
            ...(trees.length === 0 ? {} : { trees }),
          }),
      }),
      openCanvases: () => engines.opened(),
      holds: holder(engines),
      publication: topics,
      ...(config.limitsClock === undefined ? {} : { now: config.limitsClock }),
    },
  );
  // A setup that was running as the last core stopped is interrupted, after the process owner's
  // recovery ended what it left (above), and before any call could start one: never rerun by itself.
  await setups?.recover();
  runtime.start();
  // Removals the last core didn't finish, tried again (in the background: Git may take a while).
  void cleanup?.reconcile().catch((error: unknown) => {
    console.error('Could not finish removing the workspaces kept for removal:', error);
  });
  // Held backends are read from now on, so a limit that ended while the core was down is noticed.
  probe.start();
  // The canvases open from before, watched from now on.
  follow();
  return {
    surface: dispatcher.surface,
    ops: dispatcher.ops,
    partyOf: (caller) => dispatcher.partyOf(caller),
    project: (projection, raw, caller, signal) =>
      dispatcher.project(projection, raw, caller, signal),
    call: <N extends OpName>(name: N, raw: unknown, caller: Caller, signal?: AbortSignal) =>
      children.run(() => dispatcher.call(name, raw, caller, signal)) as Promise<
        OpResult<ResultOf<N>>
      >,
    engines,
    topics,
    channels,
    shown: (asked) => asked.filter((window) => windows.has(window)),
    flush: async () => {
      await engines.flush();
      await children.flush();
      await stores();
    },
    tokens,
    clientOf: (token) => {
      const caller = tokens.clientOf(token);
      if (caller === undefined) return undefined;
      const made = documents.createdBy(`outside:${caller.name}`);
      return { ...caller, canvases: [...new Set([...caller.canvases, ...made])] };
    },
    tokenRequest: (request, { owner, url }) =>
      answerTokenRequest(request, {
        owner,
        tokens,
        keptCanvas: (file) => keptCanvas(file, memory, 'reached'),
        fileOf: async (canvas) => (await memory.get(canvas)).file,
        url,
      }),
    settings,
    keptCanvas: (file) => keptCanvas(file, memory, 'served'),
    openHeld: async (canvas) => {
      await engines.open(canvas, { held: true });
      return engines.canvas(canvas)?.warnings ?? [];
    },
    deliver: () => engines.deliver(),
    watch: (watcher) => engines.watch(watcher),
    focused: async (window) => {
      const canvas = windows.shownIn(window);
      if (canvas !== undefined) await check(canvas);
    },
    resumed: () => {
      stalled.resume();
    },
    close: async () => {
      closing = true;
      projects.close();
      stalled.close();
      await Promise.all(warnings);
      watching.close();
      await Promise.all(checking);
      probe.stop();
      states.close();
      topics.close();
      runtime.close();
      try {
        await engines.close();
      } finally {
        // What the core keeps is written out even if a canvas's run couldn't be, and its database
        // closed last. No CLI it started outlives it: a helper still running is ended.
        try {
          // A workspace's removal going on finishes (or is left for the next start) first.
          await cleanup?.close().catch((error: unknown) => {
            console.error('Could not finish removing a workspace:', error);
          });
          // A setup still running is ended and marked interrupted before the process owner closes.
          await setups?.close().catch((error: unknown) => {
            console.error('Could not end the worktrees’ setups:', error);
          });
          await children.close();
          await stores();
        } finally {
          await opened.store?.close();
        }
      }
    },
  };
}

/**
 * The canvas `file` holds, if canvas memory names that very file for it (by its real path) and
 * keeps a project folder for it that is still there; else rejects, saying what to do in the app.
 * The file is only read for the id it holds: the canvas opens from the file canvas memory names,
 * never from `file`. `use` says what the file was named for: a canvas to serve (`serve --canvas`),
 * or one a token is to reach (`corrallm token new --canvas`).
 */
async function keptCanvas(
  file: string,
  memory: CanvasMemory,
  use: 'served' | 'reached',
): Promise<CanvasId> {
  const name = path.basename(file);
  let canvas: CanvasId;
  try {
    if ((await stat(file)).size > MAX_CANVAS_BYTES) throw new Error('it is too large');
    canvas = canvasIdOf(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${name} can’t be ${use}: ${reasonOf(error)}`, { cause: error });
  }
  const { file: kept, project } = await memory.get(canvas);
  const open = `open ${name} in corrallm and choose its project folder there`;
  if (kept === undefined) {
    throw new Error(`${name} isn’t a canvas corrallm keeps: ${open}, then save it.`);
  }
  const [asked, keeps] = await Promise.all([realpath(file), realpath(kept).catch(() => undefined)]);
  if (keeps === undefined) {
    throw new Error(
      `${name} holds a canvas corrallm keeps at ${kept}, which isn’t there any more: ${open}.`,
    );
  }
  if (asked !== keeps) {
    throw new Error(
      `${name} is a copy of a canvas corrallm keeps at ${kept}: ${use === 'served' ? 'serve' : 'name'} that file, or ${open} (it opens as a canvas of its own).`,
    );
  }
  if (project === undefined) {
    throw new Error(`${name} has no project folder: ${open}, so its agents can work.`);
  }
  const folder = await stat(project).catch(() => undefined);
  if (!folder?.isDirectory()) {
    throw new Error(
      `${name} has a project folder corrallm keeps at ${project}, which isn’t there any more: ${open}.`,
    );
  }
  return canvas;
}

/**
 * Answers what `corrallm token` asks (Build Plan B30) of a profile no corrallm owns: under
 * core.lock, taken for the moment as `token` and let go once its stores are written, over the
 * profile's own stores, as `corrallm serve --new-token` writes them; only a new token, which names
 * canvases by their files, opens the database, to read canvas memory. Its URL is where the
 * profile's server will listen (the port it keeps), if it keeps one. Rejects with ProfileLocked
 * while another process holds the profile. A profile that isn't there is never made.
 */
export async function answerUnowned(profile: string, request: TokenRequest): Promise<TokenAnswer> {
  const folder = await stat(profile).catch(() => undefined);
  if (!folder?.isDirectory()) {
    return {
      ok: false,
      sentence: `No corrallm profile is at ${profile}: open the canvas in the app first, or name the profile with --profile.`,
    };
  }
  profile = await privateTokenProfile(profile);
  const lock = await lockProfile(profile, 'token');
  // Whatever happens, a process that ends lets the profile go.
  const release = () => {
    lock.release();
  };
  process.once('exit', release);
  try {
    const tokens = new TokenStore(path.join(profile, 'tokens.json'));
    await tokens.load();
    const port = await new Settings(path.join(profile, 'settings.json')).apiPort();
    const url = port === undefined ? null : `http://127.0.0.1:${String(port)}/mcp`;
    let store: Awaited<ReturnType<typeof openStore>>['store'];
    try {
      let memory: CanvasMemory | undefined;
      if (request.op === 'new') {
        // A profile with no database keeps no canvas, and gets none from a token.
        if (!existsSync(path.join(profile, STORE_FILE))) {
          return {
            ok: false,
            sentence: `The profile ${profile} keeps no canvas yet: open the canvas in corrallm and choose its project folder there.`,
          };
        }
        const opened = await openStore(profile);
        store = opened.store;
        if (store === undefined) return { ok: false, sentence: opened.said.join(' ') };
        memory = new CanvasMemory(store, undefined, () => false, isConversationId);
      }
      const answer = await answerTokenRequest(request, {
        owner: 'none',
        tokens,
        keptCanvas: (file) =>
          memory === undefined
            ? Promise.reject(new Error('No canvas memory.'))
            : keptCanvas(file, memory, 'reached'),
        fileOf: async (canvas) => (await memory?.get(canvas))?.file,
        url,
      });
      await tokens.flush();
      return answer;
    } finally {
      await store?.close();
    }
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
