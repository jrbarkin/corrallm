import { describe, expect, it } from 'vitest';

import { MessageId } from '../../shared/api/ids';
import { isMessage } from '../../shared/model/queue';
import type { CanvasNode } from '../../shared/model/canvas';
import { evidenceFor, handoff, partyMessage, runSend } from '../../shared/model/test-b19';
import type { MessageView } from '../../shared/model/views';
import { messageQueues } from './messages';

/*
 * B19 X2: a queue hand-off for an agent is a read-only row in its queue, wherever the queue is
 * drawn (the card, the agent's work view, All queues: all read the same projected nodes), from its
 * sender and in its state, placed by where the recipient's run is. Nothing here changes what the
 * queue holds, and the row carries a `submission`, which no save, wait target or reorder reads.
 */

const QUEUE = [
  { id: 'one', action: 'Read' },
  { id: 'two', action: 'Bash' },
];

function nodesOf(queue: unknown[] = QUEUE): CanvasNode[] {
  return [
    { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Lead' } },
    { id: 'worker', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Worker', queue } },
  ] as CanvasNode[];
}

function topic(...views: MessageView[]) {
  return {
    items: Object.fromEntries(views.map((view) => [view.id, view])),
    order: views.map((view) => MessageId.parse(view.id)),
    next: '',
  };
}

function rowsOf(nodes: readonly CanvasNode[], id = 'worker') {
  const node = nodes.find((one) => one.id === id);
  return node?.type === 'agent' ? (node.data.queue ?? []) : [];
}

function running(current: string | undefined) {
  return {
    agents: {
      worker: { status: 'running' as const, outcomes: {}, ...(current ? { current } : {}) },
    },
  };
}

describe('queue hand-offs in the recipient’s queue', () => {
  it('leaves authored steps unread when the recipient has no mailbox rows', () => {
    let reads = 0;
    const nodes = nodesOf([
      {
        id: 'one',
        get action() {
          reads += 1;
          return 'Read';
        },
      },
    ]);
    const messages = topic();
    expect(messageQueues(nodes, messages)[1]).toBe(nodes[1]);
    expect(messageQueues(nodes, messages, undefined, running('one'))[1]).toBe(nodes[1]);
    expect(reads).toBe(0);
  });

  it('indexes mailbox rows once for all recipient queues and reuses that index as the run moves', () => {
    const nodes = Array.from({ length: 32 }, (_, i): CanvasNode => ({
      id: `agent-${String(i)}`,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: `Agent ${String(i)}`, queue: QUEUE },
    }));
    let recipients = 0;
    let replies = 0;
    const messages = topic(
      ...nodes.map(
        (node) =>
          new Proxy(handoff('agent-0', node.id), {
            get(target, key, receiver) {
              if (key === 'to') recipients += 1;
              if (key === 'replyTo') replies += 1;
              return Reflect.get(target, key, receiver) as unknown;
            },
          }),
      ),
    );
    messageQueues(nodes, messages);
    // One shared recipient/reply index, never a mailbox walk per agent or displayed row.
    expect(recipients).toBeLessThanOrEqual(64);
    expect(replies).toBeLessThanOrEqual(64);
    const before = { recipients, replies };
    messageQueues(nodes, messages, undefined, {
      agents: { 'agent-1': { current: 'one' } },
    });
    expect(recipients - before.recipients).toBeLessThanOrEqual(2);
    expect(replies - before.replies).toBeLessThanOrEqual(2);
  });

  it('keeps an unaffected recipient’s projected queue when another hand-off changes', () => {
    const nodes = nodesOf();
    const one = handoff('lead', 'worker');
    const other = handoff('worker', 'lead');
    const first = messageQueues(nodes, topic(one, other));
    const changed = messageQueues(nodes, topic({ ...one, state: 'delivered' }, other));
    expect(changed[0]).toBe(first[0]);
    expect(changed[1]).not.toBe(first[1]);
    expect(rowsOf(changed).find(({ id }) => id === one.id)).toMatchObject({
      submission: { status: 'running' },
    });
    // Removing the last incoming row restores the authored node, with no stale projection.
    expect(messageQueues(nodes, topic(other))[1]).toBe(nodes[1]);
  });

  it('shows a pending hand-off read-only, from its sender, after the task the recipient is on', () => {
    const offered = handoff('lead', 'worker', { item: 'hand' });
    const nodes = nodesOf();
    const rows = rowsOf(messageQueues(nodes, topic(offered), undefined, running('one')));
    expect(rows.map(({ id }) => id)).toEqual(['one', offered.id, 'two']);
    expect(rows[1]).toMatchObject({
      message: 'Review this',
      submission: { id: offered.id, status: 'queued', handoff: { from: 'Lead', item: 'hand' } },
    });
    // The authored queue is untouched: the row is a display of the run's message.
    expect(rowsOf(nodes).map(({ id }) => id)).toEqual(['one', 'two']);
  });

  it('sits after the if-then or repeat the recipient is inside, and at the end with no task', () => {
    const offered = handoff('lead', 'worker');
    const queue = [
      {
        id: 'if',
        if: { kind: 'outputContains', text: 'x' },
        then: [{ id: 'inner', message: 'In' }],
      },
      { id: 'after', action: 'Bash' },
    ];
    const inside = rowsOf(
      messageQueues(nodesOf(queue), topic(offered), undefined, running('inner')),
    );
    expect(inside.map(({ id }) => id)).toEqual(['if', offered.id, 'after']);
    const none = rowsOf(
      messageQueues(nodesOf(queue), topic(offered), undefined, running(undefined)),
    );
    expect(none.map(({ id }) => id)).toEqual(['if', 'after', offered.id]);
    const unrun = rowsOf(messageQueues(nodesOf(queue), topic(offered)));
    expect(unrun.map(({ id }) => id)).toEqual(['if', 'after', offered.id]);
  });

  it('shows what is received, withdrawn or unresolved, and drops what its turn ended', () => {
    const states = [
      'pending',
      'delivering',
      'delivered',
      'withdrawn',
      'unresolved',
      'replied',
    ] as const;
    const views = states.map((state) => handoff('lead', 'worker', { state }));
    const rows = rowsOf(messageQueues(nodesOf(), topic(...views), undefined, running('one')));
    expect(rows.flatMap((row) => (isMessage(row) ? [row.submission?.status] : []))).toEqual([
      'queued',
      'running',
      'running',
      'cancelled',
      'failed',
    ]);
  });

  it('never shows the run’s own sends, a hand-off’s evidence or another agent’s hand-offs', () => {
    const ended = handoff('lead', 'worker', { state: 'replied' });
    const elsewhere = handoff('worker', 'lead');
    const messages = topic(ended, evidenceFor(ended), runSend('worker'), elsewhere);
    const shown = messageQueues(nodesOf(), messages, undefined, running('one'));
    expect(rowsOf(shown).map(({ id }) => id)).toEqual(['one', 'two']);
    // The other agent's hand-off is for the lead; evidence goes to the sender, whose queue
    // does not show it either.
    expect(rowsOf(shown, 'lead').map(({ id }) => id)).toEqual([elsewhere.id]);
  });

  it('keeps your messages and a party’s where they were, beside a hand-off', () => {
    const offered = handoff('lead', 'worker');
    const typed = partyMessage('you', 'worker', { origin: 'manual', display: { after: 'one' } });
    const rows = rowsOf(messageQueues(nodesOf(), topic(typed, offered), undefined, running('one')));
    expect(rows.map(({ id }) => id)).toEqual(['one', typed.id, offered.id, 'two']);
  });

  it('is drawn again when its sender is renamed or the recipient moves on, and not otherwise', () => {
    const offered = handoff('lead', 'worker');
    const messages = topic(offered);
    const nodes = nodesOf();
    const first = messageQueues(nodes, messages, undefined, running('one'));
    expect(messageQueues(nodes, messages, undefined, running('one'))[1]).toBe(first[1]);
    const moved = messageQueues(nodes, messages, undefined, running('two'));
    expect(rowsOf(moved).map(({ id }) => id)).toEqual(['one', 'two', offered.id]);
    const renamed = nodes.map((node) =>
      node.id === 'lead' && node.type === 'agent'
        ? { ...node, data: { ...node.data, label: 'Boss' } }
        : node,
    );
    const again = rowsOf(messageQueues(renamed, messages, undefined, running('one')));
    expect(again[1]).toMatchObject({ submission: { handoff: { from: 'Boss' } } });
  });
});
