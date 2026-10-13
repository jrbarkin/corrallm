import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexMode, SessionEvent } from '../../../shared/session';
import type { LiveSession, SessionSpec } from '../connector';
import type { Launch, TerminalCli, TerminalSignal } from './cli';
import { HOOK_TOKEN, HookServer } from './hooks';
import type { HookEvent, HookRegistration } from './hooks';
import type { Pty, PtyOptions } from './pty';
import type { Screen } from './screen';
import { TerminalSession, TIMING } from './session';
import type { ProgramStatus } from './status';

/*
 * The Terminal session is not Claude Code's alone: any CLI with a TerminalCli runs on it. Here, a
 * CLI shaped like Codex's interactive one (its state in its window title, its own session ids,
 * told by its hooks; messages pasted in), faked at the pseudo-terminal.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const title = (text: string) => `\x1b]0;${text}\x07`;

/** A CLI that reports its state in its title and tells its session's id by its hooks. */
class TitledCli implements TerminalCli<CodexMode> {
  readonly name = 'Titled';
  readonly words = {
    answer: 'Answer it in its terminal.',
    mode: 'Use /permissions in its terminal.',
    model: 'Use /model in its terminal.',
    login: 'Log in in its terminal.',
  };
  /** Its prompt shows only when drawn: its title does not cover its pickers. */
  readonly waitsForPrompt = true;
  /** Where its hooks post, once prepared. */
  hooks: HookRegistration | undefined;
  /** Whether the turn it works on ended with a Stop hook (else it failed, when it goes Ready). */
  #stopped = false;
  #ran = false;
  #starting = false;

  newId(): null {
    return null;
  }

  prepare(_dir: string, hooks: HookRegistration): Promise<void> {
    this.hooks = hooks;
    return Promise.resolve();
  }

  args({ id, resume }: Launch<CodexMode>): string[] {
    return resume && id !== null ? ['resume', id] : [];
  }

  resumeFailed(screen: string): boolean {
    return screen.includes('No saved session found');
  }

  holds(): boolean {
    return this.#starting;
  }

  title(text: string): ProgramStatus | undefined {
    this.#starting = text.endsWith('Starting');
    if (text.includes('Action Required')) return { state: 'blocked', kind: 'permission' };
    if (text.includes('Working')) {
      this.#ran = true;
      return { state: 'working' };
    }
    if (text !== 'Ready') return undefined;
    const ran = this.#ran;
    const stopped = this.#stopped;
    this.#ran = false;
    this.#stopped = false;
    if (!ran || stopped) return { state: ran ? 'done' : 'idle' };
    return { state: 'error', msg: 'It stopped without finishing.' };
  }

  hook(event: HookEvent): TerminalSignal<CodexMode>[] {
    const signals: TerminalSignal<CodexMode>[] = [];
    if (typeof event.session_id === 'string')
      signals.push({ kind: 'session', id: event.session_id });
    if (event.hook_event_name === 'UserPromptSubmit' && typeof event.prompt === 'string') {
      signals.push({ kind: 'prompt', text: event.prompt });
    }
    if (event.hook_event_name === 'Stop') {
      this.#stopped = true;
      if (typeof event.last_assistant_message === 'string') {
        signals.push({ kind: 'reply', text: event.last_assistant_message });
      }
    }
    return signals;
  }

  draft(screen: Screen): string | undefined {
    const line = screen
      .text()
      .split('\n')
      .find((row) => row.startsWith('›'));
    return line?.slice(1).trim();
  }

  keystrokes(text: string): string[] {
    return [`${PASTE_START}${text}${PASTE_END}`];
  }

  submitted(text: string): string {
    return text.trim();
  }
}

/** The fake CLI, at the pseudo-terminal: posts its hooks to `url`, as its session `id`. */
class FakeTitled implements Pty {
  readonly pid = 77;
  readonly written: string[] = [];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  #draft = '';
  #asking = false;
  /** A picker is open (as Codex's /model): its prompt is not drawn. */
  picking = false;
  /** Its servers are starting: a prompt submitted waits for them. */
  #starting = false;
  #held: string | undefined;
  exited = false;
  readonly args: readonly string[];
  readonly options: PtyOptions;
  readonly url: () => string;
  readonly id: string;

