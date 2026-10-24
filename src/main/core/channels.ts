import type { Children } from './children';
import type { GuiEvent, GuiEventArgs } from '../../shared/gui-link';
import type { CanvasId } from '../../shared/canvas';
import type { Catalog } from '../../shared/adapter';
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import { parseRunCheckpoint } from '../../shared/run';
import type { RunJournal } from '../run-journal';
import type { Windows } from './windows';
import type { HostServices, WindowId } from './host';
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

/** Turns the raw, untrusted arguments into the channel's contract tuple, or throws. */
export type ArgsParser<C extends CoreChannel> = (args: unknown[]) => IpcArgs<C>;
/** The window whose port the call came over: the canvas it shows is the one a channel acts on. */
export interface ChannelCaller {
  window: WindowId;
}
export type ChannelHandler<C extends CoreChannel> = (
  caller: ChannelCaller,
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>;

/**
 * What the handlers act on: the catalog, which canvas each window shows, runs and sessions.
 * A handler looks up the window's canvas before calling its service.
 */
export interface ChannelServices {
  processes?: Pick<Children, 'run'>;
  /** What every adapter declares (sessions/adapters.ts): what the channels' arguments name. */
  catalog: Catalog;
  windows: Pick<Windows, 'canvasOf' | 'showing' | 'gone'>;
  runs: Pick<RunJournal, 'get' | 'check' | 'save'>;
  shutdown: { ready: HostServices['runReady'] };
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
  >;
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

function createHandlers({
  catalog,
  windows,
  runs,
  shutdown,
  sessions,
}: ChannelServices): HandlerTable {
  /** The canvas the sender's window shows: what every canvas's channel acts on. */
  const of = (window: WindowId) => windows.canvasOf(window);
  return {
    'run:get': {
      parseArgs: noArgs,
      handler: async ({ window }) => {
        const canvas = await of(window);
        const { id, token, checkpoint, warning, saveError } = await runs.get(canvas);
        return {
          id,
          token,
          checkpoint,
          ...(saveError === undefined ? {} : { saveError }),
          notices: [warning, saveError].filter((one) => one !== undefined),
        };
      },
    },
    'run:save': {
      parseArgs: (args) => {
        const [token, checkpoint] = args;
        if (args.length !== 2 || typeof token !== 'string' || token.length > 100) {
          throw new TypeError('Expected a canvas token and a run checkpoint');
        }
        return [token, checkpoint === null ? null : parseRunCheckpoint(checkpoint, true)];
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
    // A list is the asking window's: only it may then open what it was listed (B11 Design §7).
    'session:list': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agentId) =>
        sessions.listSessions(await of(window), agentId, `window:${String(window)}`),
    },
    'session:resume': {
      parseArgs: parseResumeArgs,
      handler: async ({ window }, agentId, sessionId) => {
        await sessions.resumeSession(
          await of(window),
          agentId,
          sessionId,
          `window:${String(window)}`,
        );
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
