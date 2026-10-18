import { describe, expect, it } from 'vitest';

import type { GraphNode } from './graph';
import type { QueueItem } from '../../shared/model/queue';
import { isWorkBetween, workEdges } from './work';

const agent = (id: string, queue: QueueItem[] = []): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

describe('workEdges', () => {
  it('runs an edge from an agent to each agent its steps and messages are aimed at, counting them', () => {
    const a = agent('a', [
      { id: 'm', message: 'Fix the tests' }, // for a itself
      { id: 's1', action: 'Read', target: 'b' },
      { id: 'm2', message: 'Over to you', target: 'b' },
      { id: 'if', if: { kind: 'succeeded' }, then: [{ id: 's2', action: 'Bash', target: 'b' }] },
      { id: 's3', action: 'Grep', target: 'c' },
      { id: 's4', action: 'Edit' }, // on a itself
      { id: 's5', action: 'Edit', target: 'gone' }, // on a deleted agent
    ]);
    expect(workEdges([a, agent('b'), agent('c')])).toEqual([
      { from: 'a', to: 'b', count: 3, conditional: false },
      { from: 'a', to: 'c', count: 1, conditional: false },
    ]);
  });

  it('marks an edge conditional when all of its work waits on a condition', () => {
    const a = agent('a', [
      {
        id: 'i',
        if: { kind: 'freeText', text: 'the tests pass' },
        then: [{ id: 'm', message: 'Ship it', target: 'lead' }],
      },
      { id: 's', action: 'Read', target: 'b' },
      { id: 'j', if: { kind: 'failed' }, then: [{ id: 't', action: 'Bash', target: 'b' }] },
    ]);
    expect(workEdges([a, agent('b'), agent('lead')])).toEqual([
      { from: 'a', to: 'lead', count: 1, conditional: true },
      { from: 'a', to: 'b', count: 2, conditional: false },
    ]);
  });

  it('runs an edge to an agent from each agent it waits for, beside the work it gives them', () => {
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a' }, { agent: 'c', item: 'x' }] },
      { id: 's', action: 'Read', target: 'a' },
    ]);
    const a = agent('a', [{ id: 't', action: 'Write', target: 'b' }]);
    expect(workEdges([a, b, agent('c')])).toEqual([
      { from: 'a', to: 'b', count: 2, conditional: false },
      { from: 'c', to: 'b', count: 1, conditional: false },
      { from: 'b', to: 'a', count: 1, conditional: false },
    ]);
  });

  it('counts the waits and work handed on inside a repeat, as work that happens', () => {
    const b = agent('b', [
      {
        id: 'loop',
        repeat: [
          { id: 'ready', waitFor: [{ agent: 'a', item: 'build' }] },
          { id: 'review', message: 'Review it', target: 'a' },
          { id: 'pause', delay: { seconds: 60 } },
        ],
        until: { kind: 'outputContains', text: 'APPROVED' },
        rounds: 3,
        otherwise: 'ask',
      },
    ]);
    const a = agent('a', [{ id: 'build', action: 'Edit' }]);
    expect(workEdges([a, b])).toEqual([
      { from: 'a', to: 'b', count: 1, conditional: false },
      { from: 'b', to: 'a', count: 1, conditional: false },
    ]);
    const [loop] = b.data.queue ?? [];
    if (!loop) throw new Error('no repeat');
    expect([isWorkBetween(loop, 'b', 'a', 'b'), isWorkBetween(loop, 'b', 'b', 'a')]).toEqual([
      true,
      true,
    ]);
    expect(isWorkBetween(loop, 'b', 'b', 'c')).toBe(false);
  });
});

describe('isWorkBetween', () => {
  it("tells which of an agent's items make an edge: work it gives, or a wait for another", () => {
    const step: QueueItem = { id: 's', action: 'Read', target: 'b' };
    const holding: QueueItem = { id: 'i', if: { kind: 'failed' }, then: [step] };
    const waiting: QueueItem = { id: 'w', waitFor: [{ agent: 'b', item: 's' }] };
    const message: QueueItem = { id: 'm', message: 'Hello' };
    const sent: QueueItem = { id: 'n', message: 'Over to you', target: 'b' };
    const ok: QueueItem = { id: 'ok', approve: 'the plan' };
    const between = (item: QueueItem, from: string, to: string) =>
      isWorkBetween(item, 'a', from, to);
    // In a's queue: work for b makes a -> b; waiting for b makes b -> a. An OK is no work.
    const items = [step, holding, waiting, message, sent, ok];
    expect(items.map((item) => between(item, 'a', 'b'))).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(items.map((item) => between(item, 'b', 'a'))).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});
