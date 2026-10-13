import type {
  PermissionMode,
  SessionAnswer,
  SessionEvent,
  UserMessage,
} from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';

/*
 * The seam a connection plugs into. A connector starts an agent's session (Claude Code in a
 * terminal, or through the Agent SDK) and turns what its CLI does into corrallm's session events
 * (src/shared/session.ts). The manager (manager.ts) owns everything around it: which renderer and
 * agent a session belongs to, the project folder it runs in, the environment, which session to
 * resume, remembering session ids, routing the renderer's requests, and closing every session
 * when its canvas changes, its renderer goes, or the app quits.
 *
 * To add a connection: write a `Connector` in its own folder (src/main/sessions/<name>/) and
 * register it in connectors.ts. Its tests use a fake CLI, never the real one.
 */

/** What a connector is given to start a session. */
export interface SessionSpec {
  /**
   * The agent the session is for, as the renderer names it: for logs only. Events are routed by the
   * manager; never put it in a path or a command line.
   */
  agentId: string;
  /** The canvas's project folder, which the user chose: the agent works there. */
  cwd: string;
  /** The environment its process gets: the user's login shell's, cleaned (environment.ts). */
  env: Readonly<Record<string, string>>;
  /** The model to start with, or null for the CLI's default ('default' is that too). */
  model: string | null;
  /**
   * The mode to start in, or null for the user's own default mode (their settings'): the session
   * says which it is ('started', then 'mode' if the CLI says otherwise).
   */
  mode: PermissionMode | null;
  /** The id of the session to resume (it was given to `remember`), or null to start a new one. */
  resume: string | null;
}

/** Where a session reports to. */
export interface SessionHost {
  /**
   * Tells the renderer what happened (see `SessionEvent` for the order events come in). Emit
   * 'started' once the session runs, and 'closed' if it stops by itself (its process exits).
   */
  emit(event: SessionEvent): void;
  /**
   * Remembers the session's id (the CLI's), to resume it after a restart: when it starts, and
   * whenever it changes (as /clear starts a new one).
   */
  remember(sessionId: string): void;
}

/** A session that runs. The manager calls these with arguments it has validated. */
export interface LiveSession {
  /** Sends a message: a turn starts (the manager sends one at a time, once the last has ended). */
  send(message: UserMessage): Promise<void>;
  /** Answers a prompt it emitted, by the prompt's id. */
  answer(promptId: string, answer: SessionAnswer): Promise<void>;
  /** Interrupts the turn going on, if any: it ends with an 'end' that says so. */
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  /** Ends the session: resolves once its process has exited. It need not emit 'closed'. */
  close(): Promise<void>;
  /** A Terminal session's screen, which its agent view shows; other connections have none. */
  readonly terminal?: TerminalScreen;
}

/**
 * The screen of a session that runs its CLI in a terminal (the Terminal connection). The manager
 * shows it in the agent's view, in the renderer that started the session.
 */
export interface TerminalScreen {
  /**
   * Shows the screen to a view: 'screen' with what it shows now, then its 'output' as the CLI
   * prints, and 'exit' when the CLI exits (or has). Returns a function that stops showing it.
   */
  show(view: (event: TerminalEvent) => void): () => void;
  /** Keystrokes the user typed in the view. */
  input(data: string): void;
  /** The view's size changed: the terminal takes it. */
  resize(cols: number, rows: number): void;
}

/** Starts sessions of one kind of connection. */
export interface Connector {
  /** Starts (or resumes) a session: resolves once it runs, or rejects saying why it could not. */
  start(spec: SessionSpec, host: SessionHost): Promise<LiveSession>;
}

/** A connector for a connection not built yet: starting it says so. */
export function unavailable(what: string): Connector {
  return {
    start: () => Promise.reject(new Error(`corrallm can't run ${what} yet.`)),
  };
}
