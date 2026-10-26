import type { Children } from './children';
import type { GuiEvent, GuiEventArgs } from '../../shared/gui-link';
import type { CanvasId } from '../../shared/canvas';
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import type { Engines } from './engines';
import type { Windows } from './windows';
import type { WindowId } from './host';
import {
  parseAgentArgs,
  parseAnswerArgs,
  parseEffortArgs,
  parseModeArgs,
  parseModelArgs,
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
 * What the handlers act on: which canvas each window shows, the canvases the core runs and their
 * sessions. A handler looks up the window's canvas before calling its service.
 */
export interface ChannelServices {
  processes?: Pick<Children, 'run'>;
  windows: Pick<Windows, 'canvasOf' | 'showing' | 'gone'>;
  /**
   * The canvases the core runs, every one a window shows (B11 Design §8): what a window's session
   * channel changes of a session there, the core's own session hears too. No window calls these
   * since B11 X13; B11 X14 deletes them.
   */
  engines: Pick<Engines, 'canvas'>;
  sessions: Pick<
    SessionManager,
    'availability' | 'answer' | 'interrupt' | 'setMode' | 'setModel' | 'setEffort' | 'stopTask'
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
  const { windows, sessions } = services;
  /** The canvas the sender's window shows: what every canvas's channel acts on. */
  const of = (window: WindowId) => windows.canvasOf(window);
  /**
   * The core's own sessions of a canvas it runs: they hear what a window's channel changed. Read
   * as each is handled (the engines are composed after the channels).
   */
  const own = (canvas: CanvasId) => services.engines.canvas(canvas)?.engine.sessions;
  return {
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
    'session:availability': {
      parseArgs: parseAgentArgs,
      handler: async ({ window }, agent) => sessions.availability(await of(window), agent),
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
