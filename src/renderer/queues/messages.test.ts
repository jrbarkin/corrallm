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

it('reads a cancelled submission’s result from its durable reply, without rewriting the original', async () => {
  const { submissionOf } = await import('./messages');
  const original: MessageView = {
    id: crypto.randomUUID(),
    canvas: newCanvasId(),
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    body: 'Original',
    at: 1,
    state: 'replied',
    origin: 'manual',
  };
  const reply: MessageView = {
    ...original,
    id: crypto.randomUUID(),
    from: 'agent:a',
    to: 'you',
    body: 'Stopped',
    replyTo: original.id,
    state: 'delivered',
    turn: { status: 'cancelled', reason: 'interrupted' },
  };
  expect(submissionOf(original, [original, reply])).toMatchObject({
    id: original.id,
    status: 'cancelled',
    reply: 'Stopped',
    result: reply.turn,
  });
  expect(original.turn).toBeUndefined();
});

it('reconciles a native restart record with the observed live session without changing its mailbox row', () => {
  const node: CanvasNode = {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'A' },
  };
  const message: MessageView = {
    id: crypto.randomUUID(),
    canvas: newCanvasId(),
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    origin: 'manual',
    body: 'Live',
    at: 1,
    state: 'unresolved',
    turn: { status: 'cancelled', reason: 'connection-closed' },
  };
  const state = {
    items: { [message.id]: message },
    order: [MessageId.parse(message.id)],
    next: '',
  };
  const first = messageQueues([node], state, {
    agent: 'a',
    submissions: [{ id: message.id, text: 'Live', status: 'running' }],
  });
  expect(first[0]?.type === 'agent' && first[0].data.queue?.[0]).toMatchObject({
    submission: { status: 'running' },
  });
  expect(message.state).toBe('unresolved');
  const detached = messageQueues([node], state);
  expect(detached[0]?.type === 'agent' && detached[0].data.queue?.[0]).toMatchObject({
    submission: { status: 'cancelled', unresolved: true },
  });
});
