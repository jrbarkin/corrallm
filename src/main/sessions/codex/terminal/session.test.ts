import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexMode, SessionEvent } from '../../../../shared/session';
import type { LiveSession, SessionSpec } from '../../connector';
import { HOOK_TOKEN } from '../../terminal/hooks';
import type { Pty, PtyOptions } from '../../terminal/pty';
import { TIMING } from '../../terminal/session';
import { CodexTerminalConnector } from './connector';
import { computedTrust } from './hooks';
import { HookTruster } from './trust';
import { RECORDED_SESSION, RECORDED_TURNS_SESSION, recordedTerminal } from './recorded';
import type { TerminalFixture, TerminalRecord } from './recorded';
import { PASTE_END, PASTE_START } from './tui';

/*
 * Codex in corrallm's terminal, as the real Codex CLI 0.160.1 behaved: each pseudo-terminal plays a
 * recording (fixtures/) back to the session, its output and hooks in order and in time (sped up),
 * waiting wherever keys were sent until the session sends the same keys.
 */

/** How much faster than recorded a recording plays. */
const SPEED = 50;

/** A pseudo-terminal that plays a recording of Codex's TUI. */
class Replay implements Pty {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly args: readonly string[];
  readonly options: PtyOptions;
  readonly #records: TerminalRecord[];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  /** Writes not yet matched against the keys the recording waits for. */
  #unread: string[] = [];
  #wake: (() => void) | undefined;
  exited = false;

  constructor(name: TerminalFixture, args: readonly string[], options: PtyOptions) {
    this.#records = recordedTerminal(name);
    this.args = args;
    this.options = options;
    void this.#play();
  }

  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }

  onExit(listener: (exit: { exitCode: number }) => void): void {
    this.#exit.add(listener);
  }

  write(data: string): void {
    this.written.push(data);
    this.#unread.push(data);
    this.#wake?.();
  }

  resize(): void {
    // A recording does not redraw.
  }

  kill(): void {
    this.#end(0);
  }

  #end(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.#wake?.();
    for (const listener of this.#exit) listener({ exitCode: code });
  }

  /** The hooks' server, as its command line says (the URL in its hooks' command). */
  #url(): string {
    return /http:\/\/127\.0\.0\.1:\d+\/hook/.exec(this.args.join(' '))?.[0] ?? '';
  }

  async #play(): Promise<void> {
    let previous = 0;
    for (const record of this.#records) {
      if (this.exited) return;
      await new Promise((resolve) => setTimeout(resolve, (record.t - previous) / SPEED));
      previous = record.t;
      switch (record.kind) {
        case 'out':
          for (const listener of this.#data) listener(record.data);
          break;
        case 'in':
          await this.#keys(record.data === '\\r' ? '\r' : record.data);
          break;
        case 'hook':
          // Codex waits for its hooks before it goes on.
          await fetch(this.#url(), {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.options.env[HOOK_TOKEN] ?? ''}` },
            body: JSON.stringify(record.data.ev),
          });
          break;
        case 'exit':
          this.#end(record.data.exitCode);
          return;
        default:
          break;
      }
    }
  }

  /** Waits until the session sends `keys` (text is pasted). */
  async #keys(keys: string): Promise<void> {
    for (;;) {
      const at = this.#unread.findIndex(
        (data) => data === keys || data === `${PASTE_START}${keys}${PASTE_END}`,
      );
      if (at !== -1) {
        this.#unread = this.#unread.slice(at + 1);
        return;
      }
      if (this.exited) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

let dir: string;
let events: SessionEvent[];
let remembered: string[];
let runs: Replay[];
let sessions: LiveSession<CodexMode>[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-terminal-'));
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
  cwd: '/work/smoke/p2',
  env: { PATH: '/usr/bin', CODEX_THREAD_ID: 'outer' },
  model: null,
  mode: 'auto',
  resume: null,
};

/** Starts a session whose pseudo-terminals play `recordings`, one per process, in turn. */
async function start(recordings: TerminalFixture[], spec: Partial<SessionSpec<CodexMode>> = {}) {
  const connector = new CodexTerminalConnector({
    findCodex: () => Promise.resolve('/bin/codex'),
    version: () => Promise.resolve('0.160.1'),
    // Codex is not asked: the computed trust.
    truster: new HookTruster({ start: () => Promise.reject(new Error('not here')) }),
    spawn: (_file, args, options) => {
      const run = new Replay(recordings[runs.length] ?? 'prompts', args, options);
      runs.push(run);
      return Promise.resolve(run);
    },
    tmp: dir,
    timing: {
      ...TIMING,
      key: 0,
      enter: 20,
      confirm: 400,
      settle: 5,
      startup: 2000,
      batch: 1,
      kill: 200,
    },
  });
  const session = await connector.start(
    { ...SPEC, ...spec },
    { emit: (event) => events.push(event), remember: (id) => remembered.push(id) },
  );
  sessions.push(session);
  return session;
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 });
const seen = () =>
  events.map((event) =>
    event.type === 'status'
      ? `status:${event.status}`
      : event.type === 'end'
        ? `end:${event.interrupted ? 'interrupted' : event.failed ? 'failed' : 'done'}`
        : event.type === 'text' || event.type === 'user'
          ? `${event.type}:${event.text}`
          : event.type === 'model'
            ? `model:${event.model}`
            : event.type,
  );
