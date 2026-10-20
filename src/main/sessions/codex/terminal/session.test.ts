import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexMode, SessionEvent } from '../../../../shared/session';
import type { UsageBackendId } from '../../../../shared/adapter';
import type { UsageWindows } from '../../../../shared/usage';
import type { LiveSession, SessionSpec } from '../../connector';
import { TIMING } from '../../terminal/session';
import { property } from '../../transcript';
import { recordedResult } from '../app-server/recorded';
import type { AppServerOptions } from '../rpc';
import { CodexTerminalConnector } from './connector';
import type { CodexTerminalConnectorOptions } from './connector';
import { computedTrust } from './hooks';
import { HookTruster } from './trust';
import { RECORDED_SESSION, RECORDED_TURNS_SESSION } from './recorded';
import type { TerminalFixture, TerminalRecord } from './recorded';
import { Replay } from './replay';
import { PASTE_END, PASTE_START } from './tui';
import { UsageReader } from './usage';

/*
 * Codex in corrallm's terminal, as the real Codex CLI 0.160.1 behaved: each pseudo-terminal plays a
 * recording (fixtures/) back to the session, its output and hooks in order and in time (sped up),
 * waiting wherever keys were sent until the session sends the same keys.
 */

let dir: string;
let events: SessionEvent[];
let remembered: string[];
let runs: Replay[];
let sessions: LiveSession<CodexMode>[];
/** What of its recordings the pseudo-terminals leave out. */
let without: (record: TerminalRecord) => boolean;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-terminal-'));
  events = [];
  remembered = [];
  runs = [];
  sessions = [];
  without = () => false;
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
async function start(
  recordings: TerminalFixture[],
  spec: Partial<SessionSpec<CodexMode>> = {},
  options: Partial<CodexTerminalConnectorOptions> = {},
) {
  const connector = new CodexTerminalConnector({
    findCodex: () => Promise.resolve('/bin/codex'),
    version: () => Promise.resolve('0.160.1'),
    // Codex is not asked: the computed trust.
    truster: new HookTruster({ start: () => Promise.reject(new Error('not here')) }),
    spawn: (_file, args, options) => {
      const run = new Replay(recordings[runs.length] ?? 'prompts', args, options, without);
      runs.push(run);
      return Promise.resolve(run);
    },
    readInstructions: () => Promise.resolve(undefined),
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
    ...options,
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
        ? `end:${event.result.status === 'cancelled' ? 'interrupted' : event.result.status === 'failed' ? 'failed' : 'done'}`
        : event.type === 'text' || event.type === 'user'
          ? `${event.type}:${event.text}`
          : event.type === 'model'
            ? `model:${event.model}`
            : event.type === 'asking'
              ? `asking:${event.asks.map((ask) => (ask.kind === 'other' ? ask.text : ask.kind)).join('|')}`
              : event.type,
  );
const ends = () => events.filter((event) => event.type === 'end').length;

describe('Codex in a terminal, as the real one ran', () => {
  it('resumes without a role without reading native instructions, even if the read would fail', async () => {
    const readInstructions = vi.fn(() => Promise.reject(new Error('Could not read config')));
    await start(['resume'], { resume: RECORDED_SESSION, roleChanged: false }, { readInstructions });
    expect(readInstructions).not.toHaveBeenCalled();
    expect(runs[0]?.args.slice(0, 2)).toEqual(['resume', RECORDED_SESSION]);
    expect(runs[0]?.args.some((arg) => arg.startsWith('developer_instructions='))).toBe(false);
    expect(events[0]).toMatchObject({ type: 'started' });
  });

  it('reconciles captured roles with current native instructions on exact-ID restart, including removal', async () => {
    const readInstructions = vi.fn(() => Promise.resolve('Native project guidance'));
    for (const { role, roleChanged } of [
      { role: 'Review changes\nUse "quotes"', roleChanged: false },
      { role: 'Updated role', roleChanged: true },
      { role: undefined, roleChanged: true },
    ]) {
      const session = await start(
        ['prompts'],
        {
          resume: RECORDED_SESSION,
          roleChanged,
          ...(role === undefined ? {} : { role }),
        },
        { readInstructions },
      );
      const run = runs.at(-1);
      const joined =
        role === undefined ? 'Native project guidance' : `Native project guidance\n\n${role}`;
      expect(run?.args).toContain(`developer_instructions=${JSON.stringify(joined)}`);
      expect(run?.args.slice(0, 2)).toEqual(['resume', RECORDED_SESSION]);
      expect(run?.written).toEqual([]);
      await session.close();
    }
    expect(readInstructions).toHaveBeenCalledTimes(3);
  });

  it('lets Codex close naturally with Ctrl+C instead of killing its pty', async () => {
    const session = await start(['prompts']);
    const run = runs.at(-1);
    if (!run) throw new Error('Codex did not start');
    run.exitOnCtrlC = true;
    const kill = vi.spyOn(run, 'kill');
    await session.close();
    expect(run.written).toContain('\x03');
    expect(kill).not.toHaveBeenCalled();
    expect(run.exited).toBe(true);
  });

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
      // Listed outside its terminal while it waits (Needs you), until the user answers there.
      'asking:Codex needs you: see its terminal.',
      'status:waiting',
      'asking:',
      'status:working',
      'text:Created [bye.txt](/work/smoke/p2/bye.txt) with the word `bye`.',
      'end:done',
    ]);
    expect(runs[0]?.written).toContain(`${PASTE_START}Say hi in one word.${PASTE_END}`);
    expect(remembered).toEqual([RECORDED_SESSION]);
  });

  it('reads Codex’s usage as it starts and after each turn, from an app server of its own', async () => {
    const asked: AppServerOptions[] = [];
    const reader = new UsageReader({
      start: (options) => {
        asked.push(options);
        return Promise.resolve({
          userAgent: 'corrallm/0.160.1',
          version: '0.160.1',
          codexHome: '/home/user/.codex',
          // What the real one answered, on a ChatGPT login.
          request: () => Promise.resolve(recordedResult('handshake', 'account/rateLimits/read')),
          notify: () => undefined,
          close: () => Promise.resolve(),
          exited: new Promise(() => undefined),
        });
      },
      now: () => 1_791_880_000_000,
    });
    const readings: [UsageBackendId, UsageWindows][] = [];
    const session = await start(
      ['prompts'],
      {},
      {
        reader,
        usage: (...reading) => readings.push(reading),
      },
    );
    await until(() => {
      expect(readings).toHaveLength(1);
    });
    expect(readings[0]).toEqual([
      'codex',
      {
        fiveHour: { usedPercent: 0, resetsAt: 1_791_896_263_000 },
        weekly: { usedPercent: 0, resetsAt: 1_792_483_063_000 },
      },
    ]);
    // The session's own `codex`, in its folder, with the agents' environment.
    expect(asked[0]).toMatchObject({ codex: '/bin/codex', cwd: '/work/smoke/p2', env: SPEC.env });

    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    await until(() => {
      expect(readings).toHaveLength(2);
    });
    // Nothing was typed into its terminal to read it: only the message.
    expect(runs[0]?.written.filter((data) => data.includes('/status'))).toEqual([]);
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
    const session = await start(['resume-missing', 'prompts'], {
      resume: '0199a3f0-1234-7000-8000-123456789abc',
      role: 'Fallback review role',
    });
    await until(() => {
      expect(runs).toHaveLength(2);
    });
    expect(runs[1]?.args[0]).toBe('--no-daemon');
    expect(
      runs.map((run) => run.args.includes('developer_instructions="Fallback review role"')),
    ).toEqual([true, true]);
    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    expect(remembered.at(-1)).toBe(RECORDED_SESSION);
  });
});