  constructor(
    args: readonly string[],
    options: PtyOptions,
    url: () => string,
    id: string,
    starting = 0,
  ) {
    this.args = args;
    this.options = options;
    this.url = url;
    this.id = id;
    setTimeout(() => {
      const resume = args[0] === 'resume' ? args[1] : undefined;
      if (resume !== undefined && resume !== id) {
        this.print(`ERROR: No saved session found with ID ${resume}.\r\n`);
        this.exit(1);
        return;
      }
      this.print(title('Ready'));
      this.#draw();
      if (starting > 0) {
        this.#starting = true;
        this.print(title('⠋ Starting'));
        setTimeout(() => {
          this.#starting = false;
          const held = this.#held;
          this.#held = undefined;
          if (held === undefined) this.print(title('Ready'));
          else void this.#run(held);
        }, starting);
      }
    }, 1);
  }

  print(data: string): void {
    if (!this.exited) for (const listener of this.#data) listener(data);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.#exit) listener({ exitCode: code });
  }

  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }

  onExit(listener: (exit: { exitCode: number }) => void): void {
    this.#exit.add(listener);
  }

  resize(): void {
    // Nothing to redraw.
  }

  kill(): void {
    this.exit(0);
  }

  write(data: string): void {
    this.written.push(data);
    // A picker takes what is typed while it is open.
    if (this.picking) return;
    if (data.startsWith(PASTE_START)) {
      this.#draft += data.slice(PASTE_START.length, -PASTE_END.length);
    } else if (data === 'y' && this.#asking) {
      this.#asking = false;
      void this.#finish();
    } else if (data === '\r') void this.#submit();
    else if (!data.startsWith('\x1b')) this.#draft += data;
    this.#draw();
  }

  async hook(name: string, fields: Record<string, unknown> = {}): Promise<void> {
    await fetch(this.url(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.env[HOOK_TOKEN] ?? ''}` },
      body: JSON.stringify({ session_id: this.id, hook_event_name: name, ...fields }),
    });
  }

  #draw(): void {
    const prompt = this.picking ? '  Select a model' : `› ${this.#draft}`;
    this.print(`\x1b[H\x1b[2J Titled (fake)\r\n\r\n${prompt}\r\n`);
  }

  /** Closes its picker (as Escape would). */
  closePicker(): void {
    this.picking = false;
    this.#draw();
  }

  async #submit(): Promise<void> {
    const prompt = this.#draft;
    if (prompt === '') return;
    this.#draft = '';
    this.#draw();
    if (this.#starting) this.#held = prompt;
    else await this.#run(prompt);
  }

  async #run(prompt: string): Promise<void> {
    this.print(title('⠋ Working'));
    await this.hook('UserPromptSubmit', { prompt });
    if (prompt.startsWith('ask')) {
      this.#asking = true;
      this.print(title('[ ! ] Action Required'));
      return;
    }
    if (prompt.startsWith('fail')) {
      // A usage limit, say: no Stop hook.
      setTimeout(() => {
        this.print(title('Ready'));
      }, 5);
      return;
    }
    setTimeout(() => void this.#finish(), 5);
  }

  async #finish(): Promise<void> {
    this.print(title('⠙ Working'));
    await this.hook('Stop', { last_assistant_message: 'Done' });
    this.print(title('Ready'));
  }
}

let dir: string;
let hooks: HookServer;
let events: SessionEvent[];
let remembered: string[];
let runs: FakeTitled[];
let sessions: TerminalSession<CodexMode>[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-titled-'));
  hooks = new HookServer();
  events = [];
  remembered = [];
  runs = [];
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await rm(dir, { recursive: true, force: true });
});

const SPEC: SessionSpec<CodexMode> = {
  agentId: 'a',
  cwd: '/work/app',
  env: { PATH: '/usr/bin' },
  model: null,
  mode: 'auto',
  resume: null,
};

