import type { SessionAvailability } from './session';
import type { ConnectionId } from './adapter';
import type { GuiBridge, GuiDraftsApi } from './gui-link';
import type { SessionAnswer, SessionEvent, SessionMode } from './session';

/**
 * The hand-written channels between the renderer and the core. Each one's name, argument tuple
 * and result are declared here once: core/channels.ts parses and handles it, and the preload
 * exposes its fixed function on window.api over the window's port. The checked handshake,
 * core:connect, stays in main and is never exposed to the page.
 *
 * The core sends session events over the port; terminals and topics use gui-link.ts. The preload
 * strips transport details from each event and returns a function that stops listening. The agent
 * window uses none of these any more (B11 X13: its sessions are the core's, through the session
 * topics and operations); B11 X14 deletes what remains, with the window retry bridge that still
 * emits `session:event`.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */
export interface IpcContract {
  /**
   * The preload's own, which it invokes as it loads and never exposes to the page: asks for the
   * window's port to the core, which main posts back as 'core:port' (src/shared/gui-link.ts).
   */
  'core:connect': { args: []; result: null };
  /** Answers a prompt (permission, question, plan) an agent's session is waiting on. */
  'session:answer': {
    args: [agentId: string, promptId: string, answer: SessionAnswer];
    result: null;
  };
  /** Interrupts the turn an agent's session is on, as Escape does in Claude Code. */
  'session:interrupt': { args: [agentId: string]; result: null };
  /** Switches an agent's session's mode (one of its CLI's: permission mode, or Codex's preset). */
  'session:mode': { args: [agentId: string, mode: SessionMode]; result: null };
  /** Switches an agent's session's model (a value from the models it offers). */
  'session:model': { args: [agentId: string, model: string]; result: null };
  /**
   * Switches an agent's session's reasoning effort, for that session (one its model offers; null:
   * the model's default). Rejects for a session that does not take it (a Terminal's: set it in
   * its terminal).
   */
  'session:effort': { args: [agentId: string, effort: string | null]; result: null };
  /**
   * Stops a task an agent's session runs in the background (a subagent, a command), by the id its
   * 'tasks' event gave. Rejects for a task it does not run in the background.
   */
  'session:stopTask': { args: [agentId: string, taskId: string]; result: null };
  /** Whether new work for an agent waits on its workspace: ready, or why not. */
  'session:availability': { args: [agent: string]; result: SessionAvailability };
}

/** Events the core and main send the renderer: each one's name, and what it carries. */
export interface IpcEvents {
  /** What an agent's connected session did. Only the renderer that started it hears. */
  'session:availability': [];
  'session:event': [agentId: string, connection: ConnectionId, event: SessionEvent];
}

/** The folder a canvas's agents work in: its name, and where it is (to show; never sent back). */
export interface ProjectFolder {
  name: string;
  path: string;
}

/** The longest link the renderer may ask to open, in characters. */
export const MAX_LINK_LENGTH = 4096;

/** The extension of canvas files. */
export const CANVAS_EXTENSION = 'corral';
/** The largest canvas file read or written, in bytes. */
export const MAX_CANVAS_BYTES = 10 * 1024 * 1024;

export type IpcChannel = keyof IpcContract;
/** Hand-written channels served on a window’s port, after the checked handshake. */
export type CoreChannel = Exclude<IpcChannel, 'core:connect'>;
/** Events from the core. */
export type CoreEvent = IpcEvent;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];
export type IpcEvent = keyof IpcEvents;
export type IpcEventArgs<E extends IpcEvent> = IpcEvents[E];

/**
 * A method per remaining contract channel, with its arguments.
 */
export interface InvokeApi {
  answerSession(...args: IpcArgs<'session:answer'>): Promise<IpcResult<'session:answer'>>;
  interruptSession(...args: IpcArgs<'session:interrupt'>): Promise<IpcResult<'session:interrupt'>>;
  setSessionMode(...args: IpcArgs<'session:mode'>): Promise<IpcResult<'session:mode'>>;
  setSessionModel(...args: IpcArgs<'session:model'>): Promise<IpcResult<'session:model'>>;
  setSessionEffort(...args: IpcArgs<'session:effort'>): Promise<IpcResult<'session:effort'>>;
  stopSessionTask(...args: IpcArgs<'session:stopTask'>): Promise<IpcResult<'session:stopTask'>>;
  sessionAvailability(
    ...args: IpcArgs<'session:availability'>
  ): Promise<IpcResult<'session:availability'>>;
}

/** A function per event: it listens for the event, and returns a function that stops listening. */
export interface EventApi {
  onSessionAvailability(listener: () => void): () => void;
  onSessionEvent(listener: (...args: IpcEventArgs<'session:event'>) => void): () => void;
}

/**
 * The API the preload script exposes to the renderer as `window.api`: a function per channel and
 * per event, and one per GUI operation, over the window's port to the core.
 */
export interface AppApi extends InvokeApi, EventApi, GuiBridge, GuiDraftsApi {}

/** Which channel each `InvokeApi` method invokes. */
export const API_CHANNELS = {
  answerSession: 'session:answer',
  interruptSession: 'session:interrupt',
  setSessionMode: 'session:mode',
  setSessionModel: 'session:model',
  setSessionEffort: 'session:effort',
  stopSessionTask: 'session:stopTask',
  sessionAvailability: 'session:availability',
} as const satisfies Record<keyof InvokeApi, IpcChannel>;

/** Which event each `EventApi` function listens for. */
export const API_EVENTS = {
  onSessionEvent: 'session:event',
  onSessionAvailability: 'session:availability',
} as const satisfies Record<keyof EventApi, IpcEvent>;

type AssertNever<T extends never> = T;
/**
 * Fails to compile, naming the channel, if a contract channel has no `AppApi` method (but the
 * preload's own, core:connect).
 */
export type UnexposedChannels = AssertNever<
  Exclude<IpcChannel, (typeof API_CHANNELS)[keyof typeof API_CHANNELS] | 'core:connect'>
>;
/** Fails to compile, naming the event, if an event has no `AppApi` function to listen for it. */
export type UnexposedEvents = AssertNever<
  Exclude<IpcEvent, (typeof API_EVENTS)[keyof typeof API_EVENTS]>
>;
