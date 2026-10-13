import type {
  Connection,
  PermissionMode,
  SessionAnswer,
  SessionEvent,
  SessionOptions,
  UserMessage,
} from './session';
import type { TerminalEvent } from './terminal';
import type { UsageBackend, UsageRule, UsageState, UsageWindows } from './usage';

/**
 * The IPC contract between the main process and the renderer.
 *
 * Every channel is declared here once, mapping its name to the argument tuple the renderer
 * sends and the value main resolves with. Main registers a handler for every channel
 * (src/main/ipc.ts), the preload exposes each one on `window.api` (src/preload/index.ts), and
 * the renderer calls `window.api`. The compiler checks both that the three agree on types and
 * that no channel is missing a handler or an `AppApi` method.
 *
 * Main also sends events to the renderer (`IpcEvents`): the preload exposes a function per event
 * that listens for it and returns a function that stops listening.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */
export interface IpcContract {
  /** Round-trip check. Resolves with a human-readable version string. */
  'app:ping': { args: []; result: string };
  /**
   * Asks for a canvas file to open (the Open dialog). Resolves with it, or null if cancelled. Its
   * agents' sessions end, and its project folder, if one was chosen for it, comes back.
   */
  'canvas:open': { args: []; result: CanvasFile | null };
  /**
   * Saves a canvas (its file's text) to the file it was opened from or last saved to, or, when it
   * has none or `choose` is true, to one picked in the Save dialog. Resolves with the file's name,
   * or null if cancelled. The file remembers the canvas's project folder and its agents' sessions.
   */
  'canvas:save': { args: [text: string, choose: boolean]; result: string | null };
  /**
   * Forgets the canvas's file, for a new canvas: its next save asks where. Its project folder is
   * forgotten and its agents' sessions end. Resolves with null.
   */
  'canvas:forget': { args: []; result: null };
  /**
   * Asks for the folder the canvas's agents work in (a folder dialog). Resolves with it, or null if
   * cancelled. Choosing another folder ends the agents' sessions: they start afresh in it.
   */
  'project:choose': { args: []; result: ProjectFolder | null };
  /**
   * The files and folders of the canvas's project folder (relative to it; folders end in "/")
   * that best match `query`, for an @-mention in the composer. None without a project folder.
   */
  'project:files': { args: [query: string]; result: string[] };
  /**
   * Starts an agent's connected session (or resumes it, if the canvas's file remembers one), in
   * the canvas's project folder. Resolves once it runs; rejects without a project folder, or if
   * it could not start. Starting it again with the same connection does nothing.
   */
  'session:start': { args: [agentId: string, options: SessionOptions]; result: null };
  /** Sends a message to an agent's running session: a turn starts, or the CLI queues it. */
  'session:send': { args: [agentId: string, message: UserMessage]; result: null };
  /** Answers a prompt (permission, question, plan) an agent's session is waiting on. */
  'session:answer': {
    args: [agentId: string, promptId: string, answer: SessionAnswer];
    result: null;
  };
  /** Interrupts the turn an agent's session is on, as Escape does in Claude Code. */
  'session:interrupt': { args: [agentId: string]; result: null };
  /** Switches an agent's session's permission mode. */
  'session:mode': { args: [agentId: string, mode: PermissionMode]; result: null };
  /** Switches an agent's session's model (a value from the models it offers). */
  'session:model': { args: [agentId: string, model: string]; result: null };
  /** Ends an agent's session (it can be resumed later). Resolves once its process has exited. */
  'session:close': { args: [agentId: string]; result: null };
  /**
   * Shows an agent's terminal (a Terminal session's) in the renderer's view: main sends
   * 'terminal:event's, starting with its screen, now if its session runs, or once it starts, and
   * again for each session after, until the view detaches.
   */
  'terminal:attach': { args: [agentId: string]; result: null };
  /** The view no longer shows the agent's terminal. */
  'terminal:detach': { args: [agentId: string]; result: null };
  /** Keystrokes typed in an agent's terminal view, for its CLI (dropped if none runs). */
  'terminal:input': { args: [agentId: string, data: string]; result: null };
  /** An agent's terminal view's size, in columns and rows: its terminal takes it. */
  'terminal:resize': { args: [agentId: string, cols: number, rows: number]; result: null };
  /** Every backend's latest usage reading (as remembered across restarts), and the usage rules. */
  'usage:get': { args: []; result: UsageState };
  /** Sets a backend's usage rule, or (null) takes it off. Every renderer hears 'usage:changed'. */
  'usage:rule': { args: [backend: UsageBackend, rule: UsageRule | null]; result: null };
  /**
   * Simulates a backend's usage (to try rules without spending real usage), or (null) forgets
   * its reading. A real reading replaces a simulated one. Every renderer hears 'usage:changed'.
   */
  'usage:simulate': { args: [backend: UsageBackend, windows: UsageWindows | null]; result: null };
}

/** Events main sends the renderer: each one's name, and what it carries. */
export interface IpcEvents {
  /** What an agent's connected session did. Only the renderer that started it hears. */
  'session:event': [agentId: string, connection: Connection, event: SessionEvent];
  /** What an agent's terminal shows, for the view attached to it (terminal:attach). */
  'terminal:event': [agentId: string, event: TerminalEvent];
  /**
   * Usage readings or rules changed (a reading came, or a rule was set): every renderer hears it,
   * since usage belongs to the backend's account, not to one canvas.
   */
  'usage:changed': [state: UsageState];
}

