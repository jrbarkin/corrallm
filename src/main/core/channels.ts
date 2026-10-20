import { OpFailure } from './call';
import type { OpResult } from '../../shared/api/errors';
import type { Children } from './children';
import type { GuiEvent, GuiEventArgs } from '../../shared/gui-link';
import type { CanvasId } from '../../shared/canvas';
import type { Catalog } from '../../shared/adapter';
import { MAX_CANVAS_BYTES } from '../../shared/ipc';
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import { parseRunCheckpoint } from '../../shared/run';
import type { RunJournal } from '../run-journal';
import { parseBackend, parseRule, parseWindows } from '../../shared/usage';
import type { CanvasFiles } from '../canvas';
import type { Documents } from './canvas/documents';
import type { Windows } from './windows';
import type { HostServices, WindowId } from './host';
import type { ProjectFolders } from '../project';
import {
  parseAgentArgs,
  parseAnswerArgs,
  parseEffortArgs,
  parseFreshArgs,
  parseMcpChangeArgs,
  parseModeArgs,
  parseModelArgs,
  parseOptionsArgs,
  parseResumeArgs,
  parseRewindArgs,
  parseRewindPreviewArgs,
  parseSendArgs,
  parseStartArgs,
  parseStopTaskArgs,
} from '../sessions/args';
import type { SessionManager } from '../sessions/manager';
import type { UsageReadings } from '../usage';

/** Turns the raw, untrusted arguments into the channel's contract tuple, or throws. */
export type ArgsParser<C extends CoreChannel> = (args: unknown[]) => IpcArgs<C>;
/** The window whose port the call came over, also the parent for its dialogs. */
export interface ChannelCaller {
  window: WindowId;
}
export type ChannelHandler<C extends CoreChannel> = (
  caller: ChannelCaller,
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>;

/**
 * What the handlers act on: the catalog, which canvas each window shows, canvas files and
 * documents, runs, project folders, sessions, the agents the user has, and usage. A handler looks
 * up the window's canvas before calling its service.
 */
export interface ChannelServices {
  processes?: Pick<Children, 'run'>;
  /** What every adapter declares (sessions/adapters.ts): what the channels' arguments name. */
  catalog: Catalog;
  windows: Pick<Windows, 'canvasOf' | 'show' | 'showing' | 'shownIn' | 'gone'>;
  canvases: Pick<CanvasFiles, 'open' | 'save'>;
  /** Each canvas's document: the renderer's edits commit to it until they are operations. */
  documents: Pick<Documents, 'edit' | 'textOf'>;
  runs: Pick<RunJournal, 'get' | 'check' | 'save' | 'opened' | 'saved' | 'draft' | 'close'>;
  shutdown: { ready: HostServices['runReady'] };
  projects: Pick<ProjectFolders, 'choose' | 'restore' | 'of'>;
  sessions: Pick<
    SessionManager,
    | 'start'
    | 'send'
    | 'answer'
    | 'interrupt'
    | 'setMode'
    | 'setModel'
    | 'setEffort'
    | 'stopTask'
    | 'close'
    | 'fresh'
    | 'listSessions'
    | 'resumeSession'
    | 'mcpServers'
    | 'changeMcpServer'
    | 'settingsOptions'
    | 'previewRewind'
    | 'rewind'
    | 'projectChanged'
  >;
  usage: Pick<UsageReadings, 'state' | 'setRule' | 'simulate'>;
}

/** `ArgsParser` for channels that take no arguments. */
export function noArgs(args: unknown[]): [] {
  if (args.length !== 0) throw new TypeError('Expected no arguments');
  return [];
}

/**
 * One entry per channel in the contract. The mapped type makes a missing channel a compile
 * error, and ties each channel's parser and handler to its contract types.
 */
type HandlerTable = {
  [C in CoreChannel]: { parseArgs: ArgsParser<C>; handler: ChannelHandler<C> };
};

/** `ArgsParser` for canvas:save: the bounded canvas text, `choose` and its mirror revision. */
export function parseSaveArgs(args: unknown[]): IpcArgs<'canvas:save'> {
  const [text, choose, rev] = args;
  if (
    args.length !== 3 ||
    typeof text !== 'string' ||
    typeof choose !== 'boolean' ||
    !revision(rev)
  ) {
    throw new TypeError(
      'Expected the canvas text, whether to choose a file and its mirror revision',
    );
  }
  return [canvasText(text), choose, rev];
}

/** A canvas's text as the renderer sends it, within the size limit. */
function canvasText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') > MAX_CANVAS_BYTES) {
    throw new RangeError('The canvas is too large to save');
  }
  return text;
}

