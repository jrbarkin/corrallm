import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { queueLinks } from './links';

const agent = (id: string, queue: QueueItem[]): GraphNode => ({
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
});
