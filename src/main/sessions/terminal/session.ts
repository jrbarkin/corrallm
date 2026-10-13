import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import type {
  PermissionMode,
  SessionMode,
  TerminalAsk,
  UserMessage,
} from '../../../shared/session';
import type { TerminalEvent } from '../../../shared/terminal';
import type { UsageWindows } from '../../../shared/usage';
import type { LiveSession, SessionHost, SessionSpec, TerminalScreen } from '../connector';
import type { TerminalCli, TerminalSignal } from './cli';
import type { FirstRunTurn } from './first-run';
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
 *
 * What the CLI asks the user in its terminal is listed outside it ('asking'), never answered: its
 * hooks may tell what it is about to ask (Claude Code's: what a permission prompt is for, its
 * questions and a plan to approve, just before it shows them); its reports say when it waits on
 * the user (and, in a word, for what), and when it goes on (the user answered, in the terminal).
 * Its folder trust dialog (Claude Code's, the first time it runs in a folder) is read from its
 * screen, turn or not: nothing else tells it.
 *
 * A CLI that may ask whether to trust the folder starts in its turn (first-run.ts): while another
 * session's CLI in the folder has yet to get past its first-run dialogs, this one waits to start
 * (held), its view saying why, so that the user is asked once, not once per agent.
 */

/** How long things take, in ms. */
export interface TerminalTiming {
  /** Between the writes that type a message. */
  key: number;
  /**
   * After a message's keystrokes (once the CLI's prompt shows them, where it waits for that: see
   * `echo`), before the Enter that sends it.
   */
  enter: number;
  /**
   * How long the CLI may take to show a message's keystrokes in its prompt before Enter is pressed
   * anyway, where it waits for them (TerminalCli.waitsForEcho; see `#shown`).
   */
  echo: number;
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
/** What a terminal sends around a paste, when the program asked (bracketed paste mode). */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * How long before the CLI waits on the user its hooks may have told what it asks, in ms: it shows
 * a dialog right after them. Older ones were for dialogs it did not show (another hook of the
 * user's answered them).
 */
const ASK_WINDOW = 5000;
/** At most this many asks are listed. */
const MAX_ASKS = 8;
/** How much of the end of a message the prompt must show before Enter is pressed (`#shown`). */
const TAIL = 40;

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
  /**
   * Takes what its CLI says of its account's usage limits (cli.ts: `statusLine`, `readUsage`), for
   * main's readings.
   */
  usage?: (windows: UsageWindows) => void;
  /**
   * Its turn to start its CLI in the folder (first-run.ts), for a CLI that may ask whether to trust
   * it: told once the CLI is past its first-run dialogs, or gone before.
   */
  firstRun?: FirstRunTurn;
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

  /** What its hooks said the CLI asks the user since it last went on, and when. */
  #asks: { ask: TerminalAsk; at: number }[] = [];
  /** What keeps the CLI waiting on the user, by status record ('' for its own): since when. */
  readonly #blocks = new Map<string, { report: ProgramStatus; since: number; id: string }>();
  /** What its last notification that it needs the user said (until it goes on). */
  #notified: { id: string; text: string } | undefined;
  /** The asks last listed (JSON): only a change is sent. */
  #listed = '[]';
  /** The folder trust dialog its CLI shows now, as it is listed; undefined while none shows. */
  #trust: TerminalAsk | undefined;
  /**
   * Whether its CLI got past its first-run dialogs (it reported its state, a hook posted, or its
   * prompt showed): it no longer asks whether to trust the folder.
   */
  #passed = false;
  /** Whether it waits for its turn to start its CLI (another session in the folder is first). */
  #held = false;

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

  constructor(spec: SessionSpec<M>, host: SessionHost, deps: TerminalSessionDeps<M>) {
    this.#spec = spec;
    this.#host = host;
    this.#deps = deps;
    this.#cli = deps.cli;
    this.#id = spec.resume ?? deps.cli.newId();
    this.#resuming = spec.resume !== null;
    // Until its hooks say otherwise: the CLI's own default, if the user's applies.
    this.#mode = spec.mode ?? deps.cli.defaultMode;
    this.#screen = this.#newScreen();
  }

  /** Starts its CLI: resolves once it runs. */
  async launch(): Promise<void> {
    try {
      this.#registration = await this.#deps.hooks.register(
        (event) => {
          this.#hook(event);
        },
        // A CLI with a status line of corrallm's posts its input there too.
        this.#cli.statusLine &&
          ((input) => {
            this.#statusLine(input);
          }),
      );
      this.#settingsDir = await mkdtemp(path.join(this.#deps.tmp, 'corrallm-terminal-'));
      await this.#cli.prepare(this.#settingsDir, this.#registration);
      const turn = this.#deps.firstRun?.ready;
      if (turn === undefined) await this.#start();
      else this.#hold(turn);
    } catch (error) {
      await this.#cleanUp();
      throw error;
    }
    if (this.#id !== null) this.#host.remember(this.#id);
    this.#host.emit({
      type: 'started',
      model: this.#spec.model,
      mode: this.#mode,
      // The terminal is its own model picker.
      models: [],
    });
    this.#readUsage();
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

  async interrupt(): Promise<void> {
    if (this.#gone()) return;
    // What the CLI printed so far is read first: it may have just started working.
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

  /**
   * Waits for its turn to start its CLI: another session in the folder started first, and has yet
   * to get past its first-run dialogs (the folder trust dialog). Meanwhile its screen says so;
   * then the CLI starts on a fresh screen, unless the session was closed.
   */
  #hold(turn: Promise<void>): void {
    this.#held = true;
    const { name } = this.#cli;
    // In short lines, which no terminal wraps.
    this.#output(
      [
        '',
        `  Waiting to start ${name}.`,
        '',
        `  Another agent’s ${name} is starting in this folder first. If it asks`,
        '  whether you trust the folder, answer it in that agent’s terminal (it is',
        `  in Needs you, on the canvas), and ${name} starts here.`,
        '',
      ].join('\r\n'),
    );
    void turn.then(async () => {
      if (this.#closing || this.#cleaned) return;
      this.#held = false;
      this.#screen.dispose();
      this.#screen = this.#newScreen();
      if (this.#link) this.#reshow(this.#link);
      try {
        await this.#start();
      } catch (error) {
        this.#exited = true;
        this.#clearTimers();
        this.#deliver({ type: 'exit', code: null });
        this.#host.emit({
          type: 'closed',
          error: error instanceof Error ? error.message : `${name} could not start.`,
        });
        await this.#cleanUp();
        return;
      }
      if (!this.#gone()) this.#check();
    });
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
    if (this.#closing) {
      // Closed while it started (as one that waited for its turn): its CLI goes too.
      pty.kill();
      return;
    }
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
    this.#forgetAsks();
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
    if (this.#pending.length > 0 || this.#turn || !this.#passed) this.#check();
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
    this.#pass();
    this.#block(report);
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
    this.#readUsage();
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
    if (!typing.stopped && writes.length > 0) {
      if (this.#cli.waitsForEcho) await this.#shown(message.text, typing);
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
    this.#unconfirmed.push(this.#cli.submitted(message.text));
    this.#confirm(0);
  }

  /**
   * Waits until the CLI's prompt shows the end of the message (`text`), at most `timing.echo`: it
   * has read those keys. A CLI that reads keys late (TerminalCli.waitsForEcho) takes an Enter read
   * in one go with keys before it for part of a paste, not a submit: keys pile up so while it is
   * busy (Claude Code just after its folder trust dialog, or as a turn ends), and the message would
   * stay in the prompt.
   */
  async #shown(text: string, typing: { stopped: boolean }): Promise<void> {
    const tail = flat(this.#cli.submitted(text)).slice(-TAIL);
    const until = Date.now() + this.#deps.timing.echo;
    while (!typing.stopped && !this.#exited && Date.now() < until) {
      await this.#screen.settled();
      if (flat(this.#cli.draft(this.#screen) ?? '').endsWith(tail)) return;
      await new Promise((resolve) => setTimeout(resolve, this.#deps.timing.settle));
    }
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
    else if (
      !this.#held &&
      this.#pending.length > 0 &&
      !this.#typing &&
      !this.#awaiting &&
      !this.#ready()
    ) {
      const draft = this.#cli.draft(this.#screen);
      // The user's draft is in the way; or something (a dialog) keeps the prompt from showing.
      if (draft !== undefined && draft !== '') status = 'waiting';
      else if (this.#trust) status = 'waiting';
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
        this.#firstRunDialogs();
        this.#pump();
        this.#updateStatus();
      });
    }, this.#deps.timing.settle);
  }

  // ---- Hooks.

  #hook(event: HookEvent): void {
    if (this.#exited || this.#closing) return;
    this.#pass();
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
      case 'ask':
        this.#told(signal.ask);
        return;
      case 'needs':
        this.#notified = { id: randomUUID(), text: signal.text };
        this.#list();
        return;
    }
  }

  // ---- Its first-run dialogs.

  /**
   * Reads, until its CLI is past them, whether its screen shows its folder trust dialog (listed as
   * asked) or its prompt (it is past them).
   */
  #firstRunDialogs(): void {
    if (this.#passed || !this.#pty) return;
    if (this.#cli.draft(this.#screen) !== undefined) {
      this.#pass();
      return;
    }
    const shown = this.#cli.trusting?.(this.#screen) ?? false;
    if (shown === (this.#trust !== undefined)) return;
    this.#trust = shown ? { kind: 'trust', id: randomUUID() } : undefined;
    this.#list();
  }

  /** Its CLI is past its first-run dialogs: the folder is trusted, and the others may start. */
  #pass(): void {
    if (this.#passed || this.#held) return;
    this.#passed = true;
    this.#deps.firstRun?.passed();
    if (this.#trust) {
      this.#trust = undefined;
      this.#list();
    }
  }

  // ---- What it asks the user, in its terminal.

  /** A hook told what the CLI is about to ask (once, though two hooks may tell it). */
  #told(ask: TerminalAsk): void {
    const same = (other: TerminalAsk) =>
      JSON.stringify({ ...other, id: '' }) === JSON.stringify({ ...ask, id: '' });
    if (this.#asks.some((told) => same(told.ask))) return;
    this.#asks = [...this.#asks, { ask, at: Date.now() }].slice(-MAX_ASKS);
    this.#list();
  }

  /**
   * Follows what keeps the CLI (or a task of it) waiting on the user, from its reports.
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
    this.#trust = undefined;
    this.#blocks.clear();
    this.#asks = [];
    this.#notified = undefined;
    this.#list();
  }

  /**
   * What the CLI asks the user now. While it waits on them: what its hooks told just before (or,
   * if they told nothing, what it waits for in its report's words, or its notification's, or its
   * CLI's). It may tell without waiting: what a notification says it needs. Without reports (an
   * older Claude Code), what its hooks told, until the turn ends.
   */
  #asking(): TerminalAsk[] {
    if (this.#exited) return [];
    // Its folder trust dialog comes before anything else.
    if (this.#trust) return [this.#trust];
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
      text: report.msg ?? this.#notified?.text ?? this.#cli.words.waiting[report.kind ?? 'none'],
    }));
  }

  /** Lists what the CLI asks now, if that changed. */
  #list(): void {
    const asks = this.#asking();
    const listed = JSON.stringify(asks);
    if (listed === this.#listed) return;
    this.#listed = listed;
    this.#host.emit({ type: 'asking', asks });
  }

  // ---- Usage.

  /** What its CLI gave its status line (Claude Code's): its usage limits go to main's readings. */
  #statusLine(input: HookEvent): void {
    if (this.#exited || this.#closing) return;
    const windows = this.#cli.statusLine?.(input);
    if (windows) this.#deps.usage?.(windows);
  }

  /**
   * Reads its account's usage, where its CLI reads it apart from its terminal (Codex's: a private
   * app server), as it starts and after each turn: what it says goes to main's readings.
   */
  #readUsage(): void {
    const usage = this.#deps.usage;
    if (!usage || !this.#cli.readUsage) return;
    void this.#cli.readUsage().then(
      (windows) => {
        if (windows && !this.#closing) usage(windows);
      },
      () => undefined,
    );
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
    // Gone: if it was first in the folder and never got past its first-run dialogs, the next goes.
    this.#deps.firstRun?.done();
    this.#registration?.release();
    if (this.#settingsDir !== undefined) {
      await rm(this.#settingsDir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.#screen.dispose();
  }
}

/** Text with each run of whitespace (line breaks, the prompt's wrapping) as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
