import { expect, it } from 'vitest';
import { MessageId } from '../../shared/api/ids';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasNode } from '../../shared/model/canvas';
import type { MessageView } from '../../shared/model/views';
import { messageQueues } from './messages';

it('projects mailbox rows without changing or dispatching the authored queue', () => {
  const nodes: CanvasNode[] = [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'A', queue: [{ id: 'task', message: 'Authored' }] },
    },
  ];
  const message: MessageView = {
    id: crypto.randomUUID(),
    canvas: newCanvasId(),
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    body: 'Manual',
    at: 1,
    state: 'replied',
    origin: 'manual',
    display: { after: 'task' },
    turn: { status: 'completed', reason: 'completed' },
  };
  const state = {
    items: { [message.id]: message },
    order: [MessageId.parse(message.id)],
    next: '',
  };
  const view = messageQueues(nodes, state);
  expect(view[0]?.type === 'agent' && view[0].data.queue?.map((row) => row.id)).toEqual([
    'task',
    message.id,
  ]);
  expect(nodes[0]?.type === 'agent' && nodes[0].data.queue).toEqual([
    { id: 'task', message: 'Authored' },
  ]);
  expect(messageQueues(nodes, state)[0]).toBe(view[0]);
  expect(messageQueues(nodes, { items: {}, order: [], next: '' })[0]).toBe(nodes[0]);
});
