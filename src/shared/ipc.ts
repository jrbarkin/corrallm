import type { AdapterId, Catalog, ConnectionId, UsageBackendId } from './adapter';
import type { CanvasId } from './canvas';
import type { GuiBridge } from './gui-link';
import type { RunCheckpoint, RunContext } from './run';
import type {
  FilesRewind,
  InstalledClis,
  McpChange,
  McpServer,
  PastSession,
  RewindRestore,
  RewindResult,
  SessionAnswer,
  SessionEvent,
  SessionMode,
  SessionOptions,
  SettingsOptions,
  UserMessage,
} from './session';
import type { TerminalEvent } from './terminal';
import type { UsageRule, UsageState, UsageWindows } from './usage';

/**
 * The hand-written channels between the renderer and the core. Each one's name, argument tuple
 * and result are declared here once: core/channels.ts parses and handles it, and the preload
 * exposes its fixed function on window.api over the window's port. The checked handshake,
 * core:connect, stays in main and is never exposed to the page.
 *
 * The core sends session, terminal and usage events over the port. Main still asks the renderer
 * to freeze/save with run:stopping. The preload strips transport details from each event and
 * returns a function that stops listening.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */
export interface IpcContract {
  /**
   * The preload's own, which it invokes as it loads and never exposes to the page: asks for the
   * window's port to the core, which main posts back as 'core:port' (src/shared/gui-link.ts).
   */
  'core:connect': { args: []; result: null };
  /** What every adapter declares (src/shared/adapter.ts): the renderer loads it before it mounts. */
  'catalog:get': { args: []; result: Catalog };
  /** Restore the current named canvas or durable draft, without starting an agent. */
  'run:get': { args: []; result: RunContext };
  /** The core selects storage; the token rejects writes from an earlier canvas generation. */
  'run:save': { args: [token: string, checkpoint: RunCheckpoint | null]; result: null };
  /** Renderer froze dispatch and finished persisting before the requested shutdown. */
  'run:ready': { args: [requestId: string, error: string | null]; result: null };
  /**
   * Asks for a canvas file to open (the Open dialog). Resolves with it, or null if cancelled. The
   * canvas before's agents' sessions end, and the opened one's project folder, if one was chosen
   * for it, comes back.
   */
  'canvas:open': { args: []; result: CanvasFile | null };
  /**
   * Saves a canvas (its file's text, holding its id) to the file it was opened from or last saved
   * to, or, when it has none or `choose` is true, to one picked in the Save dialog (Save As, which
   * keeps its id, and so its project folder and its agents' conversations). Resolves with the
   * file's name, or null if cancelled.
   */
  'canvas:save': { args: [text: string, choose: boolean]; result: string | null };
  /**
   * Begins a new canvas, a draft with an id of its own: its first save asks where. The canvas
   * before is kept as it was, and its agents' sessions end. Resolves with the new canvas's id.
   */
  'canvas:forget': { args: []; result: CanvasId };
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
  /**
   * Which agents the user has, by adapter, found as their connections would run them: a
   * template's agents run in a Terminal for those by default.
   */
  'session:clis': { args: []; result: InstalledClis };
  /** Sends a message to an agent's running session: a turn starts, or the CLI queues it. */
  'session:send': { args: [agentId: string, message: UserMessage]; result: null };
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
  /** Ends an agent's session (it can be resumed later). Resolves once its process has exited. */
  'session:close': { args: [agentId: string]; result: null };
  /** Forgets only this adapter's remembered conversation, keeping its native history. */
  'session:fresh': { args: [agentId: string, adapter: AdapterId]; result: null };
  /**
   * The conversations Claude Code kept for the canvas's project folder, most recent first, as
   * /resume lists them, saying which is the agent's own. Rejects without a project folder.
   */
  'session:list': { args: [agentId: string]; result: PastSession[] };
  /**
   * Makes a conversation the core listed (session:list) for the canvas's project folder the agent's
   * own: its session ends, and resumes that one when it starts again. Rejects any other id.
   */
  'session:resume': { args: [agentId: string, sessionId: string]; result: null };
  /**
   * What rewinding an agent's session to before one of its messages would restore in its files
   * (a dry run of Claude Code's file checkpoints; Agent SDK sessions).
   */
  'session:rewind-preview': { args: [agentId: string, messageId: string]; result: FilesRewind };
  /**
   * Rewinds an agent's session to before one of its messages: its files, its conversation (a
   * copy of it up to that point becomes the agent's own, and its session ends to resume it), or
   * both. Rejects, changing nothing, if that cannot be done.
   */
  'session:rewind': {
    args: [agentId: string, messageId: string, restore: RewindRestore];
    result: RewindResult;
  };
  /**
   * What an agent of an adapter can be set to run with (its models, with their efforts) and the
   * user's own defaults, read in the canvas's project folder without a session or a prompt.
   */
  'session:options': { args: [adapter: AdapterId]; result: SettingsOptions };
  /** The MCP servers an agent's running session has, and how each is (/mcp; Agent SDK sessions). */
  'session:mcp': { args: [agentId: string]; result: McpServer[] };
  /** Reconnects, enables or disables one of them; resolves with them all as they are then. */
  'session:mcp-change': {
    args: [agentId: string, server: string, change: McpChange];
    result: McpServer[];
  };
  /**
   * Shows an agent's terminal (a Terminal session's) in the renderer's view: the core sends
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
  /**
   * Files dropped on an agent's terminal view, by their paths (which the preload reads from the
   * dropped files: window.api takes the files, never paths): the core pastes those that exist into its
   * terminal, quoted, as a terminal does.
   */
  'terminal:drop': { args: [agentId: string, paths: string[]]; result: null };
  /** Every backend's latest usage reading (as remembered across restarts), and the usage rules. */
  'usage:get': { args: []; result: UsageState };
  /** Sets a backend's usage rule, or (null) takes it off. Every renderer hears 'usage:changed'. */
  'usage:rule': { args: [backend: UsageBackendId, rule: UsageRule | null]; result: null };
  /**
   * Simulates a backend's usage (to try rules without spending real usage), or (null) forgets
   * its reading. A real reading replaces a simulated one. Every renderer hears 'usage:changed'.
   */
  'usage:simulate': {
    args: [backend: UsageBackendId, windows: UsageWindows | null];
    result: null;
  };
}

