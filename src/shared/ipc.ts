import type { SessionAvailability } from './session';
import type { AdapterId, ConnectionId } from './adapter';
import type { GuiBridge, GuiDraftsApi } from './gui-link';
import type {
  McpChange,
  McpServer,
  PastSession,
  SessionAnswer,
  SessionEvent,
  SessionMode,
  SettingsOptions,
  UserMessage,
} from './session';

/**
 * The hand-written channels between the renderer and the core. Each one's name, argument tuple
 * and result are declared here once: core/channels.ts parses and handles it, and the preload
 * exposes its fixed function on window.api over the window's port. The checked handshake,
 * core:connect, stays in main and is never exposed to the page.
 *
 * The core sends session events over the port; terminals and topics use gui-link.ts. The preload
 * strips transport details from each event and returns a function that stops listening. These are
 * what the agent window still asks of an agent's session until B11 X13 moves it onto the session
 * topic and operations (the core's runtime, which runs every canvas a window shows, hears what
 * they change); a canvas's run is the core's alone, through operations and topics.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */
export interface IpcContract {
  /**
   * The preload's own, which it invokes as it loads and never exposes to the page: asks for the
   * window's port to the core, which main posts back as 'core:port' (src/shared/gui-link.ts).
   */
  'core:connect': { args: []; result: null };
  /** Sends a message to an agent's running session: a turn starts, or the CLI queues it. */
  'session:send': { args: [agentId: string, message: UserMessage]; result: { id: string } };
  /** X13 transitional: a command the session view handled, recorded without a CLI turn. */
  'session:record': { args: [agentId: string, message: UserMessage]; result: null };
  /** X13 transitional: withdraws one manual message from this window's canvas. */
  'session:unqueue': { args: [agentId: string, id: string]; result: null };
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
   * What an agent of an adapter can be set to run with (its models, with their efforts) and the
   * user's own defaults, read in the canvas's project folder without a session or a prompt.
   */
  'session:availability': { args: [agent: string]; result: SessionAvailability };
  'session:options': { args: [adapter: AdapterId, agent?: string]; result: SettingsOptions };
  /** The MCP servers an agent's running session has, and how each is (/mcp; Agent SDK sessions). */
  'session:mcp': { args: [agentId: string]; result: McpServer[] };
  /** Reconnects, enables or disables one of them; resolves with them all as they are then. */
  'session:mcp-change': {
    args: [agentId: string, server: string, change: McpChange];
    result: McpServer[];
  };
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
  sendToSession(...args: IpcArgs<'session:send'>): Promise<IpcResult<'session:send'>>;
  recordSessionCommand(...args: IpcArgs<'session:record'>): Promise<IpcResult<'session:record'>>;
  unqueueSession(...args: IpcArgs<'session:unqueue'>): Promise<IpcResult<'session:unqueue'>>;
  answerSession(...args: IpcArgs<'session:answer'>): Promise<IpcResult<'session:answer'>>;
  interruptSession(...args: IpcArgs<'session:interrupt'>): Promise<IpcResult<'session:interrupt'>>;
  setSessionMode(...args: IpcArgs<'session:mode'>): Promise<IpcResult<'session:mode'>>;
  setSessionModel(...args: IpcArgs<'session:model'>): Promise<IpcResult<'session:model'>>;
  setSessionEffort(...args: IpcArgs<'session:effort'>): Promise<IpcResult<'session:effort'>>;
  stopSessionTask(...args: IpcArgs<'session:stopTask'>): Promise<IpcResult<'session:stopTask'>>;
  listSessions(...args: IpcArgs<'session:list'>): Promise<IpcResult<'session:list'>>;
  resumeSession(...args: IpcArgs<'session:resume'>): Promise<IpcResult<'session:resume'>>;
<<<<<<< HEAD
=======
  previewRewind(
    ...args: IpcArgs<'session:rewind-preview'>
  ): Promise<IpcResult<'session:rewind-preview'>>;
  rewindSession(...args: IpcArgs<'session:rewind'>): Promise<IpcResult<'session:rewind'>>;
  sessionAvailability(
    ...args: IpcArgs<'session:availability'>
  ): Promise<IpcResult<'session:availability'>>;
>>>>>>> origin/main
  settingsOptions(...args: IpcArgs<'session:options'>): Promise<IpcResult<'session:options'>>;
  mcpServers(...args: IpcArgs<'session:mcp'>): Promise<IpcResult<'session:mcp'>>;
  changeMcpServer(...args: IpcArgs<'session:mcp-change'>): Promise<IpcResult<'session:mcp-change'>>;
}

/** A function per event: it listens for the event, and returns a function that stops listening. */
export interface EventApi {
<<<<<<< HEAD
=======
  onSessionAvailability(listener: () => void): () => void;
  onRunStopping(listener: (...args: IpcEventArgs<'run:stopping'>) => void): () => void;
>>>>>>> origin/main
  onSessionEvent(listener: (...args: IpcEventArgs<'session:event'>) => void): () => void;
}

/**
 * The API the preload script exposes to the renderer as `window.api`: a function per channel and
 * per event, and one per GUI operation, over the window's port to the core.
 */
export interface AppApi extends InvokeApi, EventApi, GuiBridge, GuiDraftsApi {}

/** Which channel each `InvokeApi` method invokes. */
export const API_CHANNELS = {
  sendToSession: 'session:send',
  recordSessionCommand: 'session:record',
  unqueueSession: 'session:unqueue',
  answerSession: 'session:answer',
  interruptSession: 'session:interrupt',
  setSessionMode: 'session:mode',
  setSessionModel: 'session:model',
  setSessionEffort: 'session:effort',
  stopSessionTask: 'session:stopTask',
  listSessions: 'session:list',
  resumeSession: 'session:resume',
<<<<<<< HEAD
=======
  previewRewind: 'session:rewind-preview',
  rewindSession: 'session:rewind',
  sessionAvailability: 'session:availability',
>>>>>>> origin/main
  settingsOptions: 'session:options',
  mcpServers: 'session:mcp',
  changeMcpServer: 'session:mcp-change',
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
