import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_ANSWER_LENGTH,
  MAX_QUESTIONS,
  MODEL_PATTERN,
  PERMISSION_MODES,
} from '../../../shared/session';
import type { PermissionMode, TerminalAsk, UserMessage } from '../../../shared/session';
import type { TerminalEvent } from '../../../shared/terminal';
import type { LiveSession, SessionHost, SessionSpec, TerminalScreen } from '../connector';
import { askedQuestions } from '../sdk/prompts';
import { property, text as textOf, toolSummary } from '../sdk/tools';
import type { Places } from '../sdk/tools';
import { hookSettings } from './hooks';
import type { HookEvent, HookRegistration, HookServer } from './hooks';
import type { Pty, SpawnPty } from './pty';
import { Screen } from './screen';
import type { ProgramStatus } from './status';
import { ENTER, keystrokes, typeable } from './typing';

/*
 * A Terminal session: Claude Code's own interactive CLI in a pseudo-terminal, which the agent's
 * view shows as it is (every feature of Claude Code works there, as the user knows it), while
 * corrallm follows it to orchestrate it: it knows when the session works, waits on the user, or
 * is done, from Claude Code's Program Status reports (status.ts), and what its hooks tell
 * (hooks.ts); it types the queue's messages into the prompt (typing.ts), and hears each turn end.
 *
 * A turn, as corrallm sees it, starts with a message corrallm sends, or with Claude Code starting
 * to work on its own (a prompt the user typed in the terminal, a background task reporting back),
 * and lasts until Claude Code has taken every message corrallm sent in it and stopped working.
 * corrallm types a message only once the prompt is ready: Claude Code idle (or done), and nothing
 * the user typed in the prompt; meanwhile, a session kept from it by a dialog (as Claude Code's
 * folder trust prompt) or by the user's draft is waiting on the user.
 *
 * What Claude Code asks the user in its terminal is listed outside it ('asking'), never answered:
 * its hooks tell what a permission prompt is for, its questions and a plan to approve, just before
 * it shows them; its status reports say when it waits on the user (and, in a word, for what), and
 * when it goes on (the user answered, in the terminal).
 */

/** How long things take, in ms. */
export interface TerminalTiming {
  /** Between the writes that type a message. */
  key: number;
  /** Between a message's last keystrokes and the Enter that sends it. */
  enter: number;
  /**
   * How long Claude Code may take to take a message once Enter is pressed (twice: see `#confirm`).
   */
  confirm: number;
  /** After output, how long the screen is let settle before corrallm reads it. */
  settle: number;
  /** How long Claude Code may take to show its prompt before a message waiting for it waits on the user (a dialog). */
  startup: number;
  /** How long output collects before it goes to the view. */
  batch: number;
  /** How long Claude Code may take to exit once told to, before it is killed. */
  kill: number;
}

export const TIMING: TerminalTiming = {
  key: 4,
  enter: 80,
  confirm: 2000,
  settle: 50,
  startup: 3000,
  batch: 8,
  kill: 3000,
};

/** The size of a terminal no view has sized yet. */
const COLS = 100;
const ROWS = 30;
/** Output sent to the view at once when this much has collected. */
const BATCH_MAX = 64 * 1024;
const ESCAPE = '\x1b';
const CTRL_C = '\x03';
/** What a terminal sends around a paste, when the program asked (bracketed paste mode). */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const LOGIN = 'Claude Code needs you to log in: run /login in its terminal.';
/** What it waits on, by its status's kind, when nothing tells more. */
const WAITING = {
  permission: 'Claude Code asks for your permission.',
  question: 'Claude Code asks you something.',
  auth: LOGIN,
  none: 'Claude Code is waiting for you.',
} as const;
/** Notifications that Claude Code needs the user (not that it is idle, or done). */
const NEEDS_YOU = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);
/**
 * How long before Claude Code waits on the user its hooks may have told what it asks, in ms: it
 * shows a dialog right after them. Older ones were for dialogs it did not show (another hook of
 * the user's answered them).
 */
const ASK_WINDOW = 5000;
/** At most this many asks are listed, and this much of a plan or a notification. */
const MAX_ASKS = 8;
const MAX_ASK_TEXT = 2000;
const NOT_SENT =
  'corrallm typed the message into the terminal, but Claude Code did not send it: send it there.';