const ends = () => events.filter((event) => event.type === 'end').length;

describe('Codex in a terminal, as the real one ran', () => {
  it('pastes the queue’s messages in, follows its turns and an approval, and hears each end', async () => {
    const session = await start(['prompts']);
    expect(runs[0]?.args.slice(0, 3)).toEqual(['--no-daemon', '-C', '/work/smoke/p2']);
    expect(runs[0]?.options).toMatchObject({ cwd: '/work/smoke/p2' });
    expect(runs[0]?.options.env).toMatchObject({ TERM: 'xterm-256color', PATH: '/usr/bin' });
    expect(runs[0]?.options.env.CODEX_THREAD_ID).toBeUndefined();

    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    expect(remembered).toEqual([RECORDED_SESSION]);

    await session.send({ id: 'm2', text: 'Create a file named bye.txt containing the word bye.' });
    await until(() => {
      expect(seen().at(-1)).toBe('status:waiting');
    });
    session.terminal?.input('y');
    await until(() => {
      expect(ends()).toBe(2);
    });
    expect(seen()).toEqual([
      'started',
      'user:Say hi in one word.',
      'status:working',
      'model:gpt-6-luna',
      'text:Hi',
      'end:done',
      'user:Create a file named bye.txt containing the word bye.',
      'status:working',
      'status:waiting',
      'status:working',
      'text:Created [bye.txt](/work/smoke/p2/bye.txt) with the word `bye`.',
      'end:done',
    ]);
    expect(runs[0]?.written).toContain(`${PASTE_START}Say hi in one word.${PASTE_END}`);
    expect(remembered).toEqual([RECORDED_SESSION]);
  });

  it('hears an approval asked and an interrupt, as corrallm’s own session of it went', async () => {
    const session = await start(['turns'], { mode: 'read-only', cwd: '/work/smoke/term1' });
    expect(runs[0]?.args.slice(-4)).toEqual(['-s', 'read-only', '-a', 'on-request']);
    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    await session.send({ id: 'm2', text: 'Create a file named hi.txt containing the word hi.' });
    await until(() => {
      expect(seen().at(-1)).toBe('status:waiting');
    });
    session.terminal?.input('y');
    await until(() => {
      expect(ends()).toBe(2);
    });
    await session.send({
      id: 'm3',
      text: 'Write the numbers from 1 to 400, one per line, as plain text.',
    });
    // Once it has started on it (its UserPromptSubmit hook), Escape.
    await until(() => {
      expect(runs[0]?.written.filter((data) => data === '\r')).toHaveLength(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.interrupt();
    await until(() => {
      expect(ends()).toBe(3);
    });
    expect(seen().slice(-3)).toEqual([
      'user:Write the numbers from 1 to 400, one per line, as plain text.',
      'status:working',
      'end:interrupted',
    ]);
    expect(seen().filter((event) => event.startsWith('end:'))).toEqual([
      'end:done',
      'end:done',
      'end:interrupted',
    ]);
    expect(remembered).toEqual([RECORDED_TURNS_SESSION]);
  });

  it('resumes the agent’s session', async () => {
    await start(['resume'], { resume: RECORDED_SESSION });
    expect(runs[0]?.args.slice(0, 3)).toEqual(['resume', RECORDED_SESSION, '--no-daemon']);
    expect(remembered).toEqual([RECORDED_SESSION]);
    expect(seen()).toEqual(['started']);
  });

  it('starts afresh when the session it resumes is gone', async () => {
    const session = await start(['resume-missing', 'prompts'], { resume: 'gone' });
    await until(() => {
      expect(runs).toHaveLength(2);
    });
    expect(runs[1]?.args[0]).toBe('--no-daemon');
    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    expect(remembered.at(-1)).toBe(RECORDED_SESSION);
  });
});

describe('the Codex Terminal connector', () => {
  it('refuses a Codex older than the one corrallm knows', async () => {
    const connector = new CodexTerminalConnector({
      findCodex: () => Promise.resolve('/bin/codex'),
      version: () => Promise.resolve('0.150.0'),
      spawn: () => Promise.reject(new Error('not started')),
    });
    await expect(
      connector.start(SPEC, { emit: () => undefined, remember: () => undefined }),
    ).rejects.toThrow('corrallm needs Codex 0.160.0 or later');
  });

  it('starts Codex with the reasoning effort chosen for the agent (on its App Server, say)', async () => {
    await start(['resume'], { resume: RECORDED_SESSION, model: 'gpt-6-luna', effort: 'high' });
    expect(runs[0]?.args).toContain('model_reasoning_effort="high"');
    expect(runs[0]?.args.slice(-2)).toEqual(['-m', 'gpt-6-luna']);
  });

  it('trusts its hooks as Codex computes their trust', async () => {
    await start(['resume'], { resume: RECORDED_SESSION });
    const state = runs[0]?.args.find((arg) => arg.startsWith('hooks.state='));
    const url = /http:\/\/127\.0\.0\.1:\d+\/hook/.exec(runs[0]?.args.join(' ') ?? '')?.[0] ?? '';
    const { sessionHooks } = await import('./hooks');
    for (const [key, hash] of computedTrust(sessionHooks(url))) {
      expect(state).toContain(`${JSON.stringify(key)}={trusted_hash="${hash}"}`);
    }
  });
});
