import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { RunStore } from './runner';
import type { TurnEnd } from './runner';
import { conditionQuestion } from './turns';

const before = { id: 'before', message: 'Inspect the source' };
const branch = { id: 'branch', message: 'Publish it' };
const next = { id: 'next', message: 'Next task' };
const condition = {
  id: 'check',
  if: { kind: 'freeText', text: 'the source is ready' },
  then: [branch],
} as const;
const key = JSON.stringify(['a', 'check']);

function setup(queue: QueueItem[], unheard = false) {
  const sent: { text: string; done?: (turn: TurnEnd) => void; withdrawn: boolean }[] = [];
  const notices: string[] = [];
  const store = new RunStore({
    send: (_node, text, done) => {
      const message = { text, done, withdrawn: false };
      sent.push(message);
      return () => {
        message.withdrawn = true;
      };
    },
    tell: (_node, text) => {
      notices.push(text);
    },
    connect: () => undefined,
    later: () => () => undefined,
    now: () => 1234,
    unheard: () => unheard,
  });
  const node: GraphNode = {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'A', connection: 'sdk', queue },
  };
  store.update([node]);
  return {
    store,
    sent,
    notices,
    reply: (text: string, failed = false, result?: TurnEnd['result']) => {
      const message = sent.find((entry) => entry.done);
      if (!message?.done) throw new Error('No pending turn');
      const done = message.done;
      delete message.done;
      done({ reply: text, failed, ...(result ? { result } : {}) });
    },
  };
}

function startQuery() {
  const run = setup([before, { ...condition, then: [branch] }, next]);
  run.store.start();
  run.reply('Source inspected.');
  expect(run.sent.at(-1)?.text).toBe(conditionQuestion(condition.if.text));
  return run;
}