type State = ProgramStatus['state'];
/** Claude Code at work on a turn, or waiting on the user in one. */
const busy = (state: State | undefined) => state === 'working' || state === 'blocked';

/** A turn going on, as corrallm sees it. */
interface Turn {
  /** The messages it answers: corrallm's, and prompts typed in the terminal. */
  messages: string[];
  started: number;
  /** Whether Claude Code worked in it (said it was working, or waiting on the user). */
  ran: boolean;
  interrupted: boolean;
  failed: boolean;
  /** Whether the user was told why it failed, or that they must log in. */
  told: boolean;
  /** The status last sent. */
  status: 'working' | 'waiting' | undefined;
}

/** What a view is shown: events wait until it has the screen to start from. */
interface Link {
  view: (event: TerminalEvent) => void;
  ready: boolean;
  queued: TerminalEvent[];
}

export interface TerminalSessionDeps {
  /** The `claude` executable. */
  claude: string;
  spawn: SpawnPty;
  hooks: HookServer;
  /** Where its settings file goes (a folder of its own is made in it). */
  tmp: string;
  /** Its environment: the agents' (spec.env), as a terminal sets it up (connector.ts). */
  env: (token: string) => Record<string, string>;
  timing: TerminalTiming;
  /** The user's home folder: where the files it asks about are shown from (as ~), outside the project. */
  home: string;
}

export class TerminalSession implements LiveSession {
  readonly #spec: SessionSpec;
  readonly #host: SessionHost;
  readonly #deps: TerminalSessionDeps;
  /** Its CLI's session id: the one it resumes or was given, then whatever its hooks say. */
  #id: string;
  /** Whether its CLI resumes a session it may not find (then it starts that id afresh). */
  #resuming: boolean;
  #mode: PermissionMode;
  #registration: HookRegistration | undefined;
  #settingsDir: string | undefined;
  #pty: Pty | undefined;
  #screen: Screen;
  /** Resolves when the current process exits. */
  #exit: Promise<void> = Promise.resolve();
  #size = { cols: COLS, rows: ROWS };
  #spawned = 0;
  #exited = false;
  #closing = false;
  #cleaned = false;

  /** The latest Program Status of the session itself, and whether it ever sent one. */
  #state: State | undefined;
  #reporting = false;
  #turn: Turn | undefined;
  /** Messages to type, once the prompt is ready. */
  #pending: UserMessage[] = [];
  /** A message being typed, until it is (or the typing is stopped). */
  #typing: { stopped: boolean } | undefined;
  /** Enter was pressed on a message: Claude Code has yet to take it. */
  #awaiting = false;
  /** The messages typed this turn whose prompt its hooks have yet to tell (as typed). */
  #unconfirmed: string[] = [];

  /** Where it works, for the files its asks are about. */
  #places: Places;
  /** What its hooks said Claude Code asks the user since it last went on, and when. */
  #asks: { ask: TerminalAsk; at: number }[] = [];
  /** What keeps Claude Code waiting on the user, by status record ('' for its own): since when. */
  readonly #blocks = new Map<string, { report: ProgramStatus; since: number; id: string }>();
  /** What its last notification that it needs the user said (until it goes on). */
  #notified: { id: string; text: string } | undefined;
  /** The asks last listed (JSON): only a change is sent. */
  #listed = '[]';

  #link: Link | undefined;
  /** Output for the view, collecting. */
  #outgoing = '';
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #checking: ReturnType<typeof setTimeout> | undefined;
  #batching: ReturnType<typeof setTimeout> | undefined;
  #confirming: ReturnType<typeof setTimeout> | undefined;

