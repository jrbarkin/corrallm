import { describe, expect, it, vi } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { RunStore } from './runner';
import type { RunIO, TurnEnd } from './runner';

function setup(queue: QueueItem[], overrides: Partial<RunIO> = {}) {
  const sent: {
    text: string;
    done: (turn: TurnEnd) => void;
    origin?: 'user';
    displayText?: string;
  }[] = [];
  const io: RunIO = {
    send: (_node, text, done, _images, _refused, origin, displayText) => {
      sent.push({
        text,
        done,
        ...(origin ? { origin } : {}),
        ...(displayText ? { displayText } : {}),
      });
      return () => undefined;
    },
    tell: () => undefined,
    connect: () => undefined,
    later: () => () => undefined,
    now: () => 1234,
    ...overrides,
  };
  const node: GraphNode = {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'A', connection: 'sdk', queue },
  };
  const store = new RunStore(io);
  store.update([node]);
  return {
    store,
    sent,
    reply: (reply: string, failed = false, result?: TurnEnd['result']) => {
      const turn = sent.at(-1);
      if (!turn) throw new Error('No turn');
      turn.done({ failed, reply, ...(result ? { result } : {}) });
    },
  };
}

const step = { id: 'build', action: 'Bash', instruction: 'Run the tests' };
const next = { id: 'next', message: 'Ship it' };

describe('task recovery', () => {
  it('writes the in-flight checkpoint before sending, and never sends if that write fails', async () => {
    let release: (() => void) | undefined;
    const beforeSend = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const running = setup([step], { beforeSend });
    running.store.start();
    await Promise.resolve();
    expect(running.sent).toHaveLength(0);
    expect(JSON.parse(running.store.checkpoint())).toMatchObject({
      run: { agents: { a: { current: 'build', status: 'running' } } },
    });
    release?.();
    await vi.waitFor(() => {
      expect(running.sent).toHaveLength(1);
    });
    const failed = setup([step], { beforeSend: () => Promise.reject(new Error('Disk full')) });
    failed.store.start();
    await vi.waitFor(() => {
      expect(failed.store.snapshot().agents.a?.problem?.text).toContain('Disk full');
    });
    expect(failed.sent).toHaveLength(0);
  });

  it('keeps saved output evidence for a condition after a delay', () => {
    const queue: QueueItem[] = [
      step,
      { id: 'pause', delay: { seconds: 10 } },
      { id: 'check', if: { kind: 'outputContains', text: 'verified' }, then: [next] },
    ];
    const first = setup(queue);
    first.store.start();
    first.reply('verified\nSUCCEEDED');
    const second = setup(queue);
    second.store.restore(first.store.checkpoint());
    second.store.resume();
    second.store.goOn('a', 'pause');
    expect(second.sent.at(-1)?.text).toBe('Ship it');
  });

  it('rejects invalid checkpoints without discarding the current run', () => {
    const { store } = setup([step]);
    store.start();
    const before = store.checkpoint();
    expect(() => {
      store.restore('{"version":900,"run":{}}');
    }).toThrow();
    expect(store.checkpoint()).toBe(before);
  });
  it('holds missing or nonexact verdicts rather than inventing success', () => {
    const { store, sent, reply } = setup([step, next]);
    store.start();
    reply('It probably SUCCEEDED.');
    expect(sent).toHaveLength(1);
    expect(store.snapshot().agents.a).toMatchObject({
      current: 'build',
      status: 'asking',
      problem: { kind: 'uncertain' },
      outcomes: {},
    });
    expect(store.snapshot().agents.a?.attempts?.build?.[0]?.status).toBe('uncertain');
    store.decide('a', 'build', { choice: 'resolve' });
    expect(sent.at(-1)?.text).toBe('Ship it');
  });

  it('keeps corrective messages on the same objective and records each attempt', () => {
    const { store, sent, reply } = setup([step, next]);
    store.start();
    reply('Tests broke.\nFAILED');
    expect(store.snapshot().agents.a?.problem?.kind).toBe('failed');
    store.decide('a', 'build', { reply: 'Fix the import first' });
    expect(sent.at(-1)).toMatchObject({ origin: 'user', displayText: 'Fix the import first' });
    expect(sent.at(-1)?.text).toContain('Run the tests');
    expect(sent.at(-1)?.text).toContain('SUCCEEDED or FAILED');
    reply('All tests passed.\nSUCCEEDED');
    expect(store.snapshot().agents.a?.outcomes.build).toBe('succeeded');
    expect(store.snapshot().agents.a?.attempts?.build?.map(({ status }) => status)).toEqual([
      'failed',
      'succeeded',
    ]);
    expect(sent.at(-1)?.text).toBe('Ship it');
  });

  it('adopts a direct terminal correction without sending it again', () => {
    const { store, sent, reply } = setup([step, next]);
    store.start();
    reply('FAILED');
    expect(store.observeSubmission('a', 'native-1', 'Try this correction')).toEqual({
      agent: 'a',
      item: 'build',
    });
    expect(sent).toHaveLength(1);
    store.observeEnd('a', 'native-1', 'SUCCEEDED', { status: 'completed', reason: 'completed' });
    expect(sent).toHaveLength(2);
    expect(store.snapshot().agents.a?.outcomes.build).toBe('succeeded');
  });

  it('keeps cancellation out of failed branches and gives native errors precedence', () => {
    const { store, reply } = setup([
      step,
      { id: 'recover', if: { kind: 'failed' }, then: [{ id: 'wrong', message: 'Failure branch' }] },
    ]);
    store.start();
    reply('SUCCEEDED', true, { status: 'cancelled', reason: 'interrupted' });
    expect(store.snapshot().agents.a?.problem?.kind).toBe('cancelled');
    store.decide('a', 'build', { choice: 'continue' });
    expect(store.snapshot().agents.a?.outcomes).toMatchObject({
      build: 'cancelled',
      recover: 'skipped',
    });
  });

  it('preserves explicit recovery workflows and expected failures', () => {
    const { store, sent, reply } = setup([
      step,
      { id: 'recover', if: { kind: 'failed' }, then: [{ id: 'fix', message: 'Repair it' }] },
    ]);
    store.start();
    reply('FAILED');
    expect(sent.at(-1)?.text).toBe('Repair it');
    const red = setup([{ ...step, expect: 'fails' }, next]);
    red.store.start();
    red.reply('FAILED');
    expect(red.sent.at(-1)?.text).toBe('Ship it');
  });

  it('restores paused progress without replaying submitted work, preserving result evidence', () => {
    const { store, reply } = setup([step, next]);
    store.start();
    reply('SUCCEEDED');
    const saved = store.checkpoint();
    const restored = setup([step, next]);
    restored.store.restore(saved);
    expect(restored.sent).toHaveLength(0);
    expect(restored.store.snapshot()).toMatchObject({
      running: false,
      paused: true,
      agents: {
        a: { current: 'next', problem: { kind: 'uncertain' }, outcomes: { build: 'succeeded' } },
      },
    });
    restored.store.resume();
    expect(restored.sent).toHaveLength(0);
    restored.store.decide('a', 'next', { choice: 'resolve' });
    expect(restored.store.snapshot().agents.a?.status).toBe('done');
  });
});
