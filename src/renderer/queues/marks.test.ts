import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import type { AgentRun } from '../run/runner';
import { lanesOf } from './lanes';
import { queueMarks } from './marks';

const agent = (id: string, queue: QueueItem[]): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

const layout = lanesOf([
  agent('a', [
    { id: 'build', message: 'Build it' },
    { id: 'ok', approve: '' },
  ]),
  agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'ok' }] }]),
]);
const marksOf = (a: AgentRun, { running = true, asking = [] as string[] } = {}) =>
  queueMarks(layout, { running, agents: { a } }, new Set(asking));

describe('queueMarks', () => {
  it('marks an OK, and the row the run holds for the user to decide at', () => {
    const marks = marksOf({
      current: 'ok',
      status: 'asking',
      outcomes: { build: 'succeeded' },
      changes: { ok: ['Cover the empty state', 'And the error state'] },
    });
    expect(marks('a', 'ok')).toMatchObject({
      'data-mark': 'ok',
      'data-waited-for': '',
      'data-run': 'asking',
      'data-decide': '',
      'data-asked': 'And the error state',
      'data-asked-times': '2',
    });
    expect(marks('a', 'build')['data-decide']).toBeUndefined();
    expect(marks('b', 'w')['data-mark']).toBe('wait');
  });

  it('leaves a decision to the run alone: not while its agent asks permission, nor once stopped', () => {
    // A permission prompt in a task, or in the turn that makes the changes asked for at the OK.
    const task = marksOf({ current: 'build', status: 'running', outcomes: {} }, { asking: ['a'] });
    expect(task('a', 'build')).toMatchObject({ 'data-run': 'asking', 'data-decide': undefined });
    const changing = marksOf(
      { current: 'ok', status: 'running', outcomes: {}, changes: { ok: ['More tests'] } },
      { asking: ['a'] },
    );
    expect(changing('a', 'ok')).toMatchObject({
      'data-run': 'asking',
      'data-decide': undefined,
      'data-asked': 'More tests',
      'data-asked-times': undefined,
    });
    const stopped = marksOf({ current: 'ok', status: 'asking', outcomes: {} }, { running: false });
    expect(stopped('a', 'ok')).toMatchObject({ 'data-run': 'stopped', 'data-decide': undefined });
  });
});
