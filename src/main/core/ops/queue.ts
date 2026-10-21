import { randomUUID } from 'node:crypto';

import { ItemId } from '../../../shared/api/ids';
import {
  findItem,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isWait,
} from '../../../shared/model/queue';
import type { QueueChange, QueueItem } from '../../../shared/model/queue';
import * as queue from '../../../shared/model/queue-ops';
import { OpFailure } from '../call';
import type { Implementations } from '.';
import { requireAgent, withoutUndefined } from './agent-document';

function requireItem(items: readonly QueueItem[], id: string): QueueItem {
  const found = findItem(items, id)?.item;
  if (!found) throw new OpFailure('not-found', `There is no queue item ${id} on this agent.`);
  return found;
}
function listOf(items: readonly QueueItem[], id: string): readonly QueueItem[] | undefined {
  if (items.some((one) => one.id === id)) return items;
  for (const item of items) {
    const inner = isIf(item) ? item.then : isRepeat(item) ? item.repeat : undefined;
    if (inner?.some((one) => one.id === id)) return inner;
  }
  return undefined;
}
function accepts(item: QueueItem, change: QueueChange): boolean {
  switch (change.kind) {
    case 'message':
      return isMessage(item);
    case 'action':
    case 'instruction':
    case 'expect':
      return 'action' in item;
    case 'target':
      return isMessage(item) || 'action' in item;
    case 'condition':
      return isIf(item);
    case 'waitFor':
      return isWait(item);
    case 'time':
      return isWait(item) || (isDelay(item) && change.time !== null);
    case 'approve':
      return isApproval(item);
    case 'repeat':
      return isRepeat(item);
  }
}

export function queueOps(): Pick<
  Implementations,
  'queue.add' | 'queue.remove' | 'queue.move' | 'queue.update'
> {
  return {
    'queue.add': ({ canvas, agent, entry, into }, ctx) =>
      ctx.commit(canvas, (doc) => {
        const items = requireAgent(doc, agent).data.queue ?? [];
        if (into !== undefined) {
          const container = requireItem(items, into);
          const simple = 'message' in entry || 'action' in entry;
          const repeated = simple || 'waitFor' in entry || 'delay' in entry;
          if (
            !items.includes(container) ||
            !(isIf(container) ? simple : isRepeat(container) && repeated)
          )
            throw new OpFailure('invalid', 'That item cannot be added to this container.');
        }
        const built = queue.add(
          doc,
          { agent, entry: withoutUndefined(entry), ...(into === undefined ? {} : { into }) },
          ctx.by,
          randomUUID,
        );
        if (built.result.item === undefined)
          throw new OpFailure('invalid', 'That edit creates no queue item.');
        return { next: built.next, result: { id: ItemId.parse(built.result.item) } };
      }),
    'queue.remove': ({ canvas, agent, item }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireItem(requireAgent(doc, agent).data.queue ?? [], item);
        return queue.remove(doc, { agent, item });
      }),
    'queue.move': ({ canvas, agent, item, before, after }, ctx) =>
      ctx.commit(canvas, (doc) => {
        const items = requireAgent(doc, agent).data.queue ?? [];
        requireItem(items, item);
        if ((before === undefined) === (after === undefined))
          throw new OpFailure('invalid', 'Name exactly one before or after neighbour.');
        const neighbour = before ?? after;
        if (neighbour != null) {
          requireItem(items, neighbour);
          if (listOf(items, item) !== listOf(items, neighbour))
            throw new OpFailure('invalid', 'The neighbour must be in the item’s own list.');
        }
        return queue.move(doc, {
          agent,
          item,
          ...(before !== undefined ? { before } : { after: after ?? null }),
        });
      }),
    'queue.update': ({ canvas, agent, item, change }, ctx) =>
      ctx.commit(canvas, (doc) => {
        const found = requireItem(requireAgent(doc, agent).data.queue ?? [], item);
        if (!accepts(found, withoutUndefined(change)))
          throw new OpFailure('invalid', 'That change does not apply to this kind of queue item.');
        return queue.update(doc, { agent, item, change: withoutUndefined(change) }, ctx.by);
      }),
  };
}