/** Events the core and main send the renderer: each one's name, and what it carries. */
export interface IpcEvents {
  /** Freeze queue dispatch, persist, then acknowledge with run:ready. */
  'run:stopping': [requestId: string];
  /** What an agent's connected session did. Only the renderer that started it hears. */
  'session:event': [agentId: string, connection: ConnectionId, event: SessionEvent];
  /** What an agent's terminal shows, for the view attached to it (terminal:attach). */
  'terminal:event': [agentId: string, event: TerminalEvent];
  /**
   * Usage readings or rules changed (a reading came, or a rule was set): every renderer hears it,
   * since usage belongs to the backend's account, not to one canvas.
   */
  'usage:changed': [state: UsageState];
}

/**
 * A canvas file opened: its canvas's id (its own, or a new one for a copy of a canvas kept in
 * another file), its name (without folders) and its text (src/shared/model/file.ts).
 */
export interface CanvasFile {
  id: CanvasId;
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

/** The longest link the renderer may ask to open, in characters. */
export const MAX_LINK_LENGTH = 4096;

/** The extension of canvas files. */
export const CANVAS_EXTENSION = 'corral';
/** The largest canvas file read or written, in bytes. */
export const MAX_CANVAS_BYTES = 10 * 1024 * 1024;

export type IpcChannel = keyof IpcContract;
/** Hand-written channels served on a window’s port, after the checked handshake. */
export type CoreChannel = Exclude<IpcChannel, 'core:connect'>;
/** Events from the core; main still asks the renderer to freeze/save. */
export type CoreEvent = Exclude<IpcEvent, 'run:stopping'>;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];
export type IpcEvent = keyof IpcEvents;
export type IpcEventArgs<E extends IpcEvent> = IpcEvents[E];

/**
 * A method per contract channel: what `window.api` invokes, with the channel's arguments (but
 * dropOnTerminal, which takes the dropped files).
 */
