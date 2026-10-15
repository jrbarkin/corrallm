import { describe, expect, it, vi } from 'vitest';

import type { GraphNode } from '../graph/graph';
import { RunStore } from './runner';
import type { TurnEnd } from './runner';

const nodes: GraphNode[] = [
  {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      label: 'A',
      connection: 'sdk',
      queue: [
        { id: 'build', action: 'Read', instruction: 'Inspect the release' },
        { id: 'next', message: 'Ship it' },
      ],
    },
  },
  {
    id: 'b',
    type: 'agent',
    position: { x: 400, y: 0 },
    data: {
      label: 'B',
      connection: 'sdk',
      queue: [
        { id: 'wait', waitFor: [{ agent: 'a', item: 'build' }] },
        { id: 'verify', message: 'Verify it' },
      ],
    },
  },
];

function setup(graph = nodes) {
  const sent: { text: string; done: (turn: TurnEnd) => void }[] = [];
  const store = new RunStore({
    send: (_agent, text, done) => {
      sent.push({ text, done });
      return () => undefined;
    },
    tell: () => undefined,
    connect: () => undefined,
    later: () => () => undefined,
    now: () => 1234,
    chance: () => {
      throw new Error('Connected task must not be simulated');
    },
  });
  store.update(graph);
  return { store, sent };
}

function restored() {
  const first = setup();
  first.store.start();
  const second = setup();
  second.store.restore(first.store.checkpoint());
  expect(second.store.snapshot()).toMatchObject({ running: false, paused: true });
  expect(second.store.snapshot().agents.a?.problem?.kind).toBe('uncertain');
  return second;
}

describe('native corrections while paused', () => {
  it('records a correction of the restored task, releasing follow-up work and dependent waits only on Resume', () => {
    const { store, sent } = restored();
    const changed = vi.fn();
    store.subscribe(changed);
    expect(store.observeSubmission('a', 'manual', 'Check the missing release note')).toEqual({
      agent: 'a',
      item: 'build',
    });
    expect(sent).toHaveLength(0);
    store.observeEnd('a', 'manual', 'Verified.\nSUCCEEDED', {
      status: 'completed',
      reason: 'completed',
    });
    expect(store.snapshot()).toMatchObject({
      running: false,
      paused: true,
      agents: {
        a: { current: 'build', outcomes: { build: 'succeeded' } },
        b: { current: 'wait', status: 'waiting', outcomes: {} },
      },
    });
    expect(store.snapshot().agents.a?.problem).toBeUndefined();
    expect(store.snapshot().agents.a?.attempts?.build?.map(({ status }) => status)).toEqual([
      'uncertain',
      'succeeded',
    ]);
    expect(store.snapshot().agents.a?.attempts?.build?.at(-1)?.message).toBe(
      'Check the missing release note',
    );
    expect(changed).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
    store.resume();
    expect(sent.map(({ text }) => text)).toEqual(['Ship it', 'Verify it']);
    expect(store.snapshot().agents.b?.outcomes.wait).toBe('succeeded');
  });

  it.each([
    { reply: 'FAILED', kind: 'failed' },
    { reply: 'I need another look.', kind: 'uncertain' },
  ])(
    'retains a $kind correction as a paused hold without automatically dispatching work',
    ({ reply, kind }) => {
      const { store, sent } = restored();
      expect(store.observeSubmission('a', 'manual', 'Inspect the result')).toEqual({
        agent: 'a',
        item: 'build',
      });
      store.observeEnd('a', 'manual', reply, { status: 'completed', reason: 'completed' });
      expect(store.snapshot()).toMatchObject({
        running: false,
        paused: true,
        agents: {
          a: { current: 'build', status: 'asking', problem: { kind }, outcomes: {} },
          b: { current: 'wait', status: 'waiting', outcomes: {} },
        },
      });
      expect(store.snapshot().agents.a?.attempts?.build?.at(-1)?.status).toBe(kind);
      expect(sent).toHaveLength(0);
      store.resume();
      expect(store.snapshot().agents.a?.problem?.kind).toBe(kind);
      expect(sent).toHaveLength(0);
    },
  );

  it('excludes a paused condition query from native task adoption', () => {
    const graph: GraphNode[] = [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'A',
          connection: 'sdk',
          queue: [
            { id: 'before', message: 'Inspect the release' },
            { id: 'check', if: { kind: 'freeText', text: 'the release is ready' }, then: [] },
          ],
        },
      },
    ];
    const first = setup(graph);
    first.store.start();
    first.sent[0]?.done({ failed: false, reply: 'Inspected.' });
    const second = setup(graph);
    second.store.restore(first.store.checkpoint());
    const before = second.store.snapshot();
    expect(second.store.observeSubmission('a', 'manual', 'Yes, it is ready')).toBeUndefined();
    second.store.observeEnd('a', 'manual', 'Yes.', { status: 'completed', reason: 'completed' });
    expect(second.store.snapshot()).toBe(before);
    expect(second.sent).toHaveLength(0);
  });
});
