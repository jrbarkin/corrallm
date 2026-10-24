import type { SessionMode, TerminalAsk, TurnReason } from '../../../shared/session';
import type { UsageWindows } from '../../../shared/usage';
import type { HookEvent, HookRegistration } from './hooks';
import type { Screen } from './screen';
import type { ProgramStatus } from './status';

/*
 * What a Terminal session (session.ts) needs to know of the CLI it runs in its pseudo-terminal:
 * how to start and resume it, how to tell from its screen and its hooks what it is doing (and what
 * it asks the user), and how to type a message into its prompt. The session does the rest the same
 * way for every CLI: the pty and main's copy of its screen, views, turns (when one starts and ends,
 * what it waits on), what it asks listed outside its terminal, the queue's messages, files dropped
 * on it, interrupts, closing, and passing on what the CLI says of its account's usage limits.
 *
 * Each adapter supplies its TerminalCli. It is made for one session, and may keep what it needs between calls (as what its hooks told).
 */

/** What its CLI's state is: Program Status's states (status.ts), whatever the CLI reports them by. */
export type CliState = ProgramStatus['state'];

/** How a session's process is started (again). */
export interface Launch<M extends SessionMode> {
  /** A folder of the session's own (prepare's), removed when the session ends. */
  dir: string;
  /** The session's id: the one to resume, or one to start under (null: the CLI picks one). */
  id: string | null;
  /** Whether to resume the session `id`, rather than start a new one. */
  resume: boolean;
  /** The model corrallm chose, or null for the CLI's (and the user's) default. */
  model: string | null;
  /** The mode corrallm chose, or null for the user's own default. */
  mode: M | null;
  /** Standing instructions appended to the native prompt for this process. */
  role?: string;
  /** The project folder it works in (the process starts there too). */
  cwd: string;
}

/** What a hook event told, for the session to act on. */
export type TerminalSignal<M extends SessionMode> =
  | { kind: 'notice'; text: string }
  /** The CLI's session id is now this (it started, or a new one began, as after /clear). */
  | { kind: 'session'; id: string }
  /** The session was cleared: a new one, whose id a later hook tells. */
  | { kind: 'cleared' }
  /** A prompt was submitted, as the CLI took it: one corrallm typed, or one the user did. */
  | { kind: 'prompt'; text: string }
  /** The turn's last reply. */
  | { kind: 'reply'; text: string }
  /** The turn failed, and why (when it says): what it said, and the reason, when it gives one. */
  | { kind: 'failed'; why: string | undefined; reason?: TurnReason }
  /**
   * Its state, for a CLI whose screen does not report it (an older one): ignored once the screen
   * has reported, which says it better.
   */
  | { kind: 'state'; state: CliState }
  | { kind: 'mode'; mode: M }
  | { kind: 'model'; model: string }
  /** What it is about to ask the user in its terminal (a permission, questions, a plan). */
  | { kind: 'ask'; ask: TerminalAsk }
  /** It needs the user, as its notification says (what it says). */
  | { kind: 'needs'; text: string };

/** Its account's usage, as its CLI reads it apart from its terminal (`readUsage`). */
export interface TerminalUsage {
  /** Its usage limits' windows, for main's readings. */
  windows: UsageWindows;
  /**
   * Until when (epoch ms) its account can't be used, where the reading says so: a limit used up,
   * and nothing (as credits) that lets the CLI go on past it. A turn the CLI ended with an error
   * without saying why failed on that limit.
   */
  usedUp?: number;
}

/** What its status line was given, as its CLI reads it (`statusLine`). */
export interface StatusLineReading {
  /** Its account's usage limits' windows, for main's readings, if it says any. */
  usage: UsageWindows | undefined;
  /**
   * What in it only the CLI's work moves (its tokens, cost and the like), as text to compare;
   * undefined if it says none. Its clock and limits are left out: a status line posted again on a
   * timer, with the same progress, is no sign of activity.
   */
  progress: string | undefined;
}

/** What the session tells the user, in the CLI's own words. */
export interface TerminalWords {
  /** Answers to prompts, modes and models are refused: they belong to its terminal. */
  answer: string;
  mode: string;
  model: string;
  /** It waits for the user to log in. */
  login: string;
  /**
   * What it waits on the user for, by its report's kind, when nothing tells more: a permission, a
   * question, a login, or nothing said.
   */
  waiting: { permission: string; question: string; auth: string; none: string };
}

export interface TerminalCli<M extends SessionMode> {
  /** The CLI, as messages name it. */
  readonly name: string;
  readonly words: TerminalWords;
  /** Native interrupt/exit keys, each sent separately before bounded process termination. */
  readonly shutdownKeys?: readonly string[];
  /** The id a new session starts under, or null where the CLI picks its own (and its hooks tell it). */
  newId(): string | null;
  /** Readies what its process needs before it first starts (a settings file in `dir`, its hooks). */
  prepare(dir: string, hooks: HookRegistration): Promise<void>;
  /**
   * Why corrallm can't hear it, once `prepare` has run (its settings turn off the hooks it posts
   * to corrallm), in a sentence that says what won't work; undefined when it can.
   */
  unheard?(): string | undefined;
  /** Its command line. */
  args(launch: Launch<M>): string[];
  /**
   * Whether a CLI that exited while resuming said it had no such session (`screen`: the text it
   * left on screen): then the session starts afresh.
   */
  resumeFailed(screen: string): boolean;
  /** Its window title changed (OSC 0 or 2): the state it says, if it says one. */
  title?(title: string): ProgramStatus | undefined;
  /**
   * Whether its screen shows a folder trust dialog: it waits on the user there, before it
   * reports anything or runs a hook.
   */
  trusting?(screen: Screen): boolean;
  /**
   * Whether it is still getting ready: it holds a message sent
   * meanwhile until then, so the message is waited for rather than given up on.
   */
  holds?(): boolean;
  /**
   * Whether a message is typed only into its prompt as drawn (`draft` is ''), even while it
   * reports being ready: what it reports does not cover all its dialogs.
   */
  readonly waitsForPrompt?: boolean;
  /**
   * Whether Enter waits until its prompt shows the end of what was typed (at most TerminalTiming's
   * `echo`): it reads keys that piled up while it was busy in one go, as a paste, where an Enter
   * among them is not a submit.
   */
  readonly waitsForEcho?: boolean;
  /** What a hook event it posted means. The event is untrusted JSON: read, never acted on beyond. */
  hook(event: HookEvent): TerminalSignal<M>[];
  /**
   * What the user has typed in its prompt and not sent: '' when it is empty, undefined when no
   * prompt is on screen (a dialog, or still starting).
   */
  draft(screen: Screen): string | undefined;
  /** The writes that type `text` into its prompt (the session presses Enter after). */
  keystrokes(text: string): string[];
  /**
   * What its status line was given, posted to the hook server's /status path by a status line
   * `prepare` set up: its usage windows and its progress, as far as it says. The input is
   * untrusted JSON: read, never acted on beyond.
   */
  statusLine?(input: HookEvent): StatusLineReading;
  /**
   * Reads its account's usage limits apart from its terminal, when the session starts and after
   * each turn ends (before it ends one the CLI ended with an error without saying why, to tell
   * whether its limit did); undefined if it cannot say. Never prompts the CLI.
   */
  readUsage?(): Promise<TerminalUsage | undefined>;
  /** `text`, as its hooks will say it was submitted (to tell corrallm's own prompts from the user's). */
  submitted(text: string): string;
}
