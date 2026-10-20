import { describe, expect, it } from 'vitest';

import type { AgentNode } from '../../shared/model/canvas';
import type { QueueItem } from '../../shared/model/queue';
import { lanesOf } from './lanes';
import type { LinkEnd } from './lanes';
import { piecesIn, ribbonsOf } from './ribbons';
import type { Span } from './ribbons';

const agent = (id: string, queue: QueueItem[] = []): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

const span = (top: number, bottom: number): Span => ({ top, bottom });

/** Where each task is, as the view measures them: by `lane/item`, `lane/end` for a lane's end. */
const at =
  (spans: Record<string, Span>) =>
  (end: LinkEnd): Span | undefined =>
    spans[`${end.lane}/${end.item ?? 'end'}`];

describe('ribbonsOf', () => {
  it('runs a wait from the task it waits for to the wait, and narrows work handed on', () => {
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
    const spans = at({
      'a/if': span(40, 120),
      'a/hand': span(90, 110),
      'a/end': span(130, 150),
      'b/w': span(160, 190),
      'b/all': span(200, 230),
    });
    const ribbons = ribbonsOf(lanesOf([a, b]), spans);
    expect(ribbons.map(({ key, kind, from, to }) => ({ key, kind, from, to }))).toEqual([
      // A step of the if-then, handed to b: it narrows to a point in b's lane, level with it.
      {
        key: 'a:hand>b',
        kind: 'handoff',
        from: { lane: 0, span: span(90, 110) },
        to: { lane: 1, span: span(100, 100) },
      },
      // The wait for the if-then, from all of it.
      {
        key: 'b:w>a:if',
        kind: 'wait',
        from: { lane: 0, span: span(40, 120) },
        to: { lane: 1, span: span(160, 190) },
      },
      // The wait for all of a's work, from the end of a's lane.
      {
        key: 'b:all>a',
        kind: 'wait',
        from: { lane: 0, span: span(130, 150) },
        to: { lane: 1, span: span(200, 230) },
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
    const ribbons = ribbonsOf(
      lanesOf([d, a, b, c]),
      at({ 'a/build': span(0, 20), 'c/w': span(40, 60), 'd/back': span(80, 100) }),
    );
    const spans = (gap: number) =>
      piecesIn(ribbons, gap).map(({ key, left, right }) => ({ key, left, right }));
    // d (lane 0) waits for c's wait (lane 3), leftwards past a and b.
    // c's wait waits for a's build (lane 1), rightwards past b.
    expect([spans(0), spans(1), spans(2)]).toEqual([
      [{ key: 'd:back>c:w', left: span(80, 100), right: span(50, 50) }],
      [
        { key: 'd:back>c:w', left: span(50, 50), right: span(50, 50) },
        { key: 'c:w>a:build', left: span(0, 20), right: span(10, 10) },
      ],
      [
        { key: 'd:back>c:w', left: span(50, 50), right: span(40, 60) },
        { key: 'c:w>a:build', left: span(10, 10), right: span(40, 60) },
      ],
    ]);
  });

  it('marks the ribbons of waits that wait on each other as stuck', () => {
    const a = agent('a', [{ id: 'w', waitFor: [{ agent: 'b', item: 'w' }] }]);
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'w' }] },
      { id: 'later', waitFor: [{ agent: 'a' }] },
    ]);
    const spans = at({
      'a/w': span(0, 20),
      'a/end': span(30, 40),
      'b/w': span(0, 20),
      'b/later': span(50, 70),
    });
    expect(ribbonsOf(lanesOf([a, b]), spans).map(({ key, stuck }) => [key, stuck])).toEqual([
      ['a:w>b:w', true],
      ['b:w>a:w', true],
      ['b:later>a', false],
    ]);
  });

  it('marks the ribbon of a wait with a time limit, in every gap it crosses', () => {
    const a = agent('a', [{ id: 'build', action: 'Edit' }]);
    const b = agent('b', [{ id: 'other', action: 'Read' }]);
    const c = agent('c', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'build' }], timeout: { seconds: 1800 } },
      { id: 'all', waitFor: [{ agent: 'a' }] },
    ]);
    const ribbons = ribbonsOf(
      lanesOf([a, b, c]),
      at({
        'a/build': span(0, 20),
        'a/end': span(30, 40),
        'c/w': span(50, 70),
        'c/all': span(80, 90),
      }),
    );
    expect(ribbons.map(({ key, timed }) => [key, timed])).toEqual([
      ['c:w>a:build', true],
      ['c:all>a', false],
    ]);
    expect(piecesIn(ribbons, 1).map(({ key, timed }) => [key, timed])).toEqual([
      ['c:w>a:build', true],
      ['c:all>a', false],
    ]);
  });
});