async function start(
  spec: Partial<SessionSpec<CodexMode>> = {},
  id = 'thread-1',
  { starting = 0 }: { starting?: number } = {},
) {
  const cli = new TitledCli();
  const session = new TerminalSession<CodexMode>(
    { ...SPEC, ...spec },
    { emit: (event) => events.push(event), remember: (sessionId) => remembered.push(sessionId) },
    {
      executable: '/bin/titled',
      cli,
      spawn: (_file, args, options) => {
        const run = new FakeTitled(args, options, () => cli.hooks?.url ?? '', id, starting);
        runs.push(run);
        return Promise.resolve(run);
      },
      hooks,
      tmp: dir,
      env: (token) => ({ ...SPEC.env, [HOOK_TOKEN]: token }),
      timing: {
        ...TIMING,
        key: 0,
        enter: 1,
        confirm: 500,
        settle: 5,
        startup: 120,
        batch: 1,
        kill: 200,
      },
    },
  );
  await session.launch();
  sessions.push(session);
  return session;
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 5 });
const last = <T extends SessionEvent['type']>(type: T) =>
  events.findLast((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
const seen = () =>
  events.map((event) =>
    event.type === 'status'
      ? `status:${event.status}`
      : event.type === 'end'
        ? `end:${event.interrupted ? 'interrupted' : event.failed ? 'failed' : 'done'}`
        : event.type === 'text' || event.type === 'user'
          ? `${event.type}:${event.text}`
          : event.type === 'notice'
            ? `notice:${event.text}`
            : event.type,
  );

describe('a Terminal session of another CLI', () => {
  it('remembers the session id only once the CLI’s hooks tell it', async () => {
    const session = await start();
    expect(remembered).toEqual([]);
    expect(events[0]).toEqual({ type: 'started', model: null, mode: 'auto', models: [] });
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(remembered).toEqual(['thread-1']);
  });

  it('pastes a message in, follows the turn by its title, and ends it with its last reply', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'Hello\nthere' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(runs[0]?.written).toContain(`${PASTE_START}Hello\nthere${PASTE_END}`);
    expect(seen().slice(1)).toEqual([
      'user:Hello\nthere',
      'status:working',
      'text:Done',
      'end:done',
    ]);
  });

  it('waits on the user while its title says it needs them', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'ask first' });
    await until(() => {
      expect(seen()).toContain('status:waiting');
    });
    session.terminal.input('y');
    await until(() => {
      expect(last('end')).toMatchObject({ interrupted: false, failed: false });
    });
  });

  it('ends a turn that stops without finishing as failed, saying why', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'fail now' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen()).toContain('notice:It stopped without finishing.');
    expect(last('end')).toMatchObject({ failed: true });
  });

  it('waits for a message it holds while it starts, however long that takes', async () => {
    // Longer than the CLI may take to take a message (twice `confirm`).
    const session = await start({}, 'thread-1', { starting: 1300 });
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen().slice(1)).toEqual(['user:Hello', 'status:working', 'text:Done', 'end:done']);
  });

  it('types only into its prompt as drawn, though its title says it is ready', async () => {
    const session = await start();
    const run = runs[0];
    if (!run) throw new Error('not started');
    run.picking = true;
    run.print(' ');
    await session.send({ id: 'm1', text: 'Hello' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(run.written.some((data) => data.includes('Hello'))).toBe(false);
    // Once the picker closes, the message goes in.
    run.closePicker();
    await until(() => {
      expect(last('end')).toMatchObject({ interrupted: false, failed: false });
    });
    expect(run.written).toContain(`${PASTE_START}Hello${PASTE_END}`);
  });

  it('starts afresh when the session it resumes is gone, in its own words', async () => {
    const session = await start({ resume: 'gone' });
    await until(() => {
      expect(runs).toHaveLength(2);
    });
    expect(runs.map((run) => run.args)).toEqual([['resume', 'gone'], []]);
    const live: LiveSession<CodexMode> = session;
    await expect(live.setMode('read-only')).rejects.toThrow('Use /permissions in its terminal.');
    runs[1]?.exit(2);
    await until(() => {
      expect(last('closed')).toEqual({ type: 'closed', error: 'Titled exited with code 2.' });
    });
  });
});
