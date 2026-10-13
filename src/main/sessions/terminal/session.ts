import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import type { PermissionMode, SessionMode, UserMessage } from '../../../shared/session';
import type { TerminalEvent } from '../../../shared/terminal';
import type { LiveSession, SessionHost, SessionSpec, TerminalScreen } from '../connector';
import type { TerminalCli, TerminalSignal } from './cli';
import type { HookEvent, HookRegistration, HookServer } from './hooks';
import type { Pty, SpawnPty } from './pty';
import { Screen } from './screen';
import type { ProgramStatus } from './status';
import { ENTER } from './typing';

/*
 * A Terminal session: a CLI's own interactive terminal (Claude Code's, Codex's) in a
 * pseudo-terminal, which the agent's view shows as it is (every feature of the CLI works there, as
 * the user knows it), while corrallm follows it to orchestrate it: it knows when the session
 * works, waits on the user, or is done, from what the CLI reports on its screen (Claude Code's
 * Program Status reports: status.ts; or its window title) and what its hooks tell (hooks.ts); it
 * types the queue's messages into the prompt, and hears each turn end. What differs between CLIs
 * (their command line, how they report, their prompt, their hooks) is their TerminalCli's
 * (cli.ts: Claude Code's is claude-code.ts).
 *
 * A turn, as corrallm sees it, starts with a message corrallm sends, or with the CLI starting to
 * work on its own (a prompt the user typed in the terminal, a background task reporting back), and
 * lasts until the CLI has taken every message corrallm sent in it and stopped working. corrallm
 * types a message only once the prompt is ready: the CLI idle (or done), and nothing the user
 * typed in the prompt; meanwhile, a session kept from it by a dialog (as Claude Code's folder
 * trust prompt) or by the user's draft is waiting on the user.
 */

/** How long things take, in ms. */
export interface TerminalTiming {
  /** Between the writes that type a message. */
  key: number;
  /** Between a message's last keystrokes and the Enter that sends it. */
  enter: number;
  /**
   * How long the CLI may take to take a message once Enter is pressed (twice: see `#confirm`).
   */
  confirm: number;
  /** After output, how long the screen is let settle before corrallm reads it. */
  settle: number;
  /** How long the CLI may take to show its prompt before a message waiting for it waits on the user (a dialog). */
  startup: number;
  /** How long output collects before it goes to the view. */
  batch: number;
  /** How long the CLI may take to exit once told to, before it is killed. */
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

type State = ProgramStatus['state'];
/** The CLI at work on a turn, or waiting on the user in one. */
const busy = (state: State | undefined) => state === 'working' || state === 'blocked';

/** A turn going on, as corrallm sees it. */
interface Turn {
  /** The messages it answers: corrallm's, and prompts typed in the terminal. */
  messages: string[];
  started: number;
  /** Whether the CLI worked in it (said it was working, or waiting on the user). */
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

export interface TerminalSessionDeps<M extends SessionMode = PermissionMode> {
  /** The CLI's executable (the user's `claude`, `codex`). */
  executable: string;
  /** What is particular to the CLI (cli.ts). */
  cli: TerminalCli<M>;
  spawn: SpawnPty;
  hooks: HookServer;
  /** Where its settings file goes (a folder of its own is made in it). */
  tmp: string;
  /** Its environment: the agents' (spec.env), as a terminal sets it up (connector.ts). */
  env: (token: string) => Record<string, string>;
  timing: TerminalTiming;
}

export class TerminalSession<M extends SessionMode = PermissionMode> implements LiveSession<M> {
  readonly #spec: SessionSpec<M>;
  readonly #host: SessionHost;
  readonly #deps: TerminalSessionDeps<M>;
  readonly #cli: TerminalCli<M>;
  /**
   * Its CLI's session id: the one it resumes or was given, then whatever its hooks say (null
   * until they say, for a CLI that picks its own).
   */
  #id: string | null;
  /** Whether its CLI resumes a session it may not find (then it starts afresh). */
  #resuming: boolean;
  #mode: M;
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

  /** The latest state the CLI reported of the session itself, and whether it ever reported one. */
  #state: State | undefined;
  #reporting = false;
  #turn: Turn | undefined;
  /** Messages to type, once the prompt is ready. */
  #pending: UserMessage[] = [];
  /** A message being typed, until it is (or the typing is stopped). */
  #typing: { stopped: boolean } | undefined;
  /** Enter was pressed on a message: the CLI has yet to take it. */
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