  readonly terminal: TerminalScreen = {
    show: (view) => this.#show(view),
    input: (data) => {
      if (!this.#exited) this.#pty?.write(data);
    },
    resize: (cols, rows) => {
      this.#size = { cols, rows };
      if (this.#exited) return;
      this.#pty?.resize(cols, rows);
      this.#screen.resize(cols, rows);
    },
    paste: (text) => {
      if (text === '') return;
      this.#write(this.#screen.bracketedPaste ? `${PASTE_START}${text}${PASTE_END}` : text);
    },
  };

  constructor(spec: SessionSpec, host: SessionHost, deps: TerminalSessionDeps) {
    this.#spec = spec;
    this.#host = host;
    this.#deps = deps;
    this.#id = spec.resume ?? randomUUID();
    this.#resuming = spec.resume !== null;
    this.#mode = spec.mode;
    this.#places = { cwd: spec.cwd, home: deps.home };
    this.#screen = this.#newScreen();
  }

  /** Starts its CLI: resolves once it runs. */
  async launch(): Promise<void> {
    // The CLI works in the folder's real path (a folder reached through a link).
    const realCwd = await realpath(this.#spec.cwd).catch(() => this.#spec.cwd);
    if (realCwd !== this.#spec.cwd) this.#places = { ...this.#places, realCwd };
    try {
      this.#registration = await this.#deps.hooks.register((event) => {
        this.#hook(event);
      });
      this.#settingsDir = await mkdtemp(path.join(this.#deps.tmp, 'corrallm-claude-'));
      await writeFile(
        path.join(this.#settingsDir, 'settings.json'),
        JSON.stringify(hookSettings(this.#registration.url)),
        { mode: 0o600 },
      );
      await this.#start();
    } catch (error) {
      await this.#cleanUp();
      throw error;
    }
    this.#host.remember(this.#id);
    this.#host.emit({
      type: 'started',
      model: this.#spec.model,
      mode: this.#spec.mode,
      // The terminal is its own model picker.
      models: [],
    });
  }

  send(message: UserMessage): Promise<void> {
    if (this.#exited || this.#closing) {
      return Promise.reject(new Error('Claude Code is not running in this terminal.'));
    }
    const turn = this.#turn ?? this.#begin();
    turn.messages.push(message.id);
    this.#host.emit({ type: 'user', id: message.id, text: message.text });
    this.#pending.push(message);
    this.#updateStatus();
    this.#check();
    return Promise.resolve();
  }

  answer(): Promise<void> {
    return Promise.reject(new Error('Answer Claude Code in its terminal.'));
  }

  async interrupt(): Promise<void> {
    if (this.#gone()) return;
    // What Claude Code printed so far is read first: it may have just started working.
    await this.#screen.settled();
    const turn = this.#turn;
    if (!turn || this.#gone()) return;
    turn.interrupted = true;
    this.#pending = [];
    if (this.#typing) {
      this.#typing.stopped = true;
      // Clears what was typed of it: the prompt was empty before.
      this.#write(CTRL_C);
    }
    if (this.#awaiting || busy(this.#state)) this.#write(ESCAPE);
    else this.#settle();
  }

  setMode(): Promise<void> {
    return Promise.reject(new Error('Switch modes in Claude Code’s terminal (Shift+Tab).'));
  }

  setModel(): Promise<void> {
    return Promise.reject(new Error('Switch models in Claude Code’s terminal (/model).'));
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#typing) this.#typing.stopped = true;
    this.#clearTimers();
    const pty = this.#pty;
    if (pty && !this.#exited) {
      const exited = this.#exit;
      const within = (ms: number) =>
        Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(resolve, ms, false)),
        ]);
      pty.kill();
      if (!(await within(this.#deps.timing.kill))) {
        pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
        await within(this.#deps.timing.kill);
      }
    }
    await this.#cleanUp();
  }

  /** Runs the CLI in a new pseudo-terminal, on a fresh screen (shown to the view, if any). */
  async #start(): Promise<void> {
    const settings = path.join(this.#settingsDir ?? '', 'settings.json');
    const { model, mode } = this.#spec;
    const args = [
      '--settings',
      settings,
      ...(this.#resuming ? ['--resume', this.#id] : ['--session-id', this.#id]),
      ...(model === null ? [] : ['--model', model]),
      // Manual is Claude Code's default: the user's own default mode (their settings) applies.
      ...(mode === 'manual' ? [] : ['--permission-mode', mode]),
    ];
    const pty = await this.#deps.spawn(this.#deps.claude, args, {
      cwd: this.#spec.cwd,
      env: this.#deps.env(this.#registration?.token ?? ''),
      ...this.#size,
    });
    this.#pty = pty;
    this.#spawned = Date.now();
    this.#exit = new Promise((resolve) => {
      pty.onExit(({ exitCode }) => {
        void this.#ended(pty, exitCode).finally(resolve);
      });
    });
    pty.onData((data) => {
      if (pty === this.#pty) this.#output(data);
    });
    // Until its prompt shows, a message for it waits: after a while, on the user (a dialog).
    this.#later(() => {
      this.#check();
    }, this.#deps.timing.startup);
  }

  #newScreen(): Screen {
    return new Screen({
      ...this.#size,
      reply: (data) => {
        this.#write(data);
      },
      status: (report) => {
        this.#status(report);
      },
      // A view's terminal answers what the CLI asks; with none, this screen does.
      answersQueries: () => this.#link === undefined,
    });
  }

  /** The CLI's process exited: the session ends, unless it resumed a session it could not find. */
  async #ended(pty: Pty, code: number): Promise<void> {
    if (pty !== this.#pty) return;
    await this.#screen.settled();
    if (
      !this.#closing &&
      this.#resuming &&
      !this.#reporting &&
      /No conversation found/i.test(this.#screen.text())
    ) {
      // Its transcript is gone (or it never had one: no message was sent): that id starts afresh.
      this.#resuming = false;
      this.#screen.dispose();
      this.#screen = this.#newScreen();
      if (this.#link) this.#reshow(this.#link);
      try {
        await this.#start();
        return;
      } catch {
        // It ends, as below.
      }
    }
    this.#exited = true;
    this.#clearTimers();
    this.#flush();
    this.#deliver({ type: 'exit', code });
    if (this.#closing) return;
    this.#forgetAsks();
    this.#host.emit({
      type: 'closed',
      ...(code === 0 ? {} : { error: `Claude Code exited with code ${String(code)}.` }),
    });
    await this.#cleanUp();
  }

  // ---- What the CLI prints, and the view.

  #output(data: string): void {
    this.#screen.write(data);
    if (this.#link) {
      this.#outgoing += data;
      if (this.#outgoing.length >= BATCH_MAX) this.#flush();
      else {
        this.#batching ??= this.#later(() => {
          this.#batching = undefined;
          this.#flush();
        }, this.#deps.timing.batch);
      }
    }
    if (this.#pending.length > 0 || this.#turn) this.#check();
  }

  #flush(): void {
    if (this.#batching !== undefined) {
      clearTimeout(this.#batching);
      this.#timers.delete(this.#batching);
      this.#batching = undefined;
    }
    if (this.#outgoing === '') return;
    const data = this.#outgoing;
    this.#outgoing = '';
    this.#deliver({ type: 'output', data });
  }

  #deliver(event: TerminalEvent): void {
    const link = this.#link;
    if (!link) return;
    if (link.ready) link.view(event);
    else link.queued.push(event);
  }

  #show(view: (event: TerminalEvent) => void): () => void {
    const link: Link = { view, ready: false, queued: [] };
    this.#link = link;
    this.#reshow(link);
    if (this.#exited) this.#deliver({ type: 'exit', code: null });
    return () => {
      if (this.#link === link) this.#link = undefined;
    };
  }

  /** Starts the view from the screen as it is: what collected for it so far is on it. */
  #reshow(link: Link): void {
    link.ready = false;
    link.queued = [];
    this.#outgoing = '';
    void this.#screen.snapshot().then((snapshot) => {
      if (this.#link !== link) return;
      link.view({ type: 'screen', ...snapshot });
      link.ready = true;
      for (const event of link.queued.splice(0)) link.view(event);
    });
  }

  // ---- Turns.

  #begin(): Turn {
    const turn: Turn = {
      messages: [],
      started: Date.now(),
      ran: false,
      interrupted: false,
      failed: false,
      told: false,
      status: undefined,
    };
    this.#turn = turn;
    return turn;
  }

  /** A Program Status report: the session's own drives its turns; its tasks' are left out. */
  #status(report: ProgramStatus): void {
    this.#block(report);
    if (report.id !== undefined || report.state === 'clear') return;
    this.#reporting = true;
    this.#become(report.state, report);
  }

