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
  const { lanes, rows: count } = lanesOf(nodes);
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
      { id: 'if', if: { kind: 'failed' }, then: [{ id: 'fix', action: 'Edit', target: 'b' }] },
    ]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'hand' }, { agent: 'a' }] }]);
    expect(lanesOf([a, b]).links).toEqual([
      {
        key: 'hand>b',
        kind: 'handoff',
        from: { column: 'a', item: 'hand' },
        to: { column: 'b', item: undefined },
      },
      {
        key: 'if>b',
        kind: 'handoff',
        from: { column: 'a', item: 'if' },
        to: { column: 'b', item: undefined },
      },
      {
        key: 'w>hand',
        kind: 'wait',
        from: { column: 'a', item: 'hand' },
        to: { column: 'b', item: 'w' },
      },
      {
        key: 'w>end',
        kind: 'wait',
        from: { column: 'a', item: null },
        to: { column: 'b', item: 'w' },
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
});
