import { describe, expect, it } from 'vitest';

import type { AgentNode } from '../../shared/model/canvas';
import type { QueueItem } from '../../shared/model/queue';
import { queueLinks } from './links';

const agent = (id: string, queue: QueueItem[]): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

describe('queueLinks', () => {
  it('links each wait in either queue to what it waits for in the other', () => {
    const a = agent('a', [
      { id: 'research', action: 'Workflow' },
      { id: 'w', waitFor: [{ agent: 'b', item: 'build' }] },
    ]);
    const b = agent('b', [
      { id: 'build', action: 'Edit' },
      { id: 'x', waitFor: [{ agent: 'a', item: 'research' }, { agent: 'a' }, { agent: 'c' }] },
    ]);
    // b's view: its own queue, and a's beside.
    expect(queueLinks(b, a)).toEqual([
      {
        key: 'x>research',
        from: { column: 'peer', item: 'research' },
        to: { column: 'own', item: 'x' },
      },
      // All of a's work: from the end of a's queue.
      { key: 'x>end', from: { column: 'peer', item: null }, to: { column: 'own', item: 'x' } },
      { key: 'w>build', from: { column: 'own', item: 'build' }, to: { column: 'peer', item: 'w' } },
    ]);
  });

  it('links waits inside repeats, and what they wait for inside repeats', () => {
    const round = (id: string, repeat: QueueItem[]): QueueItem => ({
      id,
      repeat: repeat as Extract<QueueItem, { repeat: unknown }>['repeat'],
      until: { kind: 'succeeded' },
      rounds: 3,
      otherwise: 'ask',
    });
    const coder = agent('coder', [
      round('work', [
        { id: 'implement', action: 'Edit' },
        { id: 'reviewed', waitFor: [{ agent: 'reviewer', item: 'review' }] },
      ]),
    ]);
    const reviewer = agent('reviewer', [
      round('reviewing', [
        { id: 'ready', waitFor: [{ agent: 'coder', item: 'implement' }] },
        { id: 'review', action: 'Read' },
      ]),
    ]);
    expect(queueLinks(coder, reviewer)).toEqual([
      {
        key: 'reviewed>review',
        from: { column: 'peer', item: 'review' },
        to: { column: 'own', item: 'reviewed' },
      },
      {
        key: 'ready>implement',
        from: { column: 'own', item: 'implement' },
        to: { column: 'peer', item: 'ready' },
      },
    ]);
  });
});
