import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppServerConnector } from '../sessions/codex/app-server/connector';
import type { PlanConsent } from '../sessions/codex/login';
import { delegate } from './delegate';
import type { Task } from './delegate';

/** A fake `codex` that speaks the app server's protocol (sessions/codex/fake-codex.mjs). */
const FAKE = fileURLToPath(new URL('../sessions/codex/fake-codex.mjs', import.meta.url));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-delegate-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The App Server connector, running the fake with `env` added. */
function connector(env: Record<string, string> = {}, consent?: PlanConsent) {
  return new AppServerConnector({
    clientApp: 'corrallm/0.1.0',
    findCodex: () => Promise.resolve('/home/me/.local/bin/codex'),
    spawn: (_codex, args, options) =>
      spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, ...env } }),
    home: '/home/me',
    ...(consent === undefined ? {} : { consent }),
  });
}

function task(text: string, more: Partial<Task> = {}): Task {
  return {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', FAKE_CODEX_STATE: path.join(dir, 'threads.json') },
    text,
    resume: null,
    model: null,
    effort: null,
    mode: 'auto',
    yes: false,
    timeoutMs: 10_000,
    ...more,
  };
}

const ALLOWED: PlanConsent = { given: () => Promise.resolve(true), give: () => Promise.resolve() };

describe('delegate', () => {
  it("runs one turn of a new Codex thread, and reports its reply and the thread's id", async () => {
    const lines: string[] = [];
    const done = await delegate(connector(), task('hello'), (line) => lines.push(line));
    expect(done).toMatchObject({
      outcome: 'completed',
      reply: 'You said: hello',
      model: 'gpt-6.1-sol',
      result: { status: 'completed' },
    });
    expect(done.thread).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines[0]).toMatch(/^Codex gpt-6\.1-sol/);
  });

  it('continues a thread it is given, as a later turn of the same conversation', async () => {
    const first = await delegate(connector(), task('hello'), () => undefined);
    const again = await delegate(
      connector(),
      task('and again', { resume: first.thread }),
      () => undefined,
    );
    expect(again).toMatchObject({ outcome: 'completed', thread: first.thread });
    expect(again.reply).toBe('You said: and again');
  });

  it('stops where Codex asks to leave its sandbox, saying what it asked', async () => {
    const lines: string[] = [];
    const done = await delegate(connector(), task('run the tests', { mode: 'read-only' }), (line) =>
      lines.push(line),
    );
    expect(done.outcome).toBe('asked');
    expect(done.asked).toContain('npm test');
    expect(lines.some((line) => line.includes('npm test'))).toBe(true);
  });

  it('approves what Codex asks to run when told yes ahead', async () => {
    const lines: string[] = [];
    const done = await delegate(
      connector(),
      task('run the tests', { mode: 'read-only', yes: true }),
      (line) => lines.push(line),
    );
    expect(done.outcome).toBe('completed');
    expect(done).not.toHaveProperty('asked');
    expect(lines).toContain('✓ exec_command npm test');
  });

  it('stops at a question Codex asks, saying what it asked', async () => {
    const done = await delegate(connector(), task('ask me'), () => undefined);
    expect(done.outcome).toBe('asked');
    expect(done.asked).toMatch(/\?/);
  });

  it('reports a failed turn with its reason', async () => {
    const done = await delegate(connector(), task('fail now'), () => undefined);
    expect(done).toMatchObject({ outcome: 'failed', result: { status: 'failed' } });
    expect(done.notices.join('\n')).not.toBe('');
  });

  it('interrupts a turn that takes longer than it may', async () => {
    const done = await delegate(connector(), task('slow', { timeoutMs: 300 }), () => undefined);
    expect(done.outcome).toBe('timed out');
  });

  it('stops when told to, interrupting the turn', async () => {
    const stop = new AbortController();
    const going = delegate(
      connector(),
      task('slow'),
      (line) => {
        if (line.includes('sleep')) stop.abort();
      },
      stop.signal,
    );
    await expect(going).resolves.toMatchObject({ outcome: 'stopped' });
  });

  it("asks before using a ChatGPT plan, and uses it once it's allowed", async () => {
    const chatgpt = { FAKE_CODEX_LOGIN: 'chatgpt' };
    const asked = await delegate(connector(chatgpt), task('hello'), () => undefined);
    expect(asked.outcome).toBe('asked');
    expect(asked.asked).toContain('ChatGPT plan');
    const allowed = await delegate(connector(chatgpt, ALLOWED), task('hello'), () => undefined);
    expect(allowed).toMatchObject({ outcome: 'completed', reply: 'You said: hello' });
  });

  it('rejects when Codex does not start, saying why', async () => {
    await expect(
      delegate(connector({ FAKE_CODEX_FAIL: 'no codex here' }), task('hello'), () => undefined),
    ).rejects.toThrow();
  });
});
