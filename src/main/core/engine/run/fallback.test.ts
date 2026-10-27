import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionId } from '../../../../shared/adapter';
import type { AgentNode } from '../../../../shared/model/canvas';
import type { QueueItem } from '../../../../shared/model/queue';
import type { TurnResult } from '../../../../shared/session';
import type { Admission, AdmittedWork, RunIO } from './runner';
import { expectRestorable } from './test-restore';
import { manual, setup } from './test-run';

/*
 * The run's half of B11a's fallback (C3, C5): admission before a task's attempt goes to its
 * recipient, a fallback rule read against that recipient's backend, a task held on its usage limit
 * admitted again as the run moves, and corrallm's own continue once a switch is committed. What
 * admission decides is the core's fallback service's (src/main/core/fallback.ts): here, the test's.
 */

afterEach(expectRestorable);

const agent = (
  id: string,
  queue: QueueItem[] = [],
  connection: ConnectionId = 'claude-code.terminal',
): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, adapter: connection.slice(0, connection.indexOf('.')), connection, queue },
});
const LIMIT: TurnResult = { status: 'failed', reason: 'usage-limit', message: 'Usage limit.' };
const HOUR = 60 * 60_000;
const fiveHour = (used: number) => ({ fiveHour: { usedPercent: used, resetsAt: 2 * HOUR } });
const FALLBACK = { window: 'fiveHour', percent: 80, action: 'fallback' } as const;

/** Admission as the test says it, recording whom it was asked about and for what. */
function admission(initial: Admission = 'go') {
  let says = initial;
  const admit = vi.fn<NonNullable<RunIO['admit']>>(() => says);
  return {
    admit,
    say: (next: Admission) => {
      says = next;
    },
    asked: (): [string, AdmittedWork][] => admit.mock.calls.map(([to, work]) => [to, work]),
  };
}

describe('admission before a task’s attempt goes (B11a C3)', () => {
  it('holds the task unsent while corrallm switches its recipient, then sends it', () => {
    const gate = admission('switching');
    const run = setup([agent('a', [{ id: 'one', message: 'Do it' }])], manual, new Set(), gate);
    run.store.start();
    expect(run.sent).toEqual([]);
    expect(run.where()).toEqual({ a: 'waiting one' });
    expect(gate.asked()).toContainEqual(['a', {}]);
    // Asked again as the run moves, it says the same: nothing changes.
    run.store.admissionChanged();
    expect(run.sent).toEqual([]);
    gate.say('go');
    run.store.admissionChanged();
    expect(run.sent.map(({ agent, text }) => [agent, text])).toEqual([['a', 'Do it']]);
    expect(run.where()).toEqual({ a: 'running one' });
    expect(run.store.snapshot().agents.a?.attempts?.one).toHaveLength(1);
  });

  it('asks about a message item’s recipient, whose backend it would spend', () => {
    const gate = admission();
    const run = setup(
      [agent('a', [{ id: 'hand', message: 'Review this', target: 'b' }]), agent('b')],
      manual,
      new Set(),
      gate,
    );
    run.store.start();
    expect(gate.asked().map(([to]) => to)).toEqual(['b']);
    expect(run.sent.map(({ agent }) => agent)).toEqual(['b']);
  });

  it('never asks while the recipient is paused, nor for work the run doesn’t send', () => {
    const gate = admission('switching');
    const run = setup([agent('a', [{ id: 'one', message: 'Do it' }])], manual, new Set(), gate);
    run.store.pauseAgent('a');
    run.store.start();
    expect(gate.admit).not.toHaveBeenCalled();
    expect(run.sent).toEqual([]);
  });
});