export interface InvokeApi {
  catalog(): Promise<IpcResult<'catalog:get'>>;
  getRun(): Promise<IpcResult<'run:get'>>;
  saveRun(...args: IpcArgs<'run:save'>): Promise<IpcResult<'run:save'>>;
  runReady(...args: IpcArgs<'run:ready'>): Promise<IpcResult<'run:ready'>>;
  openCanvas(): Promise<IpcResult<'canvas:open'>>;
  saveCanvas(...args: IpcArgs<'canvas:save'>): Promise<IpcResult<'canvas:save'>>;
  forgetCanvas(): Promise<IpcResult<'canvas:forget'>>;
  chooseProject(): Promise<IpcResult<'project:choose'>>;
  findProjectFiles(...args: IpcArgs<'project:files'>): Promise<IpcResult<'project:files'>>;
  startSession(...args: IpcArgs<'session:start'>): Promise<IpcResult<'session:start'>>;
  installedClis(): Promise<IpcResult<'session:clis'>>;
  sendToSession(...args: IpcArgs<'session:send'>): Promise<IpcResult<'session:send'>>;
  answerSession(...args: IpcArgs<'session:answer'>): Promise<IpcResult<'session:answer'>>;
  interruptSession(...args: IpcArgs<'session:interrupt'>): Promise<IpcResult<'session:interrupt'>>;
  setSessionMode(...args: IpcArgs<'session:mode'>): Promise<IpcResult<'session:mode'>>;
  setSessionModel(...args: IpcArgs<'session:model'>): Promise<IpcResult<'session:model'>>;
  setSessionEffort(...args: IpcArgs<'session:effort'>): Promise<IpcResult<'session:effort'>>;
  stopSessionTask(...args: IpcArgs<'session:stopTask'>): Promise<IpcResult<'session:stopTask'>>;
  closeSession(...args: IpcArgs<'session:close'>): Promise<IpcResult<'session:close'>>;
  freshSession(...args: IpcArgs<'session:fresh'>): Promise<IpcResult<'session:fresh'>>;
  listSessions(...args: IpcArgs<'session:list'>): Promise<IpcResult<'session:list'>>;
  resumeSession(...args: IpcArgs<'session:resume'>): Promise<IpcResult<'session:resume'>>;
  previewRewind(
    ...args: IpcArgs<'session:rewind-preview'>
  ): Promise<IpcResult<'session:rewind-preview'>>;
  rewindSession(...args: IpcArgs<'session:rewind'>): Promise<IpcResult<'session:rewind'>>;
  settingsOptions(...args: IpcArgs<'session:options'>): Promise<IpcResult<'session:options'>>;
  mcpServers(...args: IpcArgs<'session:mcp'>): Promise<IpcResult<'session:mcp'>>;
  changeMcpServer(...args: IpcArgs<'session:mcp-change'>): Promise<IpcResult<'session:mcp-change'>>;
  attachTerminal(...args: IpcArgs<'terminal:attach'>): Promise<IpcResult<'terminal:attach'>>;
  detachTerminal(...args: IpcArgs<'terminal:detach'>): Promise<IpcResult<'terminal:detach'>>;
  writeTerminal(...args: IpcArgs<'terminal:input'>): Promise<IpcResult<'terminal:input'>>;
  resizeTerminal(...args: IpcArgs<'terminal:resize'>): Promise<IpcResult<'terminal:resize'>>;
  /** Takes the dropped files themselves: their paths are read in the preload, not by the page. */
  dropOnTerminal(agentId: string, files: readonly File[]): Promise<IpcResult<'terminal:drop'>>;
  getUsage(): Promise<IpcResult<'usage:get'>>;
  setUsageRule(...args: IpcArgs<'usage:rule'>): Promise<IpcResult<'usage:rule'>>;
  simulateUsage(...args: IpcArgs<'usage:simulate'>): Promise<IpcResult<'usage:simulate'>>;
}

/** A function per event: it listens for the event, and returns a function that stops listening. */
export interface EventApi {
  onRunStopping(listener: (...args: IpcEventArgs<'run:stopping'>) => void): () => void;
  onSessionEvent(listener: (...args: IpcEventArgs<'session:event'>) => void): () => void;
  onTerminalEvent(listener: (...args: IpcEventArgs<'terminal:event'>) => void): () => void;
  onUsageChanged(listener: (...args: IpcEventArgs<'usage:changed'>) => void): () => void;
}

/**
 * The API the preload script exposes to the renderer as `window.api`: a function per channel and
 * per event, and one per GUI operation, over the window's port to the core.
 */
export interface AppApi extends InvokeApi, EventApi, GuiBridge {}

/** Which channel each `InvokeApi` method invokes. */
export const API_CHANNELS = {
  catalog: 'catalog:get',
  getRun: 'run:get',
  saveRun: 'run:save',
  runReady: 'run:ready',
  openCanvas: 'canvas:open',
  saveCanvas: 'canvas:save',
  forgetCanvas: 'canvas:forget',
  chooseProject: 'project:choose',
  findProjectFiles: 'project:files',
  startSession: 'session:start',
  installedClis: 'session:clis',
  sendToSession: 'session:send',
  answerSession: 'session:answer',
  interruptSession: 'session:interrupt',
  setSessionMode: 'session:mode',
  setSessionModel: 'session:model',
  setSessionEffort: 'session:effort',
  stopSessionTask: 'session:stopTask',
  closeSession: 'session:close',
  freshSession: 'session:fresh',
  listSessions: 'session:list',
  resumeSession: 'session:resume',
  previewRewind: 'session:rewind-preview',
  rewindSession: 'session:rewind',
  settingsOptions: 'session:options',
  mcpServers: 'session:mcp',
  changeMcpServer: 'session:mcp-change',
  attachTerminal: 'terminal:attach',
  detachTerminal: 'terminal:detach',
  writeTerminal: 'terminal:input',
  resizeTerminal: 'terminal:resize',
  dropOnTerminal: 'terminal:drop',
  getUsage: 'usage:get',
  setUsageRule: 'usage:rule',
  simulateUsage: 'usage:simulate',
} as const satisfies Record<keyof InvokeApi, IpcChannel>;

/** Which event each `EventApi` function listens for. */
export const API_EVENTS = {
  onRunStopping: 'run:stopping',
  onSessionEvent: 'session:event',
  onTerminalEvent: 'terminal:event',
  onUsageChanged: 'usage:changed',
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
