import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem, QueueRepeat, RepeatedItem } from '../graph/queue';
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

const loop = (
  id: string,
  repeat: RepeatedItem[],
  until: QueueRepeat['until'] = { kind: 'succeeded' },
): QueueRepeat => ({ id, repeat, until, rounds: 3, otherwise: 'ask' });

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

  it('puts a repeat in one cell spanning its own row and those of what it holds', () => {
    const a = agent('a', [
      { id: 'build', action: 'Edit' },
      loop('green', [
        { id: 'fix', message: 'Make the tests pass' },
        { id: 'tests', action: 'Bash' },
      ]),
      { id: 'ship', action: 'Bash' },
      loop('empty', []),
    ]);
    const { lanes, rows } = lanesOf([a]);
    expect(
      lanes[0]?.cells.map(({ item, row, span, inner }) => [
        item.id,
        row,
        span,
        inner?.map((cell) => [cell.item.id, cell.row]),
      ]),
    ).toEqual([
      ['build', 0, 1, undefined],
      // Its items in the rows below its own; the next item right after the last of them.
      [
        'green',
        1,
        3,
        [
          ['fix', 2],
          ['tests', 3],
        ],
      ],
      ['ship', 4, 1, undefined],
      ['empty', 5, 1, []],
    ]);
    expect([lanes[0]?.end, rows]).toEqual([6, 7]);
  });

  it('links waits and work handed on inside a repeat, a wait outside one after the repeat', () => {
    const a = agent('a', [
      loop('loop', [
        { id: 'build', action: 'Edit' },
        { id: 'hand', message: 'Over to you', target: 'b' },
      ]),
    ]);
    // b waits for a step inside a's repeat from outside one: once the repeat is over.
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'build' }] }]);
    // c waits for it from inside a repeat: round by round, right after the step.
    const c = agent('c', [loop('again', [{ id: 'w', waitFor: [{ agent: 'a', item: 'build' }] }])]);
    const { lanes, links } = lanesOf([a, b, c]);
    expect(
      lanes.map((lane) => lane.cells.map((cell) => [cell.item.id, cell.row, cell.span])),
    ).toEqual([[['loop', 0, 3]], [['w', 3, 1]], [['again', 0, 3]]]);
    expect(lanes[2]?.cells[0]?.inner?.map((cell) => cell.row)).toEqual([2]);
    expect(links.map((link) => link.key)).toEqual(['a:hand>b', 'b:w>a:build', 'c:w>a:build']);
    expect(links[2]).toMatchObject({
      from: { lane: 'a', item: 'build' },
      to: { lane: 'c', item: 'w' },
    });
  });

  it('marks waits inside repeats stuck when they wait on each other', () => {
    const a = agent('a', [loop('la', [{ id: 'x', waitFor: [{ agent: 'b', item: 'y' }] }])]);
    const b = agent('b', [loop('lb', [{ id: 'y', waitFor: [{ agent: 'a', item: 'x' }] }])]);
    const lanes = lanesOf([a, b]);
    expect([lanes.isStuck('a', 'x'), lanes.isStuck('b', 'y'), lanes.isStuck('a', 'la')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  describe('repeats that go round with another', () => {
    /** Head to head: two builders go round with a judge, who waits for both builds each round. */
    const builder = (id: string) =>
      agent(id, [
        { id: 'worktree', action: 'EnterWorktree' },
        loop(
          'rounds',
          [
            { id: 'build', message: 'Build it' },
            { id: 'scored', waitFor: [{ agent: 'judge', item: 'judge' }] },
          ],
          { kind: 'repeatEnds', agent: 'judge', item: 'judging' },
        ),
      ]);
    const judge = agent('judge', [
      loop(
        'judging',
        [
          {
            id: 'built',
            waitFor: [
              { agent: 'claude', item: 'build' },
              { agent: 'codex', item: 'build' },
            ],
          },
          { id: 'judge', message: 'Judge them' },
        ],
        { kind: 'outputContains', text: 'WINNER' },
      ),
      { id: 'merge', message: 'Merge the winner' },
    ]);

    it('lines up waits round by round, a follower ending after its leader, and none stuck', () => {
      const layout = lanesOf([builder('claude'), builder('codex'), judge]);
      expect(
        layout.lanes.map((lane) => [
          lane.agent.id,
          lane.cells.map((cell) => [cell.item.id, cell.row, cell.span]),
          lane.cells.flatMap(
            (cell) => cell.inner?.map((inner) => [inner.item.id, inner.row]) ?? [],
          ),
        ]),
      ).toEqual([
        [
          'claude',
          [
            ['worktree', 0, 1],
            ['rounds', 1, 5],
          ],
          [
            ['build', 2],
            ['scored', 5],
          ],
        ],
        [
          'codex',
          [
            ['worktree', 0, 1],
            ['rounds', 1, 5],
          ],
          [
            ['build', 2],
            ['scored', 5],
          ],
        ],
        [
          'judge',
          [
            ['judging', 0, 5],
            ['merge', 5, 1],
          ],
          [
            ['built', 3],
            ['judge', 4],
          ],
        ],
      ]);
      expect(layout.links.map((link) => link.key)).toEqual([
        'claude:scored>judge:judge',
        'codex:scored>judge:judge',
        'judge:built>claude:build',
        'judge:built>codex:build',
      ]);
      const ids = ['worktree', 'rounds', 'build', 'scored', 'judging', 'built', 'judge', 'merge'];
      for (const lane of ['claude', 'codex', 'judge'])
        for (const id of ids) expect(layout.isStuck(lane, id)).toBe(false);
    });

    it('marks stuck a leader that waits for all of its follower’s work, and repeats following each other', () => {
      const leader = agent('a', [loop('lead', [{ id: 'w', waitFor: [{ agent: 'b' }] }])]);
      const follower = agent('b', [
        loop('follow', [{ id: 'x', action: 'Read' }], {
          kind: 'repeatEnds',
          agent: 'a',
          item: 'lead',
        }),
      ]);
      expect(lanesOf([leader, follower]).isStuck('a', 'w')).toBe(true);

      const one = agent('a', [
        loop('r', [{ id: 'x', action: 'Read' }], { kind: 'repeatEnds', agent: 'b', item: 'r' }),
      ]);
      const other = agent('b', [
        loop('r', [{ id: 'y', action: 'Read' }], { kind: 'repeatEnds', agent: 'a', item: 'r' }),
      ]);
      const both = lanesOf([one, other]);
      expect([both.isStuck('a', 'r'), both.isStuck('b', 'r')]).toEqual([true, true]);
    });
  });
});