describe('the fallback rule (B11a C3)', () => {
  it('passes the recipient’s hold to admission: a switch holds, an ask asks, a preview goes', () => {
    for (const [says, where, sent] of [
      ['switching', 'waiting one', 0],
      ['ask', 'asking one', 0],
      // A simulated reading only previews the switch: the task goes as it is.
      ['go', 'running one', 1],
    ] as const) {
      const gate = admission(says);
      const run = setup([agent('a', [{ id: 'one', message: 'Do it' }])], manual, new Set(), gate);
      run.rule(FALLBACK);
      run.reading(fiveHour(90));
      run.store.start();
      expect(gate.asked()).toContainEqual([
        'a',
        {
          rule: {
            backend: 'claude-code',
            window: 'fiveHour',
            percent: 80,
            used: 90,
            resetsAt: 2 * HOUR,
          },
        },
      ]);
      expect(run.where()).toEqual({ a: where });
      expect(run.sent).toHaveLength(sent);
      if (says === 'ask') expect(run.store.snapshot().agents.a?.usage).toMatchObject({ used: 90 });
    }
  });

  it('asks, keeping Go on and Wait memory, where no switching service is composed', () => {
    const run = setup(
      [
        agent('a', [
          { id: 'one', message: 'One' },
          { id: 'two', message: 'Two' },
        ]),
      ],
      manual,
    );
    run.rule(FALLBACK);
    run.reading(fiveHour(90));
    expect(run.store.usageRule('a')?.action).toBe('fallback');
    run.store.start();
    expect(run.where()).toEqual({ a: 'asking one' });
    run.store.decide('a', 'one', { choice: 'wait' });
    expect(run.store.usageRule('a')?.action).toBe('waitForReset');
    expect(run.where()).toEqual({ a: 'waiting one' });
    run.store.goOn('a', 'one');
    expect(run.store.usageRule('a')).toBeUndefined();
    expect(run.where()).toEqual({ a: 'running one' });
  });

  it('is read against the recipient alone: the owner’s fallback rule holds no hand-off elsewhere', () => {
    const gate = admission();
    const run = setup(
      [
        agent('a', [{ id: 'hand', message: 'Review this', target: 'b' }]),
        agent('b', [], 'codex.terminal'),
      ],
      manual,
      new Set(),
      gate,
    );
    // Claude's rule says fall back; Codex, which b spends, has none.
    run.rule(FALLBACK);
    run.reading(fiveHour(90));
    run.store.start();
    expect(gate.asked()).toEqual([['b', {}]]);
    expect(run.where()).toEqual({ a: 'running hand', b: 'done' });
  });

  it('keeps warn, ask and wait on the queue owner’s backend, as built', () => {
    const gate = admission();
    const run = setup(
      [
        agent('a', [{ id: 'hand', message: 'Review this', target: 'b' }]),
        agent('b', [], 'codex.terminal'),
      ],
      manual,
      new Set(),
      gate,
    );
    run.rule({ ...FALLBACK, action: 'ask' });
    run.reading(fiveHour(90));
    run.store.start();
    expect(run.where()).toEqual({ a: 'asking hand', b: 'done' });
    expect(run.sent).toEqual([]);
  });
});

