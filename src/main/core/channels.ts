import { MessageId } from '../../shared/api/ids';
import type { Children } from './children';
import type { GuiEvent, GuiEventArgs } from '../../shared/gui-link';
import type { CanvasId } from '../../shared/canvas';
import type { Catalog } from '../../shared/adapter';
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import type { Engines } from './engines';
import type { Windows } from './windows';
import type { WindowId } from './host';
import {
  parseAgentArgs,
  parseAnswerArgs,
  parseEffortArgs,
  parseMcpChangeArgs,
  parseModeArgs,
  parseModelArgs,
  parseOptionsArgs,
  parseResumeArgs,
  parseSendArgs,
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
 * What the handlers act on: the catalog, which canvas each window shows, the canvases the core runs
 * and their sessions. A handler looks up the window's canvas before calling its service.
 */
export interface ChannelServices {
  processes?: Pick<Children, 'run'>;
  /** What every adapter declares (sessions/adapters.ts): what the channels' arguments name. */
  catalog: Catalog;
  windows: Pick<Windows, 'canvasOf' | 'showing' | 'gone'>;
  /**
   * The canvases the core runs, every one a window shows (B11 Design §8): what a window's session
   * channel changes of a session there, the core's own session hears too, so the core's runtime
   * stays its one owner until B11 X13 moves the agent window onto the session topic and operations.
   */
  engines: Pick<Engines, 'canvas'>;
  /** C11's existing write barrier also applies to X13's transitional manual-message bridge. */
  admitManual?: () => void;
  sessions: Pick<
    SessionManager,
<<<<<<< HEAD
=======
    | 'availability'
    | 'start'
>>>>>>> origin/main
    | 'send'
    | 'answer'
    | 'interrupt'
    | 'setMode'
    | 'setModel'
    | 'setEffort'
    | 'stopTask'
    | 'listSessions'
    | 'resumeSession'
    | 'mcpServers'
    | 'changeMcpServer'
    | 'settingsOptions'
  >;
}

/**
 * One entry per channel in the contract. The mapped type makes a missing channel a compile
 * error, and ties each channel's parser and handler to its contract types.
 */
type HandlerTable = {
  [C in CoreChannel]: { parseArgs: ArgsParser<C>; handler: ChannelHandler<C> };
};

function createHandlers(services: ChannelServices): HandlerTable {
  const { catalog, windows, sessions } = services;
  /** The canvas the sender's window shows: what every canvas's channel acts on. */
  const of = (window: WindowId) => windows.canvasOf(window);
  /**
   * The core's own sessions of a canvas it runs: they hear what a window's channel changed. Read
   * as each is handled (the engines are composed after the channels).
   */
  const own = (canvas: CanvasId) => services.engines.canvas(canvas)?.engine.sessions;
  return {
    'session:record': {
      parseArgs: parseSendArgs,
      handler: async ({ window }, agent, message) => {
        services.admitManual?.();
        const runtime = services.engines.canvas(await of(window));
        services.admitManual?.();
        if (!runtime?.document.nodes.some((node) => node.type === 'agent' && node.id === agent))
          throw new Error('That agent is no longer on this canvas.');
        runtime.engine.sessions.recordSubmission(agent, message.text, message.images);
        await runtime.journal();
        return null;
      },
    },
    'session:send': {
      parseArgs: parseSendArgs,
      handler: async ({ window }, agentId, message) => {
        services.admitManual?.();
        const runtime = services.engines.canvas(await of(window));
        services.admitManual?.();
        if (!runtime?.document.nodes.some((node) => node.type === 'agent' && node.id === agentId))
          throw new Error('That agent is no longer on this canvas.');
        const kept = await runtime.delivery.send('you', agentId, message.text, undefined, {
          images: message.images,
          told: `manual-channel:${message.id}`,
        });
        return { id: kept.id };
      },
    },
    'session:unqueue': {
      parseArgs: (args) => {
        if (args.length !== 2) throw new TypeError('Expected an agent and message id');
        const [agent] = parseAgentArgs(args.slice(0, 1));
        return [agent, MessageId.parse(args[1])];
      },
      handler: async ({ window }, agent, id) => {
        services.admitManual?.();
        const runtime = services.engines.canvas(await of(window));
        services.admitManual?.();
        const message = runtime?.messages.get(id);
        if (message?.to !== `agent:${agent}` || message.from !== 'you' || !runtime)
          throw new Error('That manual message is no longer queued for this agent.');
        await runtime.delivery.withdraw(id, 'you');
        return null;
      },
    },
    'session:answer': {
      parseArgs: parseAnswerArgs,
      handler: async ({ window }, agentId, promptId, answer) => {
        const canvas = await of(window);
        await sessions.answer(canvas, agentId, promptId, answer);
        // Its CLI took it: the core's session shows it answered too, so it no longer waits in Needs.
        own(canvas)?.answered(agentId, promptId, answer);
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
        const canvas = await of(window);
        await sessions.setMode(canvas, agentId, mode);
        own(canvas)?.applied(agentId, { mode });
        return null;
      },
    },
    'session:model': {
      parseArgs: parseModelArgs,
      handler: async ({ window }, agentId, model) => {
        const canvas = await of(window);
        await sessions.setModel(canvas, agentId, model);
        own(canvas)?.applied(agentId, { model });
        return null;
      },
    },
    'session:effort': {
      parseArgs: parseEffortArgs,
      handler: async ({ window }, agentId, effort) => {
        const canvas = await of(window);
        await sessions.setEffort(canvas, agentId, effort);
        own(canvas)?.applied(agentId, { effort });
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
    // A list is the asking window's: only it may then open what it was listed (B11 Design §7).
    'session:list': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agentId) =>
        sessions.listSessions(await of(window), agentId, `window:${String(window)}`),
    },
    'session:resume': {
      parseArgs: parseResumeArgs,
      handler: async ({ window }, agentId, sessionId) => {
        const canvas = await of(window);
        await sessions.resumeSession(canvas, agentId, sessionId, `window:${String(window)}`);
        // Its session ended, to resume that conversation: the core's starts again, resuming it.
        own(canvas)?.resumed(agentId);
        return null;
      },
    },
<<<<<<< HEAD
=======
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
    'session:availability': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agent) => sessions.availability(await of(window), agent),
    },
>>>>>>> origin/main
    'session:options': {
      parseArgs: (args) => parseOptionsArgs(args, catalog),
      handler: async ({ window }, adapter, agent) =>
        sessions.settingsOptions(
          await of(window),
          adapter,
          ...(agent === undefined ? [] : [agent]),
        ),
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
