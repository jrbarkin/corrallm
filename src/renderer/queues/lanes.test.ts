import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { lanesOf } from './lanes';

const agent = (id: string, queue: QueueItem[] = []): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

/** Each lane's items, by row: `null` where a row is empty. */
const rows = (nodes: GraphNode[]) => {
  const { lanes } = lanesOf(nodes);
  const count = Math.max(0, ...lanes.flatMap((lane) => lane.cells.map((cell) => cell.row + 1)));
  return Object.fromEntries(
    lanes.map((lane) => [
      lane.agent.id,
      Array.from(
        { length: count },
        (_, row) => lane.cells.find((c) => c.row === row)?.item.id ?? null,
      ),
    ]),
  );
};

describe('lanesOf', () => {
  it('puts each agent’s queue in a lane, a wait in the row after what it waits for', () => {
    const a = agent('a', [
      { id: 'research', action: 'Workflow' },
      { id: 'notes', message: 'Write it up' },
    ]);
    const b = agent('b', [
      { id: 'build', action: 'Edit' },
      { id: 'w', waitFor: [{ agent: 'a', item: 'notes' }] },
      { id: 'check', message: 'Cross-check' },
    ]);
    expect(rows([a, b])).toEqual({
      a: ['research', 'notes', null, null],
      b: ['build', null, 'w', 'check'],
    });
  });

  it('puts a wait for all of an agent’s work after the end of its lane', () => {
    const a = agent('a', [
      { id: 'one', action: 'Read' },
      { id: 'two', action: 'Edit' },
    ]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a' }] }]);
    const lanes = lanesOf([a, b]);
    expect(lanes.lanes.map((lane) => lane.end)).toEqual([2, 4]);
    expect(rows([a, b]).b).toEqual([null, null, null, 'w']);
  });

  it('links waits to what they wait for, and work handed to another agent to its lane', () => {
    const a = agent('a', [
      { id: 'hand', message: 'Over to you', target: 'b' },
      {
        id: 'if',
        if: { kind: 'failed' },
        then: [
          { id: 'fix', action: 'Edit', target: 'b' },
          { id: 'mine', action: 'Read' },
        ],
      },
      { id: 'self', waitFor: [{ agent: 'a', item: 'hand' }] },
    ]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'hand' }, { agent: 'a' }] }]);
    // A step of an if-then is handed over on its own line; a wait in the same lane needs no link.
    expect(lanesOf([a, b]).links).toEqual([
      { key: 'a:hand>b', kind: 'handoff', from: { lane: 'a', item: 'hand' }, to: 'b' },
      { key: 'a:fix>b', kind: 'handoff', from: { lane: 'a', item: 'fix' }, to: 'b' },
      {
        key: 'b:w>a:hand',
        kind: 'wait',
        from: { lane: 'a', item: 'hand' },
        to: { lane: 'b', item: 'w' },
        timed: false,
      },
      {
        key: 'b:w>a',
        kind: 'wait',
        from: { lane: 'a', item: null },
        to: { lane: 'b', item: 'w' },
        timed: false,
      },
    ]);
  });

  it('says which waits have a time limit, and puts a delay after the item before it, unlinked', () => {
    const a = agent('a', [
      { id: 'build', action: 'Edit' },
      { id: 'pause', delay: { seconds: 600 } },
      { id: 'ship', action: 'Bash' },
    ]);
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'pause' }], timeout: { seconds: 60 } },
    ]);
    const { links } = lanesOf([a, b]);
    expect(links).toEqual([
      {
        key: 'b:w>a:pause',
        kind: 'wait',
        from: { lane: 'a', item: 'pause' },
        to: { lane: 'b', item: 'w' },
        timed: true,
      },
    ]);
    expect(rows([a, b])).toEqual({ a: ['build', 'pause', 'ship'], b: [null, null, 'w'] });
  });

  it('puts a wait for an OK in the row after it, linked from it; an OK hands no work on', () => {
    const a = agent('a', [
      { id: 'spec', message: 'Write SPEC.md' },
      { id: 'ok', approve: 'the spec in SPEC.md' },
      { id: 'plan', message: 'Write PLAN.md' },
    ]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'ok' }] }]);
    expect(rows([a, b])).toEqual({ a: ['spec', 'ok', 'plan'], b: [null, null, 'w'] });
    expect(lanesOf([a, b]).links).toEqual([
      {
        key: 'b:w>a:ok',
        kind: 'wait',
        from: { lane: 'a', item: 'ok' },
        to: { lane: 'b', item: 'w' },
        timed: false,
      },
    ]);
  });

  it('marks waits that wait on each other as stuck, and still lays them out', () => {
    const a = agent('a', [{ id: 'w', waitFor: [{ agent: 'b', item: 'w' }] }]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'w' }] }]);
    // The same id in another agent's queue is another item.
    const c = agent('c', [{ id: 'w', action: 'Read' }]);
    const lanes = lanesOf([a, b, c]);
    expect([lanes.isStuck('a', 'w'), lanes.isStuck('b', 'w'), lanes.isStuck('c', 'w')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(rows([a, b, c]).c?.[0]).toBe('w');
  });

  it('does not mark a loop of waits stuck when a time limit in it breaks it, but lays it out', () => {
    const a = agent('a', [
      { id: 'w', waitFor: [{ agent: 'b', item: 'w' }], timeout: { seconds: 60 } },
      { id: 'next', action: 'Read' },
    ]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'w' }] }]);
    const c = agent('c', [{ id: 'x', waitFor: [{ agent: 'c', item: 'x' }] }]);
    const lanes = lanesOf([a, b, c]);
    expect([lanes.isStuck('a', 'w'), lanes.isStuck('b', 'w'), lanes.isStuck('c', 'x')]).toEqual([
      false,
      false,
      true,
    ]);
    expect(rows([a, b, c])).toEqual({ a: ['w', 'next'], b: ['w', null], c: ['x', null] });
  });
});
