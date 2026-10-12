import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { lanesOf } from './lanes';
import { LINE, piecesIn, ribbonsOf } from './ribbons';

const agent = (id: string, queue: QueueItem[] = []): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

/** The span of lines `from` up to (not including) `to`, counted from the top of the rows. */
const lines = (from: number, to: number) => ({ top: from * LINE, bottom: to * LINE });

describe('ribbonsOf', () => {
  it('runs a wait from the lines it waits for to the wait, and narrows work handed on', () => {
    const a = agent('a', [
      { id: 'research', action: 'Workflow' },
      {
        id: 'if',
        if: { kind: 'succeeded' },
        then: [
          { id: 'notes', message: 'Write it up' },
          { id: 'hand', message: 'Over to you', target: 'b' },
        ],
      },
    ]);
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'if' }] },
      { id: 'all', waitFor: [{ agent: 'a' }] },
    ]);
    const ribbons = ribbonsOf(lanesOf([a, b]));
    expect(ribbons.map(({ key, kind, from, to }) => ({ key, kind, from, to }))).toEqual([
      // The second step of the if-then (line 3, after its condition) narrows to a point in b's lane.
      {
        key: 'a:hand>b',
        kind: 'handoff',
        from: { lane: 0, span: lines(3, 4) },
        to: { lane: 1, span: lines(3.5, 3.5) },
      },
      // The wait for the if-then, from all three of its lines.
      {
        key: 'b:w>a:if',
        kind: 'wait',
        from: { lane: 0, span: lines(1, 4) },
        to: { lane: 1, span: lines(4, 5) },
      },
      // The wait for all of a's work, from the end of a's lane.
      {
        key: 'b:all>a',
        kind: 'wait',
        from: { lane: 0, span: lines(4, 5) },
        to: { lane: 1, span: lines(5, 6) },
      },
    ]);
    // Work handed on points into the lane it reaches.
    expect(piecesIn(ribbons, 0).map((piece) => piece.arrow)).toEqual([
      'right',
      undefined,
      undefined,
    ]);
  });

  it('narrows to a line to pass the lanes between, widening again beside the lane it reaches', () => {
    const a = agent('a', [{ id: 'build', action: 'Edit' }]);
    const b = agent('b', [{ id: 'other', action: 'Read' }]);
    const c = agent('c', [{ id: 'w', waitFor: [{ agent: 'a', item: 'build' }] }]);
    const d = agent('d', [{ id: 'back', waitFor: [{ agent: 'c', item: 'w' }] }]);
    const ribbons = ribbonsOf(lanesOf([d, a, b, c]));
    const spans = (gap: number) =>
      piecesIn(ribbons, gap).map(({ key, left, right }) => ({ key, left, right }));
    // d (lane 0) waits for c's wait (lane 3, line 2), leftwards past a and b, to line 3.
    // c's wait waits for a's build (lane 1, line 1), rightwards past b.
    expect([spans(0), spans(1), spans(2)]).toEqual([
      [{ key: 'd:back>c:w', left: lines(2, 3), right: lines(1.5, 1.5) }],
      [
        { key: 'd:back>c:w', left: lines(1.5, 1.5), right: lines(1.5, 1.5) },
        { key: 'c:w>a:build', left: lines(0, 1), right: lines(0.5, 0.5) },
      ],
      [
        { key: 'd:back>c:w', left: lines(1.5, 1.5), right: lines(1, 2) },
        { key: 'c:w>a:build', left: lines(0.5, 0.5), right: lines(1, 2) },
      ],
    ]);
  });

  it('marks the ribbons of waits that wait on each other as stuck', () => {
    const a = agent('a', [{ id: 'w', waitFor: [{ agent: 'b', item: 'w' }] }]);
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'w' }] },
      { id: 'later', waitFor: [{ agent: 'a' }] },
    ]);
    expect(ribbonsOf(lanesOf([a, b])).map(({ key, stuck }) => [key, stuck])).toEqual([
      ['a:w>b:w', true],
      ['b:w>a:w', true],
      ['b:later>a', false],
    ]);
  });
});
