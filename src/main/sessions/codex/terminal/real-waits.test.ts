import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptEnded, PromptEvent } from '../../../../shared/model/prompts';
import type { CodexMode, SessionEvent } from '../../../../shared/session';
import type { LiveSession, SessionSpec } from '../../connector';
import { TIMING } from '../../terminal/session';
import { CodexTerminalConnector } from './connector';
import { HookTruster } from './trust';
import { recordedScreen, recordedTerminal } from './recorded';
import type { TerminalFixture } from './recorded';
import { Replay } from './replay';

/*
 * What the real Codex 0.162.1 waited on in its terminal (B13 C13, recorded against a stub of the
 * model API: recorded.ts), as a Terminal session raises it for the core's prompt owner: each
 * pseudo-terminal plays a recording back, its output and hooks in order, waiting wherever keys were
 * sent until the test sends the same keys.
 */

let dir: string;
let events: SessionEvent[];
let prompts: (PromptEvent | PromptEnded)[];
let sessions: LiveSession<CodexMode>[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-waits-'));
  events = [];
  prompts = [];
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
  mode: 'read-only',
  resume: null,
};

async function start(name: TerminalFixture) {
  const connector = new CodexTerminalConnector({
    findCodex: () => Promise.resolve('/bin/codex'),
    version: () => Promise.resolve('0.162.1'),
    truster: new HookTruster({ start: () => Promise.reject(new Error('not here')) }),
    spawn: (_file, args, options) => Promise.resolve(new Replay(name, args, options)),
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
  });
  const session = await connector.start(
    { ...SPEC },
    {
      emit: (event) => {
        if (event.type === 'prompt' || event.type === 'prompt-ended') prompts.push(event);
        else events.push(event);
      },
      remember: () => undefined,
    },
  );
  sessions.push(session);
  return session;
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 });
const ends = () => events.filter((event) => event.type === 'end').length;
const raised = () => prompts.filter((event): event is PromptEvent => event.type === 'prompt');
const detailOf = (event: PromptEvent | undefined) =>
  event?.prompt.detail?.kind === 'output' ? event.prompt.detail.text : '';
const TITLE = 'Codex needs you: see its terminal.';

describe('Codex Terminal, on what the real Codex waited on (0.162.1)', () => {
  it('raises two approvals in one turn one after the other, each with its own screen, each answered there', async () => {
    const session = await start('approvals');
    await session.send({ id: 'm1', text: 'do the thing' });
    await until(() => {
      expect(raised()).toHaveLength(1);
    });
    const [first] = raised();
    expect(first?.prompt).toMatchObject({ kind: 'approval', title: TITLE, answerIn: 'terminal' });
    expect(detailOf(first)).toContain('Would you like to run the following command?');
    expect(detailOf(first)).toContain('touch one.txt');
    // Its title blinks while it waits: nothing more is raised.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(raised()).toHaveLength(1);
    session.terminal?.input('y');
    await until(() => {
      expect(raised()).toHaveLength(2);
    });
    const [, second] = raised();
    expect(second?.key).not.toBe(first?.key);
    // Its last twelve rows hold the dialog, and above it the first approval's outcome.
    expect(detailOf(second)).toContain('$ touch two.txt');
    expect(detailOf(second)).toContain('1. Yes, proceed (y)');
    expect(detailOf(second).split('\n').at(-1)).toBe('  Press enter to confirm or esc to cancel');
    session.terminal?.input('y');
    await until(() => {
      expect(ends()).toBe(1);
    });
    expect(prompts.filter((event) => event.type === 'prompt-ended')).toEqual([
      { type: 'prompt-ended', key: first?.key, reason: 'answered-natively' },
      { type: 'prompt-ended', key: second?.key, reason: 'answered-natively' },
    ]);
  });

  it('reads Action Required at another size (60×20) from the screen as it is drawn there', async () => {
    const session = await start('approvals-small');
    session.terminal?.resize(60, 20);
    await session.send({ id: 'm1', text: 'do the thing' });
    await until(() => {
      expect(raised()).toHaveLength(1);
    });
    const [only] = raised();
    expect(detailOf(only)).toContain('touch one.txt');
    expect(detailOf(only).split('\n').length).toBeLessThanOrEqual(12);
    expect(detailOf(only)).toContain('Yes, proceed');
    session.terminal?.input('y');
    await until(() => {
      expect(ends()).toBe(1);
    });
    expect(prompts.at(-1)).toEqual({
      type: 'prompt-ended',
      key: only?.key,
      reason: 'answered-natively',
    });
  });

  it('raises its question (in Plan mode) as a wait in its own words, with its question and options on the screen', async () => {
    const session = await start('question');
    await session.send({ id: 'm0', text: '/plan' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    await session.send({ id: 'm1', text: 'do the thing' });
    await until(() => {
      expect(raised()).toHaveLength(1);
    });
    const [only] = raised();
    expect(only?.prompt).toMatchObject({ kind: 'approval', title: TITLE, answerIn: 'terminal' });
    expect(detailOf(only)).toContain('Which color should the header be?');
    expect(detailOf(only)).toContain('1. Red');
    expect(detailOf(only)).toContain('2. Blue');
    session.terminal?.input('\r');
    await until(() => {
      expect(ends()).toBe(2);
    });
    expect(prompts.at(-1)).toEqual({
      type: 'prompt-ended',
      key: only?.key,
      reason: 'answered-natively',
    });
  });

  it('sees nothing of a proposed plan’s "Implement this plan?" popup: its turn ended, its title says Ready, and no wait is raised', async () => {
    // The recording itself: the popup is on the screen at the end of the turn, with no Action
    // Required in any title.
    const all = recordedTerminal('plan');
    expect(
      all.some((record) => record.kind === 'out' && record.data.includes('Action Required')),
    ).toBe(false);
    const ended = all.find(
      (record) => record.kind === 'hook' && record.data.ev.hook_event_name === 'Stop',
    );
    const popup = await recordedScreen('plan', (ended?.t ?? 0) + 200);
    expect(popup.text()).toContain('Implement this plan?');
    // So the session ends the turn and raises nothing.
    const session = await start('plan');
    await session.send({ id: 'm0', text: '/plan' });
    await until(() => {
      expect(ends()).toBe(1);
    });
    await session.send({ id: 'm1', text: 'do the thing' });
    await until(() => {
      expect(ends()).toBe(2);
    });
    expect(prompts).toEqual([]);
  });
});