describe('condition recovery', () => {
  it('holds an unclear answer and retries the query only when asked', () => {
    const { store, sent, reply } = startQuery();
    reply('Almost, but I need another look.');
    expect(store.snapshot().agents.a).toMatchObject({
      current: 'check',
      status: 'asking',
      outcomes: { before: 'succeeded' },
      problem: { kind: 'uncertain', reason: 'unclear-answer', conditionKey: key },
    });
    expect(store.snapshot().agents.a?.attempts?.check?.map(({ status }) => status)).toEqual([
      'uncertain',
    ]);
    expect(sent).toHaveLength(2);
    // A condition is decided with yes/no, not retried as an ordinary task with a corrective note.
    store.decide('a', 'check', { reply: 'Try another approach' });
    expect(sent).toHaveLength(2);
    store.decide('a', 'check', { choice: 'retry' });
    expect(sent.at(-1)?.text).toBe(conditionQuestion(condition.if.text));
    reply('Yes, it is ready.');
    expect(sent.at(-1)?.text).toBe(branch.message);
    expect(store.snapshot().agents.a?.attempts?.check?.map(({ status }) => status)).toEqual([
      'uncertain',
      'succeeded',
    ]);
    reply('Published.');
    expect(store.snapshot().agents.a?.outcomes.check).toBe('succeeded');
    expect(sent.at(-1)?.text).toBe(next.message);
  });

  it.each(['yes', 'no'] as const)(
    'lets a human decide %s after a failed query without re-sending it',
    (choice) => {
      const { store, sent, reply } = startQuery();
      reply('Yes.', false, { status: 'failed', reason: 'usage-limit', message: 'Usage exhausted' });
      expect(store.snapshot().agents.a?.problem).toMatchObject({
        kind: 'failed',
        reason: 'usage-limit',
        text: 'Usage exhausted',
        conditionKey: key,
      });
      expect(store.snapshot().agents.a?.outcomes.check).toBeUndefined();
      store.decide('a', 'check', { choice });
      expect(sent).toHaveLength(3);
      if (choice === 'yes') {
        expect(sent.at(-1)?.text).toBe(branch.message);
        reply('Published.');
      }
      expect(store.snapshot().agents.a?.outcomes.check).toBe(
        choice === 'yes' ? 'succeeded' : 'skipped',
      );
      expect(sent.at(-1)?.text).toBe(next.message);
    },
  );

  it('preserves typed cancellation as cancellation instead of using its answer or treating it as failure', () => {
    const { store, sent, reply } = startQuery();
    reply('Yes.', true, { status: 'cancelled', reason: 'taken-back' });
    expect(store.snapshot().agents.a?.problem).toMatchObject({
      kind: 'cancelled',
      reason: 'taken-back',
      conditionKey: key,
    });
    expect(sent).toHaveLength(2);
    store.decide('a', 'check', { choice: 'stop' });
    expect(store.snapshot().agents.a?.status).toBe('stopped');
    expect(store.snapshot().running).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('keeps a failed legacy query unresolved even if its reply starts with no', () => {
    const { store, sent, reply } = startQuery();
    reply('No.', true);
    expect(store.snapshot().agents.a?.problem).toMatchObject({ kind: 'failed', conditionKey: key });
    expect(sent).toHaveLength(2);
    expect(store.snapshot().agents.a?.outcomes.check).toBeUndefined();
  });

  it.each(['outputContains', 'freeText'] as const)(
    'holds an unreadable %s condition without asking an unreadable query',
    (kind) => {
      const { store, sent, reply, notices } = setup(
        [before, { id: 'check', if: { kind, text: 'ready' }, then: [branch] }, next],
        true,
      );
      store.start();
      reply('');
      expect(store.snapshot().agents.a).toMatchObject({
        current: 'check',
        status: 'asking',
        problem: { kind: 'uncertain', reason: 'unheard-reply', conditionKey: key },
      });
      expect(sent).toHaveLength(1);
      store.decide('a', 'check', { choice: 'retry' });
      expect(sent).toHaveLength(1);
      expect(store.snapshot().agents.a?.problem?.kind).toBe('uncertain');
      expect(notices).toHaveLength(1);
      store.decide('a', 'check', { choice: 'yes' });
      expect(sent.at(-1)?.text).toBe(branch.message);
    },
  );

  it('keeps each round’s condition decision separate', () => {
    const { store, sent, reply } = setup([
      {
        id: 'loop',
        repeat: [before],
        until: condition.if,
        rounds: 2,
        otherwise: 'goOn',
      },
      next,
    ]);
    store.start();
    reply('Inspected.');
    reply('Maybe.');
    expect(store.snapshot().agents.a?.problem?.conditionKey).toBe(JSON.stringify(['a', 'loop', 1]));
    store.decide('a', 'loop', { choice: 'no' });
    expect(sent.at(-1)?.text).toBe(before.message);
    reply('Inspected again.');
    reply('It still needs another look.');
    expect(store.snapshot().agents.a?.problem?.conditionKey).toBe(JSON.stringify(['a', 'loop', 2]));
    store.decide('a', 'loop', { choice: 'yes' });
    expect(store.snapshot().agents.a?.outcomes.loop).toBe('succeeded');
    expect(sent.at(-1)?.text).toBe(next.message);
  });

  it('restores a held condition paused and does not replay the query on Resume', () => {
    const first = startQuery();
    first.reply('Unclear.');
    first.store.pause();
    const second = setup([before, { ...condition, then: [branch] }, next]);
    second.store.restore(first.store.checkpoint());
    expect(second.store.snapshot()).toMatchObject({ running: false, paused: true });
    second.store.decide('a', 'check', { choice: 'yes' });
    expect(second.sent).toHaveLength(0);
    second.store.resume();
    expect(second.store.snapshot().agents.a?.problem?.conditionKey).toBe(key);
    expect(second.sent).toHaveLength(0);
    second.store.decide('a', 'check', { choice: 'retry' });
    expect(second.sent.map(({ text }) => text)).toEqual([conditionQuestion(condition.if.text)]);
    second.reply('No.');
    expect(second.sent.at(-1)?.text).toBe(next.message);
    expect(second.store.snapshot().agents.a?.outcomes.check).toBe('skipped');
  });

  it.each(['if', 'repeat'] as const)(
    'restores an in-flight %s query as a condition hold without replaying prior work',
    (kind) => {
      const queue: QueueItem[] =
        kind === 'if'
          ? [before, { ...condition, then: [branch] }, next]
          : [
              { id: 'loop', repeat: [before], until: condition.if, rounds: 2, otherwise: 'goOn' },
              next,
            ];
      const first = setup(queue);
      first.store.start();
      first.reply('Inspected.');
      const second = setup(queue);
      second.store.restore(first.store.checkpoint());
      const item = kind === 'if' ? 'check' : 'loop';
      const expectedKey = JSON.stringify(kind === 'if' ? ['a', item] : ['a', item, 1]);
      expect(second.store.snapshot().agents.a?.problem).toMatchObject({
        kind: 'uncertain',
        conditionKey: expectedKey,
      });
      second.store.resume();
      expect(second.sent).toHaveLength(0);
      second.store.decide('a', item, { choice: 'yes' });
      expect(second.sent.map(({ text }) => text)).toEqual([
        kind === 'if' ? branch.message : next.message,
      ]);
    },
  );

  it('keeps a paused query’s condition identity and ignores native corrections until explicitly decided', () => {
    const { store, sent, reply } = startQuery();
    store.stop();
    expect(store.snapshot().agents.a?.problem).toMatchObject({
      kind: 'cancelled',
      conditionKey: key,
    });
    store.resume();
    const held = store.snapshot();
    expect(store.observeSubmission('a', 'manual', 'Yes, it is ready.')).toBeUndefined();
    store.observeEnd('a', 'manual', 'Yes.', { status: 'completed', reason: 'completed' });
    reply('Yes.'); // The interrupted query's late result cannot resolve it either.
    expect(store.snapshot()).toBe(held);
    expect(sent).toHaveLength(2);
    store.decide('a', 'check', { choice: 'no' });
    expect(sent.at(-1)?.text).toBe(next.message);
  });

  it('rejects a checkpoint whose condition key is not a string', () => {
    const { store, reply } = startQuery();
    reply('Maybe.');
    const saved = JSON.parse(store.checkpoint()) as {
      run: { agents: { a: { problem: { conditionKey: unknown } } } };
    };
    saved.run.agents.a.problem.conditionKey = {};
    const before = store.checkpoint();
    expect(() => {
      store.restore(JSON.stringify(saved));
    }).toThrow('invalid or unsupported');
    expect(store.checkpoint()).toBe(before);
  });
});