/** A canvas file: its name (without folders) and its text (src/renderer/graph/file.ts). */
export interface CanvasFile {
  name: string;
  text: string;
  /** The folder its agents work in, when one was chosen for it and is still there. */
  project?: ProjectFolder;
}

/** The folder a canvas's agents work in: its name, and where it is (to show; never sent back). */
export interface ProjectFolder {
  name: string;
  path: string;
}

/** The extension of canvas files. */
export const CANVAS_EXTENSION = 'corral';
/** The largest canvas file read or written, in bytes. */
export const MAX_CANVAS_BYTES = 10 * 1024 * 1024;

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];
export type IpcEvent = keyof IpcEvents;
export type IpcEventArgs<E extends IpcEvent> = IpcEvents[E];

/** A method per contract channel: what `window.api` invokes. */
export interface InvokeApi {
  ping(): Promise<IpcResult<'app:ping'>>;
  openCanvas(): Promise<IpcResult<'canvas:open'>>;
  saveCanvas(...args: IpcArgs<'canvas:save'>): Promise<IpcResult<'canvas:save'>>;
  forgetCanvas(): Promise<IpcResult<'canvas:forget'>>;
  chooseProject(): Promise<IpcResult<'project:choose'>>;
  findProjectFiles(...args: IpcArgs<'project:files'>): Promise<IpcResult<'project:files'>>;
  startSession(...args: IpcArgs<'session:start'>): Promise<IpcResult<'session:start'>>;
  sendToSession(...args: IpcArgs<'session:send'>): Promise<IpcResult<'session:send'>>;
  answerSession(...args: IpcArgs<'session:answer'>): Promise<IpcResult<'session:answer'>>;
  interruptSession(...args: IpcArgs<'session:interrupt'>): Promise<IpcResult<'session:interrupt'>>;
  setSessionMode(...args: IpcArgs<'session:mode'>): Promise<IpcResult<'session:mode'>>;
  setSessionModel(...args: IpcArgs<'session:model'>): Promise<IpcResult<'session:model'>>;
  closeSession(...args: IpcArgs<'session:close'>): Promise<IpcResult<'session:close'>>;
  attachTerminal(...args: IpcArgs<'terminal:attach'>): Promise<IpcResult<'terminal:attach'>>;
  detachTerminal(...args: IpcArgs<'terminal:detach'>): Promise<IpcResult<'terminal:detach'>>;
  writeTerminal(...args: IpcArgs<'terminal:input'>): Promise<IpcResult<'terminal:input'>>;
  resizeTerminal(...args: IpcArgs<'terminal:resize'>): Promise<IpcResult<'terminal:resize'>>;
  getUsage(): Promise<IpcResult<'usage:get'>>;
  setUsageRule(...args: IpcArgs<'usage:rule'>): Promise<IpcResult<'usage:rule'>>;
  simulateUsage(...args: IpcArgs<'usage:simulate'>): Promise<IpcResult<'usage:simulate'>>;
}

/** A function per event: it listens for the event, and returns a function that stops listening. */
export interface EventApi {
  onSessionEvent(listener: (...args: IpcEventArgs<'session:event'>) => void): () => void;
  onTerminalEvent(listener: (...args: IpcEventArgs<'terminal:event'>) => void): () => void;
  onUsageChanged(listener: (...args: IpcEventArgs<'usage:changed'>) => void): () => void;
}

/** The API the preload script exposes to the renderer as `window.api`. */
export interface AppApi extends InvokeApi, EventApi {}

/** Which channel each `InvokeApi` method invokes. */
export const API_CHANNELS = {
  ping: 'app:ping',
  openCanvas: 'canvas:open',
  saveCanvas: 'canvas:save',
  forgetCanvas: 'canvas:forget',
  chooseProject: 'project:choose',
  findProjectFiles: 'project:files',
  startSession: 'session:start',
  sendToSession: 'session:send',
  answerSession: 'session:answer',
  interruptSession: 'session:interrupt',
  setSessionMode: 'session:mode',
  setSessionModel: 'session:model',
  closeSession: 'session:close',
  attachTerminal: 'terminal:attach',
  detachTerminal: 'terminal:detach',
  writeTerminal: 'terminal:input',
  resizeTerminal: 'terminal:resize',
  getUsage: 'usage:get',
  setUsageRule: 'usage:rule',
  simulateUsage: 'usage:simulate',
} as const satisfies Record<keyof InvokeApi, IpcChannel>;

/** Which event each `EventApi` function listens for. */
export const API_EVENTS = {
  onSessionEvent: 'session:event',
  onTerminalEvent: 'terminal:event',
  onUsageChanged: 'usage:changed',
} as const satisfies Record<keyof EventApi, IpcEvent>;

type AssertNever<T extends never> = T;
/** Fails to compile, naming the channel, if a contract channel has no `AppApi` method. */
export type UnexposedChannels = AssertNever<
  Exclude<IpcChannel, (typeof API_CHANNELS)[keyof typeof API_CHANNELS]>
>;
/** Fails to compile, naming the event, if an event has no `AppApi` function to listen for it. */
export type UnexposedEvents = AssertNever<
  Exclude<IpcEvent, (typeof API_EVENTS)[keyof typeof API_EVENTS]>
>;
