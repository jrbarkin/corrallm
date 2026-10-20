import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { AdapterId, ConnectionId, UsageBackendId } from '../../shared/adapter';
import { canvasIdOf } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { OpResult } from '../../shared/api/errors';
import { OPS } from '../../shared/api/registry';
import type { ResultOf } from '../../shared/api/registry';
import { SURFACE } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import { engineCatalog } from '../../shared/engine/catalog';
import { MAX_CANVAS_BYTES } from '../../shared/ipc';
import type { SessionMode } from '../../shared/session';
import { CanvasFiles } from '../canvas';
import { LinkOpener } from '../links';
import { FileRevealer } from '../reveal';
import { ProjectFiles } from '../files';
import { CanvasMemory } from '../memory';
import { ProjectFolders } from '../project';
import { RunJournal } from '../run-journal';
import { ADAPTERS, CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import type { OptionsReader } from '../sessions/adapter';
import type { Connector } from '../sessions/connector';
import { createConnectors, createOptions } from '../sessions/connectors';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { SessionManager } from '../sessions/manager';
import { Settings } from '../settings';
import { UsageReadings } from '../usage';
import { committer } from './canvas/commit';
import { Documents } from './canvas/documents';
import { Channels } from './channels';
import { Windows } from './windows';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import type { Caller } from './caller';
import { MessageTable } from './delivery/messages';
import { Engines } from './engines';
import type { Watcher } from './engines';
import type { HostServices, WindowId } from './host';
import { implementations } from './ops';
import { holder, resolvers } from './reach';
import { changeChecks, ruleChecks } from './rules';
import { TokenStore } from './tokens';
import { Topics } from './topics';
import { UsageProbe } from './usage-probe';
import type { UsageRead } from './usage-probe';
import { Children } from './children';
import type { ChildSystem } from './children';
import { openStore } from './store/open';
import { unopened } from './store/store';
import type { StoreDeps } from './store/store';

/*
 * corrallm's core, composed: the registry's operations over the Electron-free services they act
 * on, kept in a profile folder (the app's user data, or `corrallm serve --profile`), and asking
 * whatever needs the desktop of its host. It runs each canvas it opens with an engine of its own
 * (engines.ts), whose agents' sessions its SessionManager runs in this process, and keeps the
 * outside tokens orchestrators call it with (tokens.ts). It is composed in the app's core process,
 * under `corrallm serve`, and in tests.
 */

export interface CoreConfig {
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
  /** Fake connectors and options for an unpackaged app's tests, admitted by its host. */
  fakeSessions?: boolean;
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
   * Stops: each canvas's run held where it is and journaled, every session closed, and what the
   * core keeps written out. Rejects, once all that is done, if a run couldn't be journaled.
   */
  close(): Promise<void>;
}

export async function createCore(config: CoreConfig, host: HostServices): Promise<Core> {
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
  const memory = new CanvasMemory(store);
  const documents = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
  const settings = new Settings(path.join(profile, 'settings.json'));
  const projects = new ProjectFolders({ host, memory });
  const journal = new RunJournal({
    store,
    memory,
    projectOf: (canvas) => projects.of(canvas),
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
    const read = ADAPTERS.find((adapter) =>
      adapter.usageBackends.some(({ id }) => id === backend),
    )?.readUsage;
    if (fake || read === undefined) return undefined;
    return () =>
      children.run(async () => read(backend, { env: await environment(), cwd: homedir() }));
  };
  const probe = new UsageProbe({
    usage,
    backends: CATALOG.usageBackends.map((backend) => backend.id),
    readerOf,
  });
  const conversations = ADAPTERS.find(
    (adapter) => adapter.conversations !== undefined,
  )?.conversations;
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
    ...(conversations === undefined ? {} : { conversations }),
    projectOf: (canvas) => projects.of(canvas),
    memory,
    sending: (canvas, agentId, message, send) => engines.sending(canvas, agentId, message, send),
    emit: (canvas, agentId, connection, event) => {
      void engines.emit(canvas, agentId, connection, event).then(
        () => {
          channels.emit(canvas, 'session:event', agentId, connection, event);
        },
        (error: unknown) => {
          console.error('Could not deliver a session event:', error);
        },
      );
    },
    terminal: (canvas, agentId, event) => {
      channels.emit(canvas, 'terminal', agentId, event);
    },
  });
  const windows = new Windows({
    restore: async () => {
      const canvas = await journal.last();
      await projects.restore(canvas);
      return canvas;
    },
    left: (canvas) => sessions.closeCanvas(canvas),
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
    folderOf: (canvas) => projects.of(canvas),
    show: async (file) => {
      await host.showFile(file);
    },
  });
  const channels = new Channels({
    processes: children,
    catalog: CATALOG,
    windows,
    canvases: new CanvasFiles({ host, memory, documents }),
    documents,
    runs: journal,
    shutdown: { ready: (window, request, error) => host.runReady(window, request, error) },
    projects,
    sessions,
    usage,
  });
  const topics = new Topics((name, args, caller, signal) =>
    dispatcher.call(name, args, caller, signal),
  );
  usage.subscribe((_state, by) => {
    topics.changed('usage', by);
  });
  settings.subscribe(() => {
    topics.changed('settings', 'you');
  });
  const stores = () =>
    Promise.all([
      memory.flush(),
      journal.flush(),
      settings.flush(),
      usage.flush(),
      tokens.flush(),
      links.flush(),
    ]);
  const engines: Engines = new Engines({
    processes: children,
    engineCatalog: engineCatalog(CATALOG, DEFAULT_ADAPTER),
    sessions,
    projects,
    journal,
    documents,
    messages: new MessageTable(store, memory),
    store,
    usage,
    files,
    environment,
    ...(config.locale === undefined ? {} : { locale: config.locale }),
  });
  const isLead = config.leads ?? (() => false);
  const dispatcher = createDispatcher(
    {
      surface: SURFACE,
      ops: OPS,
      implementations: implementations({
        topics,
        app: config.app,
        catalog: CATALOG,
        defaultAdapter: DEFAULT_ADAPTER,
        projects,
        files,
        settings,
        links,
        reveal,
        windows,
        sessions,
        environment,
        usage,
        engines,
        isLead,
        host,
        tokens,
        ...(config.locale === undefined ? {} : { locale: config.locale }),
      }),
      rules: ruleChecks(engines),
    },
    {
      check: config.check,
      isLead,
      resolvers: resolvers(engines, isLead),
      commit: committer({
        documents,
        rules: changeChecks(),
        committed: (canvas) => {
          engines.changed(canvas);
        },
      }),
      openCanvases: () => engines.opened(),
      holds: holder(engines),
      ...(config.limitsClock === undefined ? {} : { now: config.limitsClock }),
    },
  );
  // Held backends are read from now on, so a limit that ended while the core was down is noticed.
  probe.start();
  return {
    surface: dispatcher.surface,
    ops: dispatcher.ops,
    partyOf: (caller) => dispatcher.partyOf(caller),
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
    settings,
    keptCanvas: (file) => keptCanvas(file, memory),
    openHeld: async (canvas) => {
      await engines.open(canvas, { held: true });
      return engines.canvas(canvas)?.warnings ?? [];
    },
    deliver: () => engines.deliver(),
    watch: (watcher) => engines.watch(watcher),
    close: async () => {
      probe.stop();
      topics.close();
      try {
        await engines.close();
      } finally {
        // What the core keeps is written out even if a canvas's run couldn't be, and its database
        // closed last.
        try {
          await children.flush();
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
 * never from `file`.
 */
async function keptCanvas(file: string, memory: CanvasMemory): Promise<CanvasId> {
  const name = path.basename(file);
  let canvas: CanvasId;
  try {
    if ((await stat(file)).size > MAX_CANVAS_BYTES) throw new Error('it is too large');
    canvas = canvasIdOf(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${name} can’t be served: ${reasonOf(error)}`, { cause: error });
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
      `${name} is a copy of a canvas corrallm keeps at ${kept}: serve that file, or ${open} (it opens as a canvas of its own).`,
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