describe('a turn Codex ends without its Stop hook, as at a usage limit', () => {
  /** When the recording was made (its windows reset later). */
  const RECORDED_AT = 1_791_880_000_000;
  const FIVE_HOUR_RESET = 1_791_896_263_000;

  /** Its first turn as recorded, but for its Stop hook: Codex runs none for a turn that errs. */
  function erring(): void {
    let left = false;
    without = (record) => {
      if (left || record.kind !== 'hook' || record.data.ev.hook_event_name !== 'Stop') return false;
      left = true;
      return true;
    };
  }

  /**
   * Reads Codex's usage from an app server of its own that answers as the real one did, but with
   * its 5-hour window `used` (and its `credits`, if given).
   */
  function reader(used: number, credits?: unknown): UsageReader {
    const answer = recordedResult('handshake', 'account/rateLimits/read');
    const snapshot = property(answer, 'rateLimits') as Record<string, unknown>;
    const primary = property(snapshot, 'primary') as Record<string, unknown>;
    const rateLimits = {
      ...snapshot,
      primary: { ...primary, usedPercent: used },
      ...(credits === undefined ? {} : { credits }),
    };
    return new UsageReader({
      start: () =>
        Promise.resolve({
          userAgent: 'corrallm/0.160.1',
          version: '0.160.1',
          codexHome: '/home/user/.codex',
          request: () => Promise.resolve({ ...(answer as Record<string, unknown>), rateLimits }),
          notify: () => undefined,
          close: () => Promise.resolve(),
          exited: new Promise(() => undefined),
        }),
      now: () => RECORDED_AT,
    });
  }

  /** Sends its first message, as recorded, and its turn's end, once it came. */
  async function failedTurn(options: Partial<CodexTerminalConnectorOptions>) {
    erring();
    const session = await start(['prompts'], {}, options);
    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    return events.find((event) => event.type === 'end');
  }

  /** Its first end waits on usage while the user starts the next turn in Codex itself. */
  async function pendingEnd() {
    erring();
    const reading = Promise.withResolvers<Awaited<ReturnType<UsageReader['read']>>>();
    const entered = Promise.withResolvers<undefined>();
    const usageReader = reader(100);
    vi.spyOn(usageReader, 'read')
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => {
        entered.resolve(undefined);
        return reading.promise;
      });
    const session = await start(['prompts'], {}, { reader: usageReader, usage: () => undefined });
    await session.send({ id: 'm1', text: 'Say hi in one word.' });
    await entered.promise;
    expect(ends()).toBe(0);
    const run = runs[0];
    if (!run) throw new Error('Codex did not start');
    let output = '';
    run.onData((data) => (output += data));
    run.write(`${PASTE_START}Create a file named bye.txt containing the word bye.${PASTE_END}`);
    run.write('\r');
    await until(() => {
      expect(output).toContain('Action Required');
    });
    return { session, run, reading };
  }

  function expectOrderedTurns() {
    const firstEnd = events.findIndex((event) => event.type === 'end');
    const nextUser = events.findIndex(
      (event) => event.type === 'user' && event.text.startsWith('Create a file'),
    );
    expect(firstEnd).toBeGreaterThan(-1);
    expect(nextUser).toBeGreaterThan(firstEnd);
    // Codex may report working before its prompt hook, but only the first turn's status may
    // precede the first end. None of the next turn's events may overtake that end.
    expect(events.slice(0, firstEnd).filter((event) => event.type === 'status')).toEqual([
      { type: 'status', status: 'working' },
    ]);
    expect(events.find((event) => event.type === 'end')).toMatchObject({ messages: ['m1'] });
    expect(events.slice(firstEnd + 1)).toContainEqual({ type: 'status', status: 'working' });
  }

  it.each(['resolves', 'rejects'])(
    'emits the old end before the next native turn’s events when its usage read %s',
    async (outcome) => {
      const { run, reading } = await pendingEnd();
      if (outcome === 'rejects') reading.reject(new Error('Usage unavailable'));
      else reading.resolve({ windows: {}, usedUp: FIVE_HOUR_RESET });
      await until(() => {
        expect(ends()).toBe(1);
      });
      expectOrderedTurns();
      expect(events.find((event) => event.type === 'end')).toMatchObject({
        result:
          outcome === 'rejects'
            ? { status: 'failed', reason: 'error' }
            : { status: 'failed', reason: 'usage-limit', resetsAt: FIVE_HOUR_RESET },
      });
      run.write('y');
      await until(() => {
        expect(ends()).toBe(2);
      });
      const nativeUser = events.find(
        (event) => event.type === 'user' && event.text.startsWith('Create a file'),
      );
      expect(events.filter((event) => event.type === 'end')[1]).toMatchObject({
        messages: nativeUser?.type === 'user' ? [nativeUser.id] : [],
        result: { status: 'completed', reason: 'completed' },
      });
    },
  );

  it('never holds the next turn past its own end or emits a late duplicate when usage stays pending', async () => {
    const { run, reading } = await pendingEnd();
    run.write('y');
    await until(() => {
      expect(ends()).toBe(2);
    });
    expectOrderedTurns();
    expect(
      events.filter((event) => event.type === 'end').map((event) => event.result.reason),
    ).toEqual(['error', 'completed']);
    reading.resolve({ windows: {}, usedUp: FIVE_HOUR_RESET });
    await reading.promise;
    await new Promise(setImmediate);
    expect(ends()).toBe(2);
  });

  it('keeps the pending end when the session closes before its usage read finishes', async () => {
    const { session, reading } = await pendingEnd();
    await session.close();
    expect(ends()).toBe(1);
    expectOrderedTurns();
    reading.reject(new Error('Usage unavailable after close'));
    await new Promise(setImmediate);
    expect(ends()).toBe(1);
  });

  it('failed on its plan’s usage limit, until it resets, where its usage read then is used up', async () => {
    const readings: [UsageBackendId, UsageWindows][] = [];
    const end = await failedTurn({
      reader: reader(100),
      usage: (...reading) => readings.push(reading),
    });
    expect(end).toMatchObject({
      messages: ['m1'],
      result: { status: 'failed', reason: 'usage-limit', resetsAt: FIVE_HOUR_RESET },
    });
    // What it went by is the backend's reading too: read as it started, and once as the turn ended.
    expect(readings).toHaveLength(2);
    expect(readings[1]).toEqual([
      'codex',
      {
        fiveHour: { usedPercent: 100, resetsAt: FIVE_HOUR_RESET },
        weekly: { usedPercent: 0, resetsAt: 1_792_483_063_000 },
      },
    ]);
  });

  it('failed for a reason corrallm can’t tell, where its usage has room or credits to go on', async () => {
    expect(await failedTurn({ reader: reader(40) })).toMatchObject({
      result: { status: 'failed', reason: 'error' },
    });
    events = [];
    expect(
      await failedTurn({
        reader: reader(100, { hasCredits: true, unlimited: false, balance: '25' }),
      }),
    ).toMatchObject({ result: { status: 'failed', reason: 'error' } });
    expect(events.find((event) => event.type === 'end')).not.toHaveProperty('result.resetsAt');
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

  it('starts Codex with the model and reasoning effort the agent is set to', async () => {
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