  /** Claude Code's state changed (as it reported, or as its hooks tell when it does not report). */
  #become(state: State, report?: ProgramStatus): void {
    this.#state = state;
    if (busy(state)) {
      const turn = this.#turn ?? this.#begin();
      turn.ran = true;
      this.#taken();
      if (state === 'blocked' && report?.kind === 'auth') this.#tell(turn, 'error', LOGIN);
    } else {
      if (state === 'error' && this.#turn) {
        this.#tell(this.#turn, 'error', report?.msg ?? 'Claude Code stopped with an error.');
      }
      this.#settle();
      // Once it has drawn its prompt again (with what it may put back in it).
      this.#check();
    }
    this.#updateStatus();
  }

  /** Claude Code took the message corrallm sent. */
  #taken(): void {
    if (!this.#awaiting) return;
    this.#awaiting = false;
    if (this.#confirming !== undefined) {
      clearTimeout(this.#confirming);
      this.#timers.delete(this.#confirming);
      this.#confirming = undefined;
    }
  }

  /** Ends the turn, if nothing in it is left to do. */
  #settle(): void {
    const turn = this.#turn;
    if (!turn || this.#typing || this.#awaiting || this.#pending.length > 0) return;
    if (busy(this.#state)) return;
    this.#turn = undefined;
    this.#unconfirmed = [];
    // What it asked in the turn was answered (or never will be).
    this.#asks = [];
    this.#notified = undefined;
    this.#list();
    const interrupted = turn.interrupted || (turn.ran && this.#state === 'idle');
    this.#host.emit({
      type: 'end',
      messages: turn.messages,
      seconds: Math.max(1, Math.round((Date.now() - turn.started) / 1000)),
      interrupted,
      failed: !interrupted && (turn.failed || (turn.ran && this.#state === 'error')),
    });
  }

  /** Whether a message can be typed now: Claude Code's prompt is ready, and empty. */
  #ready(): boolean {
    const draft = this.#screen.draft();
    if (draft !== undefined && draft !== '') return false;
    // Without reports (an older Claude Code), its prompt on screen says it is ready.
    return this.#reporting ? !busy(this.#state) : draft === '';
  }

  /** Types the next message, if one waits and the prompt is ready (read once the screen settles). */
  #pump(): void {
    if (this.#typing || this.#awaiting || this.#exited || this.#closing || !this.#pty) return;
    const next = this.#pending[0];
    if (!next || !this.#ready()) return;
    this.#pending.shift();
    void this.#type(next);
  }

  async #type(message: UserMessage): Promise<void> {
    const typing = { stopped: false };
    this.#typing = typing;
    const writes = keystrokes(message.text);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const keys of writes) {
      if (typing.stopped) break;
      this.#write(keys);
      await pause(this.#deps.timing.key);
    }
    if (!typing.stopped && writes.length > 0) await pause(this.#deps.timing.enter);
    this.#typing = undefined;
    if (typing.stopped || this.#exited || this.#closing) {
      this.#settle();
      return;
    }
    if (writes.length === 0) {
      // Nothing to type: done with it.
      this.#settle();
      this.#check();
      return;
    }
    this.#write(ENTER);
    this.#awaiting = true;
    this.#unconfirmed.push(typeable(message.text).trim());
    this.#confirm(0);
  }

  /**
   * Waits for Claude Code to take the message (to say it works on it). If it is still in the
   * prompt, Enter again, once; then it was not sent. If it left the prompt but nothing started (a
   * command that runs at once, as /clear), it is done with once it has stayed quiet a while.
   */
  #confirm(tries: number): void {
    this.#confirming = this.#later(() => {
      this.#confirming = undefined;
      void this.#screen.settled().then(() => {
        if (!this.#awaiting || this.#exited) return;
        const draft = this.#screen.draft();
        const stuck = draft !== undefined && draft !== '';
        if (tries === 0) {
          if (stuck) this.#write(ENTER);
          this.#confirm(1);
          return;
        }
        this.#awaiting = false;
        const turn = this.#turn;
        if (turn && stuck) {
          turn.failed = true;
          this.#tell(turn, 'warning', NOT_SENT);
        }
        this.#settle();
        this.#check();
        this.#updateStatus();
      });
    }, this.#deps.timing.confirm);
  }

  /** Sends the turn's status when it changes: waiting while the user must act, else working. */
  #updateStatus(): void {
    const turn = this.#turn;
    if (!turn || this.#exited) return;
    let status: 'working' | 'waiting' = 'working';
    if (this.#state === 'blocked') status = 'waiting';
    else if (this.#pending.length > 0 && !this.#typing && !this.#awaiting && !this.#ready()) {
      const draft = this.#screen.draft();
      // The user's draft is in the way; or something (a dialog) keeps the prompt from showing.
      if (draft !== undefined && draft !== '') status = 'waiting';
      else if (!busy(this.#state) && Date.now() - this.#spawned >= this.#deps.timing.startup) {
        status = 'waiting';
      }
    }
    if (status === turn.status) return;
    turn.status = status;
    this.#host.emit({ type: 'status', status });
  }

  /** Tells the user what went wrong in a turn, once. */
  #tell(turn: Turn, level: 'warning' | 'error', text: string): void {
    if (turn.told) return;
    turn.told = true;
    this.#host.emit({ type: 'notice', id: randomUUID(), level, text });
  }

  /** Reads the screen again shortly (once it has settled): types what waits, says what it waits on. */
  #check(): void {
    if (this.#checking !== undefined || this.#exited) return;
    this.#checking = this.#later(() => {
      void this.#screen.settled().then(() => {
        this.#checking = undefined;
        if (this.#exited || this.#closing) return;
        this.#pump();
        this.#updateStatus();
      });
    }, this.#deps.timing.settle);
  }

  // ---- Hooks.

  #hook(event: HookEvent): void {
    if (this.#exited || this.#closing) return;
    const text = (key: string) => {
      const value = event[key];
      return typeof value === 'string' ? value : undefined;
    };
    const id = text('session_id');
    if (id !== undefined && id !== this.#id && /^[\w-]{1,200}$/.test(id)) {
      this.#id = id;
      this.#host.remember(id);
    }
    const mode = modeOf(text('permission_mode'));
    if (mode !== undefined && mode !== this.#mode) {
      this.#mode = mode;
      this.#host.emit({ type: 'mode', mode });
    }
    switch (text('hook_event_name')) {
      case 'UserPromptSubmit': {
        const prompt = text('prompt') ?? '';
        // A message corrallm typed (often told after Claude Code said it is working on it).
        const typed = this.#unconfirmed.indexOf(prompt.trim());
        if (typed !== -1) this.#unconfirmed.splice(typed, 1);
        if (typed !== -1 || this.#awaiting) this.#taken();
        else {
          // One the user typed in the terminal.
          const turn = this.#turn ?? this.#begin();
          const message = randomUUID();
          turn.messages.push(message);
          this.#host.emit({ type: 'user', id: message, text: prompt });
        }
        if (!this.#reporting) this.#become('working');
        return;
      }
      case 'Stop': {
        const reply = text('last_assistant_message');
        if (reply !== undefined && reply.trim() !== '' && this.#turn) {
          this.#host.emit({ type: 'text', id: randomUUID(), text: reply });
        }
        if (!this.#reporting) this.#become('done');
        return;
      }
      case 'StopFailure': {
        if (this.#turn) {
          const why = text('error_details') ?? text('last_assistant_message') ?? text('error');
          this.#tell(this.#turn, 'error', why ?? 'Claude Code stopped with an error.');
        }
        if (!this.#reporting) this.#become('error');
        return;
      }
      case 'SessionEnd':
        // /clear: the session goes on under a new id, which its next hook tells. Until then, an
        // id of its own: resumed after a restart, it starts afresh, as the cleared session did.
        if (text('reason') === 'clear') {
          this.#id = randomUUID();
          this.#host.remember(this.#id);
        }
        return;
      case 'PostModelSwitch': {
        const model = text('to_model');
        if (model !== undefined && MODEL_PATTERN.test(model)) {
          this.#host.emit({ type: 'model', model });
        }
        return;
      }
      // What it is about to ask the user: a permission prompt (and its questions or plan, as
      // their tools start: told by both).
      case 'PermissionRequest':
      case 'PreToolUse': {
        const ask = this.#askOf(text('tool_name'), event.tool_input, text('tool_use_id'));
        if (ask) this.#told(ask);
        return;
      }
      case 'Notification': {
        const message = text('message')?.trim() ?? '';
        if (message !== '' && NEEDS_YOU.has(text('notification_type') ?? '')) {
          this.#notified = { id: randomUUID(), text: message.slice(0, MAX_ASK_TEXT) };
          this.#list();
        }
        return;
      }
    }
  }

  // ---- What it asks the user, in its terminal.

  /** What a tool call asks of the user, as a hook tells it: its questions, a plan, or permission. */
  #askOf(tool: string | undefined, input: unknown, toolUseId: string | undefined) {
    if (tool === undefined || tool === '') return undefined;
    const id =
      toolUseId !== undefined && /^[\w-]{1,200}$/.test(toolUseId) ? toolUseId : randomUUID();
    if (tool === 'AskUserQuestion') {
      const questions = askedQuestions(property(input, 'questions'));
      return (
        questions && { kind: 'question' as const, id, questions: questions.slice(0, MAX_QUESTIONS) }
      );
    }
    if (tool === 'ExitPlanMode') {
      const plan = (textOf(property(input, 'plan')) ?? '').slice(0, MAX_ANSWER_LENGTH);
      return { kind: 'plan' as const, id, plan };
    }
    return {
      kind: 'permission' as const,
      id,
      tool,
      summary: toolSummary(tool, input, this.#places),
    };
  }

  /** A hook told what Claude Code is about to ask (once, though two hooks may tell it). */
  #told(ask: TerminalAsk): void {
    const same = (other: TerminalAsk) =>
      JSON.stringify({ ...other, id: '' }) === JSON.stringify({ ...ask, id: '' });
    if (this.#asks.some((told) => same(told.ask))) return;
    this.#asks = [...this.#asks, { ask, at: Date.now() }].slice(-MAX_ASKS);
    this.#list();
  }

  /**
   * Follows what keeps Claude Code (or a task of it) waiting on the user, from its status reports.
   * Once a wait ends, what it asked was answered (in the terminal).
   */
  #block(report: ProgramStatus): void {
    const record = report.id ?? '';
    if (report.state === 'clear' && report.id === undefined) {
      this.#forgetAsks();
      return;
    }
    if (report.state === 'blocked') {
      const known = this.#blocks.get(record);
      this.#blocks.set(record, {
        report,
        since: known?.since ?? Date.now(),
        id: known?.id ?? randomUUID(),
      });
    } else if (this.#blocks.delete(record)) {
      this.#asks = [];
      this.#notified = undefined;
    }
    this.#list();
  }

  /** Nothing is asked any more: the CLI is going. */
  #forgetAsks(): void {
    this.#blocks.clear();
    this.#asks = [];
    this.#notified = undefined;
    this.#list();
  }

  /**
   * What Claude Code asks the user now. While it waits on them: what its hooks told just before
   * (or, if they told nothing, what it waits for in its status's words, or its notification's). It
   * may tell without waiting: what a notification says it needs. Without status reports (an older
   * Claude Code), what its hooks told, until the turn ends.
   */
  #asking(): TerminalAsk[] {
    if (this.#exited) return [];
    const notified: TerminalAsk[] = this.#notified ? [{ kind: 'other', ...this.#notified }] : [];
    if (!this.#reporting && this.#blocks.size === 0) {
      return this.#asks.length > 0 ? this.#asks.map(({ ask }) => ask) : notified;
    }
    const blocks = [...this.#blocks.values()];
    if (blocks.length === 0) return notified;
    const since = Math.min(...blocks.map((block) => block.since)) - ASK_WINDOW;
    const told = this.#asks.filter(({ at }) => at >= since).map(({ ask }) => ask);
    if (told.length > 0) return told;
    return blocks.map(({ report, id }) => ({
      kind: 'other',
      id,
      text: report.msg ?? this.#notified?.text ?? WAITING[report.kind ?? 'none'],
    }));
  }

  /** Lists what Claude Code asks now, if that changed. */
  #list(): void {
    const asks = this.#asking();
    const listed = JSON.stringify(asks);
    if (listed === this.#listed) return;
    this.#listed = listed;
    this.#host.emit({ type: 'asking', asks });
  }

  // ---- Housekeeping.

  /** Whether its CLI has exited, or the session was cleaned up (its screen is gone). */
  #gone(): boolean {
    return this.#exited || this.#cleaned;
  }

  #write(data: string): void {
    if (!this.#exited) this.#pty?.write(data);
  }

  #later(run: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, ms);
    this.#timers.add(timer);
    return timer;
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#checking = undefined;
    this.#batching = undefined;
    this.#confirming = undefined;
  }

  async #cleanUp(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    this.#registration?.release();
    if (this.#settingsDir !== undefined) {
      await rm(this.#settingsDir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.#screen.dispose();
  }
}

/** A permission mode as Claude Code's hooks name it ('default' is Manual). */
function modeOf(name: string | undefined): PermissionMode | undefined {
  if (name === 'default') return 'manual';
  return PERMISSION_MODES.find((mode) => mode === name);
}
