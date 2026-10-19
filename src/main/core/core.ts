import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ConnectionId } from '../../shared/adapter';
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
import { installedClis } from '../sessions/installed';
import { Conversations } from '../sessions/sdk/conversations';
import { ProjectFiles } from '../files';
import { CanvasMemory } from '../memory';
import { ProjectFolders } from '../project';
import { RunJournal } from '../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import type { Connector } from '../sessions/connector';
import { createConnectors, createOptions } from '../sessions/connectors';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { SessionManager } from '../sessions/manager';
import { Settings } from '../settings';
import { UsageReadings } from '../usage';
import { Channels } from './channels';
import { Windows } from './windows';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import type { Caller } from './caller';
import { Engines } from './engines';
import type { Watcher } from './engines';
import type { HostServices, WindowId } from './host';
import { implementations } from './ops';
import { holder, resolvers } from './reach';
import { ruleChecks } from './rules';
import { TokenStore } from './tokens';
import { Topics } from './topics';

/*
 * corrallm's core, composed: the registry's operations over the Electron-free services they act
 * on, kept in a profile folder (the app's user data, or `corrallm serve --profile`), and asking
 * whatever needs the desktop of its host. It runs each canvas it opens with an engine of its own
 * (engines.ts), whose agents' sessions its SessionManager runs in this process, and keeps the
 * outside tokens orchestrators call it with (tokens.ts). It is composed in the app's core process,
 * under `corrallm serve`, and in tests.
 */

export interface CoreConfig {
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
   * (sessions/fake.ts), and the environment they run in instead of the login shell's.
   */
  sessions?: {
    connectors: Readonly<Partial<Record<ConnectionId, Connector<SessionMode>>>>;
    environment: () => Promise<Readonly<Record<string, string>>>;
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
  /** Ends the sessions and finishes writes after the renderer froze and saved. */
  flush(): Promise<void>;
  /** The outside tokens, kept in the profile's tokens.json. */
  tokens: TokenStore;
  /** What the user chose for corrallm as a whole: the port its API server keeps, here. */
  settings: Pick<Settings, 'apiPort' | 'keepApiPort'>;
  /**
   * The canvas kept in `file`, as `corrallm serve --canvas` names it: only if canvases.json names
   * that file for the canvas it holds, and keeps a project folder for it that is still there, both
   * picked in the app. Rejects, naming the file and saying what to do in the app, for any other:
   * one corrallm doesn't keep, a copy of one it does, or one with no project folder.
   */
  keptCanvas(file: string): Promise<CanvasId>;
  /**
   * Opens a canvas held: nothing is delivered on it until `deliver()`. Rejects, saying why, if it
   * can't open. What opening it found to say (its run record set aside).
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
  const usage = new UsageReadings({
    file: path.join(profile, 'usage.json'),
    backends: CATALOG.usageBackends.map((backend) => backend.id),
  });
  await usage.load();
  const tokens = new TokenStore(path.join(profile, 'tokens.json'));
  await tokens.load();
  const memory = new CanvasMemory(path.join(profile, 'canvases.json'));
  const settings = new Settings(path.join(profile, 'settings.json'));
  const projects = new ProjectFolders({ host, memory });
  const journal = new RunJournal(path.join(profile, 'runs'), {
    memory,
    projectOf: (canvas) => projects.of(canvas),
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
    options: createOptions({ fake }),
    conversations: new Conversations(),
    projectOf: (canvas) => projects.of(canvas),
    memory,
    sending: (canvas, agentId, message, send) => engines.sending(canvas, agentId, message, send),
    emit: (canvas, agentId, connection, event) => {
      engines.emit(canvas, agentId, connection, event);
      channels.emit(canvas, 'session:event', agentId, connection, event);
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
    catalog: CATALOG,
    windows,
    canvases: new CanvasFiles({ host, memory }),
    runs: journal,
    shutdown: { ready: (window, request, error) => host.runReady(window, request, error) },
    projects,
    files,
    sessions,
    clis: { installed: async () => installedClis(await environment()) },
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
    Promise.all([memory.flush(), settings.flush(), usage.flush(), tokens.flush(), links.flush()]);
  const engines: Engines = new Engines({
    catalog: CATALOG,
    engineCatalog: engineCatalog(CATALOG, DEFAULT_ADAPTER),
    sessions,
    projects,
    journal,
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
      openCanvases: () => engines.opened(),
      holds: holder(engines),
      ...(config.limitsClock === undefined ? {} : { now: config.limitsClock }),
    },
  );
  return {
    surface: dispatcher.surface,
    ops: dispatcher.ops,
    partyOf: (caller) => dispatcher.partyOf(caller),
    call: <N extends OpName>(name: N, raw: unknown, caller: Caller, signal?: AbortSignal) =>
      dispatcher.call(name, raw, caller, signal) as Promise<OpResult<ResultOf<N>>>,
    engines,
    topics,
    channels,
    shown: (asked) => asked.filter((window) => windows.has(window)),
    flush: async () => {
      await journal.flush();
      await sessions.closeEverything();
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
      topics.close();
      try {
        await engines.close();
      } finally {
        // What the core keeps is written out even if a canvas's run couldn't be.
        await stores();
      }
    },
  };
}

/**
 * The canvas `file` holds, if canvases.json names that very file for it (by its real path) and
 * keeps a project folder for it that is still there; else rejects, saying what to do in the app.
 * The file is only read for the id it holds: the canvas opens from the file canvases.json names,
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
