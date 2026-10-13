import type { SessionMode, TerminalAsk } from '../../../shared/session';
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
 * Claude Code's is claude-code.ts; Codex's is in src/main/sessions/codex/terminal/. A TerminalCli
 * is made for one session, and may keep what it needs between calls (as what its hooks told).
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
  /** The project folder it works in (the process starts there too). */
  cwd: string;
}

/** What a hook event told, for the session to act on. */
export type TerminalSignal<M extends SessionMode> =
  /** The CLI's session id is now this (it started, or a new one began, as after /clear). */
  | { kind: 'session'; id: string }
  /** The session was cleared: a new one, whose id a later hook tells. */
  | { kind: 'cleared' }
  /** A prompt was submitted, as the CLI took it: one corrallm typed, or one the user did. */
  | { kind: 'prompt'; text: string }
  /** The turn's last reply. */
  | { kind: 'reply'; text: string }
  /** The turn failed, and why (when it says). */
  | { kind: 'failed'; why: string | undefined }
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

/** What the session tells the user, in the CLI's own words. */
export interface TerminalWords {
  /** Answers to prompts, modes and models are refused: they belong to its terminal. */
  answer: string;
  mode: string;
  model: string;
  /** It waits for the user to log in. */
  login: string;
  /**
   * What it waits on the user for, by its report's kind, when nothing tells more (as Claude Code's
   * Program Status says: a permission, a question; or nothing said).
   */
  waiting: { permission: string; question: string; auth: string; none: string };
}

export interface TerminalCli<M extends SessionMode> {
  /** The CLI, as messages name it ("Claude Code"). */
  readonly name: string;
  readonly words: TerminalWords;
  /** The mode it runs in when the user's own default applies, until it says otherwise. */
  readonly defaultMode: M;
  /** The id a new session starts under, or null where the CLI picks its own (and its hooks tell it). */
  newId(): string | null;
  /** Readies what its process needs before it first starts (a settings file in `dir`, its hooks). */
  prepare(dir: string, hooks: HookRegistration): Promise<void>;
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
   * Whether its screen shows its folder trust dialog (Claude Code's, the first time it runs in a
   * folder): it waits on the user there, before it reports anything or runs a hook. Codex is told
   * the folder is trusted on its command line, and never asks.
   */
  trusting?(screen: Screen): boolean;
  /**
   * Whether it is still getting ready (Codex starting its MCP servers): it holds a message sent
   * meanwhile until then, so the message is waited for rather than given up on.
   */
  holds?(): boolean;
  /**
   * Whether a message is typed only into its prompt as drawn (`draft` is ''), even while it
   * reports being ready: what it reports does not cover all its dialogs (as Codex's pickers).
   */
  readonly waitsForPrompt?: boolean;
  /**
   * Whether Enter waits until its prompt shows the end of what was typed (at most TerminalTiming's
   * `echo`): it reads keys that piled up while it was busy in one go, as a paste, where an Enter
   * among them is not a submit (as Claude Code, just after its folder trust dialog or as a turn
   * ends).
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
   * `prepare` set up (Claude Code's: statusline.ts), as usage windows, if it says any. The input is
   * untrusted JSON: read, never acted on beyond.
   */
  statusLine?(input: HookEvent): UsageWindows | undefined;
  /**
   * Reads its account's usage limits apart from its terminal (Codex's: a private app server), when
   * the session starts and after each turn ends; undefined if it cannot say. Never prompts the CLI.
   */
  readUsage?(): Promise<UsageWindows | undefined>;
  /** `text`, as its hooks will say it was submitted (to tell corrallm's own prompts from the user's). */
  submitted(text: string): string;
}