/** A whole-document edit names the mirror revision it was built from. */
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Structured op failures survive the channel's port, including conflict.current. */
async function edited<T>(task: () => Promise<T>): Promise<OpResult<T>> {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    if (!(error instanceof OpFailure)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        sentence: error.message,
        ...(error.current === undefined ? {} : { current: error.current }),
      },
    };
  }
}

/** The usage backends the catalog lists: those whose usage corrallm reads. */
const backendsOf = (catalog: Catalog) => catalog.usageBackends.map((backend) => backend.id);

/** `ArgsParser` for usage:rule: a backend the catalog lists, and a rule or null. */
export function parseUsageRuleArgs(args: unknown[], catalog: Catalog): IpcArgs<'usage:rule'> {
  const [backend, rule] = args;
  if (args.length !== 2) throw new TypeError('Expected a backend and a rule (or null)');
  return [parseBackend(backend, backendsOf(catalog)), rule === null ? null : parseRule(rule)];
}

/** `ArgsParser` for usage:simulate: a backend, and its windows (checked as a reading's) or null. */
export function parseSimulateArgs(args: unknown[], catalog: Catalog): IpcArgs<'usage:simulate'> {
  const [backend, windows] = args;
  if (args.length !== 2) throw new TypeError('Expected a backend and its windows (or null)');
  return [
    parseBackend(backend, backendsOf(catalog)),
    windows === null ? null : parseWindows(windows, Date.now()),
  ];
}