  constructor(spec: SessionSpec<M>, host: SessionHost, deps: TerminalSessionDeps<M>) {
    this.#spec = spec;
    this.#host = host;
    this.#deps = deps;
    this.#cli = deps.cli;
    this.#id = spec.resume ?? deps.cli.newId();
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
      this.#settingsDir = await mkdtemp(path.join(this.#deps.tmp, 'corrallm-terminal-'));
      await this.#cli.prepare(this.#settingsDir, this.#registration);
      await this.#start();
    } catch (error) {
      await this.#cleanUp();
      throw error;
    }
    if (this.#id !== null) this.#host.remember(this.#id);
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
      return Promise.reject(new Error(`${this.#cli.name} is not running in this terminal.`));
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
    return Promise.reject(new Error(this.#cli.words.answer));
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
    return Promise.reject(new Error(this.#cli.words.mode));
  }

  setModel(): Promise<void> {
    return Promise.reject(new Error(this.#cli.words.model));
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
    const { model, mode, cwd } = this.#spec;
    const args = this.#cli.args({
      dir: this.#settingsDir ?? '',
      id: this.#id,
      resume: this.#resuming,
      model,
      mode,
      cwd,
    });
    const pty = await this.#deps.spawn(this.#deps.executable, args, {
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
      title: (title) => {
        const report = this.#cli.title?.(title);
        if (report) this.#status(report);
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
      this.#cli.resumeFailed(this.#screen.text())
    ) {
      // Its transcript is gone (or it never had one: no message was sent): it starts afresh (Claude
      // Code under the same id).
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
      ...(code === 0 ? {} : { error: `${this.#cli.name} exited with code ${String(code)}.` }),
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

  /**
   * A report of the CLI's state (Program Status, or what its title says): the session's own drives
   * its turns; its tasks' are left out.
   */
  #status(report: ProgramStatus): void {
    if (report.id !== undefined || report.state === 'clear') return;
    this.#reporting = true;
    this.#become(report.state, report);
  }

  /** The CLI's state changed (as it reported, or as its hooks tell when it does not report). */
  #become(state: State, report?: ProgramStatus): void {
    this.#state = state;
    if (busy(state)) {
      const turn = this.#turn ?? this.#begin();
      turn.ran = true;
      this.#taken();
      if (state === 'blocked' && report?.kind === 'auth') {
        this.#tell(turn, 'error', this.#cli.words.login);
      }
    } else {
      if (state === 'error' && this.#turn) {
        this.#tell(this.#turn, 'error', report?.msg ?? `${this.#cli.name} stopped with an error.`);
      }
      this.#settle();
      // Once it has drawn its prompt again (with what it may put back in it).
      this.#check();
    }
    this.#updateStatus();
  }

  /** The CLI took the message corrallm sent. */
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

  /** Whether a message can be typed now: the CLI's prompt is ready, and empty. */
  #ready(): boolean {
    const draft = this.#cli.draft(this.#screen);
    if (draft !== undefined && draft !== '') return false;
    // Without reports (an older Claude Code), its prompt on screen says it is ready; a CLI whose
    // reports leave out some dialogs (Codex's) needs its prompt on screen as well.
    if (!this.#reporting) return draft === '';
    return !busy(this.#state) && (draft === '' || !this.#cli.waitsForPrompt);
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
    const writes = this.#cli.keystrokes(message.text);
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
    this.#unconfirmed.push(this.#cli.submitted(message.text));
    this.#confirm(0);
  }

  /**
   * Waits for the CLI to take the message (to say it works on it). If it is still in the prompt,
   * Enter again, once; then it was not sent. If it left the prompt but nothing started (a command
   * that runs at once, as /clear), it is done with once it has stayed quiet a while, unless the
   * CLI holds it until it is ready.
   */
  #confirm(tries: number): void {
    this.#confirming = this.#later(() => {
      this.#confirming = undefined;
      void this.#screen.settled().then(() => {
        if (!this.#awaiting || this.#exited) return;
        const draft = this.#cli.draft(this.#screen);
        const stuck = draft !== undefined && draft !== '';
        if (tries === 0) {
          if (stuck) this.#write(ENTER);
          this.#confirm(1);
          return;
        }
        // Sent, and held until the CLI is ready (its MCP servers start): it will take it then.
        if (!stuck && this.#cli.holds?.()) {
          this.#confirm(1);
          return;
        }
        this.#awaiting = false;
        const turn = this.#turn;
        if (turn && stuck) {
          turn.failed = true;
          this.#tell(
            turn,
            'warning',
            `corrallm typed the message into the terminal, but ${this.#cli.name} did not send it: send it there.`,
          );
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
      const draft = this.#cli.draft(this.#screen);
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
    for (const signal of this.#cli.hook(event)) this.#signal(signal);
  }

  /** Acts on what a hook told (cli.ts: TerminalSignal). */
  #signal(signal: TerminalSignal<M>): void {
    switch (signal.kind) {
      case 'session':
        if (signal.id !== this.#id && /^[\w-]{1,200}$/.test(signal.id)) {
          this.#id = signal.id;
          this.#host.remember(signal.id);
        }
        return;
      case 'cleared':
        // A new session, whose id a later hook tells. Until then, an id of its own: resumed after
        // a restart, it starts afresh, as the cleared session did.
        this.#id = randomUUID();
        this.#host.remember(this.#id);
        return;
      case 'prompt': {
        // A message corrallm typed (often told after the CLI said it is working on it).
        const typed = this.#unconfirmed.indexOf(signal.text.trim());
        if (typed !== -1) this.#unconfirmed.splice(typed, 1);
        if (typed !== -1 || this.#awaiting) this.#taken();
        else {
          // One the user typed in the terminal.
          const turn = this.#turn ?? this.#begin();
          const message = randomUUID();
          turn.messages.push(message);
          this.#host.emit({ type: 'user', id: message, text: signal.text });
        }
        return;
      }
      case 'reply':
        if (signal.text.trim() !== '' && this.#turn) {
          this.#host.emit({ type: 'text', id: randomUUID(), text: signal.text });
        }
        return;
      case 'failed':
        if (this.#turn) {
          this.#tell(this.#turn, 'error', signal.why ?? `${this.#cli.name} stopped with an error.`);
        }
        return;
      case 'state':
        if (!this.#reporting) this.#become(signal.state);
        return;
      case 'mode':
        if (signal.mode !== this.#mode) {
          this.#mode = signal.mode;
          this.#host.emit({ type: 'mode', mode: signal.mode });
        }
        return;
      case 'model':
        this.#host.emit({ type: 'model', model: signal.model });
        return;
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
