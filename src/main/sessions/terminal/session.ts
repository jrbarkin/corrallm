import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MODEL_PATTERN, PERMISSION_MODES } from '../../../shared/session';
import type { PermissionMode, UserMessage } from '../../../shared/session';
import type { TerminalEvent } from '../../../shared/terminal';
import type { LiveSession, SessionHost, SessionSpec, TerminalScreen } from '../connector';
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
 */

/** How long things take, in ms. */
export interface TerminalTiming {
  /** Between the writes that type a message. */
  key: number;
  /** After Claude Code's prompt shows a message's keystrokes, before the Enter that sends it. */
  enter: number;
  /**
   * How long Claude Code may take to show a message's keystrokes in its prompt before Enter is
   * pressed anyway (see `#shown`).
   */
  echo: number;
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
  echo: 3000,
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

/** How much of the end of a message the prompt must show before Enter is pressed. */
const TAIL = 40;

const LOGIN = 'Claude Code needs you to log in: run /login in its terminal.';
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
  };

  constructor(spec: SessionSpec, host: SessionHost, deps: TerminalSessionDeps) {
    this.#spec = spec;
    this.#host = host;
    this.#deps = deps;
    this.#id = spec.resume ?? randomUUID();
    this.#resuming = spec.resume !== null;
    this.#mode = spec.mode;
    this.#screen = this.#newScreen();
  }

  /** Starts its CLI: resolves once it runs. */
  async launch(): Promise<void> {
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

  interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn || this.#exited) return Promise.resolve();
    turn.interrupted = true;
    this.#pending = [];
    if (this.#typing) {
      this.#typing.stopped = true;
      // Clears what was typed of it: the prompt was empty before.
      this.#write(CTRL_C);
    }
    if (this.#awaiting || busy(this.#state)) this.#write(ESCAPE);
    else this.#settle();
    return Promise.resolve();
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
    if (!typing.stopped && writes.length > 0) {
      await this.#shown(typeable(message.text), typing);
      await pause(this.#deps.timing.enter);
    }
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
   * Waits until Claude Code's prompt shows the end of what was typed, `text` (it has read those
   * keys), at most `timing.echo`. Enter read in one go with keys before it is taken for part of a
   * paste, not a submit: keys pile up so while Claude Code is busy (just after the folder trust
   * dialog, or as a turn ends), and the message would stay in the prompt.
   */
  async #shown(text: string, typing: { stopped: boolean }): Promise<void> {
    const tail = flat(text).slice(-TAIL);
    const until = Date.now() + this.#deps.timing.echo;
    while (!typing.stopped && !this.#exited && Date.now() < until) {
      await this.#screen.settled();
      if (flat(this.#screen.draft() ?? '').endsWith(tail)) return;
      await new Promise((resolve) => setTimeout(resolve, this.#deps.timing.settle));
    }
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
    }
  }

  // ---- Housekeeping.

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

/** Text with each run of whitespace (line breaks, the prompt's wrapping) as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