function createHandlers({
  catalog,
  windows,
  canvases,
  documents,
  runs,
  shutdown,
  projects,
  sessions,
  usage,
}: ChannelServices): HandlerTable {
  /** The canvas the sender's window shows: what every canvas's channel acts on. */
  const of = (window: WindowId) => windows.canvasOf(window);
  /**
   * The window shows `canvas` now, in place of the one it showed (New, Open): that one is closed
   * once no window shows it (B9 Design §2), as `canvas.create` and `canvas.open` replace it.
   */
  const replace = async (window: WindowId, canvas: CanvasId) => {
    const before = windows.shownIn(window);
    await windows.show(window, canvas);
    if (before !== undefined && before !== canvas && windows.showing(before).length === 0) {
      await runs.close(before);
    }
  };
  return {
    'run:get': {
      parseArgs: noArgs,
      handler: async ({ window }) => {
        const canvas = await of(window);
        const { id, token, checkpoint, warning } = await runs.get(canvas);
        return { id, token, checkpoint, notices: warning === undefined ? [] : [warning] };
      },
    },
    'run:save': {
      parseArgs: (args) => {
        const [token, checkpoint] = args;
        if (args.length !== 2 || typeof token !== 'string' || token.length > 100) {
          throw new TypeError('Expected a canvas token and a run checkpoint');
        }
        return [token, checkpoint === null ? null : parseRunCheckpoint(checkpoint)];
      },
      handler: async ({ window }, token, checkpoint) => {
        const canvas = await of(window);
        runs.check(canvas, token);
        await runs.save(canvas, token, checkpoint);
        return null;
      },
    },
    'run:ready': {
      parseArgs: (args) => {
        const [id, error] = args;
        if (
          args.length !== 2 ||
          typeof id !== 'string' ||
          id.length > 100 ||
          !(error === null || (typeof error === 'string' && error.length <= 4096))
        ) {
          throw new TypeError('Expected a shutdown request and error (or null)');
        }
        return [id, error];
      },
      handler: async ({ window }, id, error) => {
        await shutdown.ready(window, id, error);
        return null;
      },
    },
    'canvas:open': {
      parseArgs: noArgs,
      handler: async ({ window }) => {
        // It works even when the canvas before could not be restored.
        const opened = await canvases.open(window);
        if (opened === null) return null;
        const { id, name, copy } = opened;
        await runs.opened(id, copy);
        // Another canvas: the old one's sessions end, and the new one's folder comes back.
        await replace(window, id);
        const project = await projects.restore(id);
        const text = (await documents.textOf(id)) ?? '';
        return { id, name, text, ...(project ? { project } : {}) };
      },
    },
    'canvas:save': {
      parseArgs: parseSaveArgs,
      handler: ({ window }, text, choose, expected) =>
        edited(async () => {
          const canvas = await of(window);
          // As the renderer has it, then as the core saves it.
          const rev = await documents.edit(canvas, text, expected);
          const name = await canvases.save(window, canvas, choose);
          if (name !== null) await runs.saved(canvas);
          return { name, rev };
        }),
    },
    'canvas:forget': {
      parseArgs: noArgs,
      handler: async ({ window }) => {
        // New keeps the canvas before as it was, even one that could not be restored.
        const draft = await runs.draft();
        await replace(window, draft);
        return draft;
      },
    },
    'project:choose': {
      parseArgs: noArgs,
      handler: async ({ window }) => {
        const canvas = await of(window);
        const before = projects.of(canvas);
        const chosen = await projects.choose(window, canvas);
        if (chosen !== null && chosen.path !== before) await sessions.projectChanged(canvas);
        return chosen;
      },
    },
    'session:start': {
      parseArgs: (args) => parseStartArgs(args, catalog),
      handler: async ({ window }, agentId, options) => {
        await sessions.start(await of(window), agentId, options);
        return null;
      },
    },
    'session:send': {
      parseArgs: parseSendArgs,
      handler: async ({ window }, agentId, message) => {
        await sessions.send(await of(window), agentId, message);
        return null;
      },
    },
    'session:answer': {
      parseArgs: parseAnswerArgs,
      handler: async ({ window }, agentId, promptId, answer) => {
        await sessions.answer(await of(window), agentId, promptId, answer);
        return null;
      },
    },
    'session:interrupt': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agentId) => {
        await sessions.interrupt(await of(window), agentId);
        return null;
      },
    },
    'session:mode': {
      parseArgs: parseModeArgs,
      handler: async ({ window }, agentId, mode) => {
        await sessions.setMode(await of(window), agentId, mode);
        return null;
      },
    },
    'session:model': {
      parseArgs: parseModelArgs,
      handler: async ({ window }, agentId, model) => {
        await sessions.setModel(await of(window), agentId, model);
        return null;
      },
    },
    'session:effort': {
      parseArgs: parseEffortArgs,
      handler: async ({ window }, agentId, effort) => {
        await sessions.setEffort(await of(window), agentId, effort);
        return null;
      },
    },
    'session:stopTask': {
      parseArgs: parseStopTaskArgs,
      handler: async ({ window }, agentId, taskId) => {
        await sessions.stopTask(await of(window), agentId, taskId);
        return null;
      },
    },
    'session:close': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agentId) => {
        await sessions.close(await of(window), agentId);
        return null;
      },
    },
    'session:fresh': {
      parseArgs: (args) => parseFreshArgs(args, catalog),
      handler: async ({ window }, agentId, adapter) => {
        await sessions.fresh(await of(window), agentId, adapter);
        return null;
      },
    },
    'session:list': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agentId) => sessions.listSessions(await of(window), agentId),
    },
    'session:resume': {
      parseArgs: parseResumeArgs,
      handler: async ({ window }, agentId, sessionId) => {
        await sessions.resumeSession(await of(window), agentId, sessionId);
        return null;
      },
    },
    'session:rewind-preview': {
      parseArgs: parseRewindPreviewArgs,
      handler: async ({ window }, agentId, messageId) =>
        sessions.previewRewind(await of(window), agentId, messageId),
    },
    'session:rewind': {
      parseArgs: parseRewindArgs,
      handler: async ({ window }, agentId, messageId, restore) =>
        sessions.rewind(await of(window), agentId, messageId, restore),
    },
    'session:options': {
      parseArgs: (args) => parseOptionsArgs(args, catalog),
      handler: async ({ window }, adapter) => sessions.settingsOptions(await of(window), adapter),
    },
    'session:mcp': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agentId) => sessions.mcpServers(await of(window), agentId),
    },
    'session:mcp-change': {
      parseArgs: parseMcpChangeArgs,
      handler: async ({ window }, agentId, server, change) =>
        sessions.changeMcpServer(await of(window), agentId, server, change),
    },
    'usage:get': { parseArgs: noArgs, handler: () => usage.state() },
    'usage:rule': {
      parseArgs: (args) => parseUsageRuleArgs(args, catalog),
      handler: (_caller, backend, rule) => {
        usage.setRule(backend, rule);
        return null;
      },
    },
    'usage:simulate': {
      parseArgs: (args) => parseSimulateArgs(args, catalog),
      handler: (_caller, backend, windows) => {
        usage.simulate(backend, windows);
        return null;
      },
    },
  };
}

