import { describe, expect, it } from 'vitest';

import { NEW_SESSION } from '../../shared/model/session';
import type { GraphNode } from '../graph/graph';
import { checkedBy, unfit } from '../../shared/model/queue';
import { withSubmissions } from './submissions';

describe('live messages in queues', () => {
  it('keeps an authored If attached to its planned predecessor across a manual message', () => {
    const wait = { id: 'wait', waitFor: [{ agent: 'b' }] };
    const check = { id: 'if', if: { kind: 'timedOut' as const }, then: [] };
    const message = {
      id: 'manual',
      message: 'Keep waiting',
      submission: {
        id: 'manual',
        text: 'Keep waiting',
        status: 'completed' as const,
      },
    };
    const queue = [wait, message, check];
    expect(checkedBy(queue, 2)).toBe(wait);
    expect(unfit(queue, 2)).toBeUndefined();
  });
  it('places messages at the task they accompanied without changing the executable workflow', () => {
    const nodes: GraphNode[] = [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'A',
          queue: [
            { id: 'first', action: 'Read' },
            {
              id: 'loop',
              repeat: [{ id: 'inner', action: 'Test' }],
              until: { kind: 'succeeded' },
              rounds: 2,
              otherwise: 'ask',
            },
            { id: 'last', action: 'Write' },
          ],
        },
      },
    ];
    const original = structuredClone(nodes);
    const shown = withSubmissions(nodes, {
      a: {
        ...NEW_SESSION,
        submissions: [
          { id: 'chat', text: 'Start here', status: 'completed' },
          { id: 'feedback', text: 'Try this', status: 'running', after: 'inner' },
          { id: 'followup', text: 'And this', status: 'queued', after: 'inner' },
          { id: 'deleted', text: 'Kept after task removed', status: 'cancelled', after: 'gone' },
        ],
      },
    });
    expect(shown[0]?.data.queue?.map(({ id }) => id)).toEqual([
      'chat',
      'deleted',
      'first',
      'loop',
      'feedback',
      'followup',
      'last',
    ]);
    expect(nodes).toEqual(original);
    expect(nodes[0]?.data.queue).toHaveLength(3);
    expect(withSubmissions(nodes, {})).toEqual(nodes);
  });
});