describe('a task held on its usage limit (B11a C3, C5)', () => {
  it('says what the chain did beside the limit, and is admitted again as the run moves', () => {
    const gate = admission();
    const limitNote = vi.fn<NonNullable<RunIO['limitNote']>>(
      () => 'Its fallback chain didn’t act: corrallm can’t tell when this limit ends.',
    );
    const run = setup([agent('a', [{ id: 'one', message: 'Do it' }])], manual, new Set(), {
      ...gate,
      limitNote,
    });
    run.store.start();
    gate.admit.mockClear();
    run.reply('a', true, '', LIMIT);
    expect(run.where()).toEqual({ a: 'asking one' });
    expect(limitNote).toHaveBeenCalledWith('a');
    expect(run.store.snapshot().agents.a?.problem).toEqual({
      kind: 'failed',
      reason: 'usage-limit',
      text: 'Usage limit. Its fallback chain didn’t act: corrallm can’t tell when this limit ends.',
      agent: 'a',
    });
    expect(gate.asked()).toContainEqual(['a', { held: true }]);
    // Nothing is sent again by itself.
    expect(run.sent).toHaveLength(1);
  });

  it('asks nothing of another failure, nor while its agent is paused', () => {
    const gate = admission();
    const limitNote = vi.fn<NonNullable<RunIO['limitNote']>>(() => undefined);
    const run = setup(
      [agent('a', [{ id: 'one', message: 'Do it' }]), agent('b', [{ id: 'two', message: 'Go' }])],
      manual,
      new Set(),
      { ...gate, limitNote },
    );
    run.store.start();
    gate.admit.mockClear();
    run.reply('a', true, '', { status: 'failed', reason: 'api', message: 'Overloaded' });
    expect(limitNote).not.toHaveBeenCalled();
    expect(gate.asked().filter(([, work]) => 'held' in work)).toEqual([]);
    run.store.pauseAgent('b');
    run.reply('b', true, '', LIMIT);
    run.store.admissionChanged();
    expect(gate.asked().filter(([, work]) => 'held' in work)).toEqual([]);
    expect(run.store.snapshot().agents.b?.problem?.text).toBe('Usage limit.');
  });

  it('continues once corrallm switched it: one new attempt, through the gate, at the same item', () => {
    const gate = admission();
    const run = setup(
      [
        agent('a', [
          {
            id: 'loop',
            repeat: [
              { id: 'try', message: 'Try it' },
              { id: 'check', message: 'Check it' },
            ],
            until: { kind: 'succeeded' },
            rounds: 3,
            otherwise: 'ask',
          },
        ]),
      ],
      manual,
      new Set(),
      gate,
    );
    run.store.start();
    run.reply('a', false, 'Tried');
    run.reply('a', true, '', LIMIT);
    const failed = run.store.snapshot().agents.a?.attempts?.check?.[0];
    expect(failed).toMatchObject({ status: 'failed', reason: 'usage-limit' });
    gate.admit.mockClear();
    expect(run.store.continueAfterSwitch('a', 'check', String(failed?.id))).toBe(true);
    expect(gate.asked()).toContainEqual(['a', {}]);
    expect(run.sent.map(({ text }) => text)).toEqual(['Try it', 'Check it', 'Check it']);
    const attempts = run.store.snapshot().agents.a?.attempts?.check ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ status: 'failed', reason: 'usage-limit' });
    expect(attempts[1]).toMatchObject({ status: 'running', retryOf: failed?.id });
    expect(run.store.snapshot().agents.a).toMatchObject({
      status: 'running',
      current: 'check',
      rounds: { loop: { round: 1 } },
    });
    // Only once: it is no longer held.
    expect(run.store.continueAfterSwitch('a', 'check', String(failed?.id))).toBe(false);
    // Only the new attempt's result decides.
    run.reply('a', false, 'Checked');
    expect(run.store.snapshot().agents.a?.outcomes).toMatchObject({ loop: 'succeeded' });
  });

  it('continues a hand-off as its owner’s task, to the same recipient', () => {
    const gate = admission();
    const run = setup(
      [agent('a', [{ id: 'hand', message: 'Review this', target: 'b' }]), agent('b')],
      manual,
      new Set(),
      gate,
    );
    run.store.start();
    run.reply('b', true, '', LIMIT);
    expect(run.store.snapshot().agents.a?.problem).toMatchObject({ agent: 'b' });
    const failed = String(run.store.snapshot().agents.a?.attempts?.hand?.[0]?.id);
    expect(run.store.continueAfterSwitch('a', 'hand', failed)).toBe(true);
    expect(run.sent.map(({ agent, text }) => [agent, text])).toEqual([
      ['b', 'Review this'],
      ['b', 'Review this'],
    ]);
  });

  it('continues nothing that isn’t held so now: paused, another failure, a later attempt, a correction', () => {
    const gate = admission();
    const run = setup(
      [agent('a', [{ id: 'one', message: 'Do it' }]), agent('b', [{ id: 'two', message: 'Go' }])],
      manual,
      new Set(),
      gate,
    );
    run.store.start();
    run.reply('a', true, '', LIMIT);
    run.reply('b', true, '', { status: 'failed', reason: 'api' });
    const first = String(run.store.snapshot().agents.a?.attempts?.one?.[0]?.id);
    const other = String(run.store.snapshot().agents.b?.attempts?.two?.[0]?.id);
    expect(run.store.continueAfterSwitch('b', 'two', other)).toBe(false);
    expect(run.store.continueAfterSwitch('a', 'one', 'another-attempt')).toBe(false);
    run.store.pauseAgent('a');
    expect(run.store.continueAfterSwitch('a', 'one', first)).toBe(false);
    run.store.resumeAgent('a');
    // Your correction failed on the limit: its images and words are yours to send again.
    run.store.decide('a', 'one', { reply: 'Try smaller steps' });
    run.reply('a', true, '', LIMIT);
    const corrected = String(run.store.snapshot().agents.a?.attempts?.one?.at(-1)?.id);
    expect(run.store.continueAfterSwitch('a', 'one', corrected)).toBe(false);
    expect(run.sent).toHaveLength(3);
  });
});