/** An event for one window, with no transport details. */
export type EventListener = (name: GuiEvent, args: GuiEventArgs<GuiEvent>) => void;

/** The hand-written channels, with their parsers, over the core's own services. */
export class Channels {
  readonly #handlers: HandlerTable;
  readonly #services: ChannelServices;
  readonly #listeners = new Map<WindowId, Set<EventListener>>();

  constructor(services: ChannelServices) {
    this.#services = services;
    this.#handlers = createHandlers(services);
  }

  call(window: WindowId, name: string, args: unknown[]): unknown {
    if (!Object.hasOwn(this.#handlers, name)) {
      throw new Error(`corrallm’s window has no channel named ${name}.`);
    }
    if (!Array.isArray(args)) throw new TypeError('Expected channel arguments');
    const processes = this.#services.processes;
    return processes
      ? processes.run(() => this.#call(window, name as CoreChannel, args))
      : this.#call(window, name as CoreChannel, args);
  }

  #call<C extends CoreChannel>(
    window: WindowId,
    name: C,
    args: unknown[],
  ): IpcResult<C> | Promise<IpcResult<C>> {
    const { parseArgs, handler } = this.#handlers[name];
    return handler({ window }, ...parseArgs(args));
  }

  /** Hears events for this window, until its port goes. */
  listen(window: WindowId, listener: EventListener): () => void {
    let listeners = this.#listeners.get(window);
    if (!listeners) this.#listeners.set(window, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(window);
    };
  }

  /** A canvas's sessions speak only to its windows; usage speaks to every window. */
  emit<E extends GuiEvent>(canvas: CanvasId | null, name: E, ...args: GuiEventArgs<E>): void {
    const windows =
      canvas === null ? this.#listeners.keys() : this.#services.windows.showing(canvas);
    for (const window of windows) {
      for (const listener of this.#listeners.get(window) ?? []) listener(name, args);
    }
  }

  /** A closed, crashed or reloaded page leaves its sessions; a closed window is forgotten. */
  gone(window: WindowId, closed = false): void {
    void this.#services.windows.gone(window, closed).catch((error: unknown) => {
      console.error('Could not close the canvas’s sessions:', error);
    });
  }
}
