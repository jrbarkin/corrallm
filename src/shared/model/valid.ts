import { adapterIn } from '../adapter';
import type { AdapterId, Catalog } from '../adapter';
import type { CanvasDocument, CanvasNode } from './canvas';
import { nodeFault } from './file';
import { agentName } from './queries';
import { findItem, isIf, isMessage, isRepeat, isRepeatEnds, isWait } from './queue';
import type { QueueItem } from './queue';
import { entityOf } from './rows';
import type { EntityKey, ItemRow, NodeRow, Row } from './rows';

/*
 * What a change to a canvas's document must hold to, whoever makes it (revision R34, B9 Design
 * §4): what it touched, as its canvas's file would hold it (fromFile's reading of each node it
 * changed, and of each agent whose queue it changed); each step it wrote (one it added, or whose
 * fields it changed) naming an action its agent's adapter declares; and what each item it wrote
 * names, there: the agent it goes to, what a wait waits for, the repeat one goes round with. What
 * it only moved, or left as it was, is read as it was: an older file's step keeps its action until
 * someone rewrites it. An adapter this build lacks declares nothing it can read, so its steps keep
 * theirs. Nothing here reads who wrote an item (`by`).
 */

/** What a change touched: each entity, as it was and is (none: added, or removed). */
export type Touched = ReadonlyMap<EntityKey, { before: Row | null; after: Row | null }>;

/** Why `next`, by what `touched` changed of it, can't be kept, in a sentence; undefined if it can. */
export function editFault(
  next: CanvasDocument,
  touched: Touched,
  catalog: Catalog,
  defaultAdapter: AdapterId,
): string | undefined {
  const nodes = new Map(next.nodes.map((node) => [node.id, node]));
  const read = new Set<string>();
  const written = new Map<string, Set<string>>();
  for (const [key, { before, after }] of touched) {
    if (after === null) continue;
    const entity = entityOf(key);
    if (entity === 'node') read.add((after as NodeRow).id);
    if (entity !== 'item') continue;
    const row = after as ItemRow;
    read.add(row.agent);
    if (before !== null && JSON.stringify((before as ItemRow).body) === JSON.stringify(row.body)) {
      continue;
    }
    const ids = written.get(row.agent) ?? new Set<string>();
    ids.add(row.id);
    written.set(row.agent, ids);
  }
  for (const id of read) {
    const node = nodes.get(id);
    const fault = node && nodeFault(node, catalog, defaultAdapter);
    if (fault) return `That change can’t be kept: ${fault}.`;
  }
  for (const [id, ids] of written) {
    const node = nodes.get(id);
    if (node?.type !== 'agent') continue;
    for (const item of itemsOf(node.data.queue ?? [])) {
      if (!ids.has(item.id)) continue;
      const fault = itemFault(next.nodes, node, item, catalog, defaultAdapter);
      if (fault) return fault;
    }
  }
  return undefined;
}

/** Why `item`, which a change wrote in `owner`'s queue, can't be kept; undefined if it can. */
function itemFault(
  nodes: readonly CanvasNode[],
  owner: CanvasNode,
  item: QueueItem,
  catalog: Catalog,
  defaultAdapter: AdapterId,
): string | undefined {
  const agentOf = (id: string) => {
    const node = nodes.find((one) => one.id === id);
    return node?.type === 'agent' ? node : undefined;
  };
  if ('action' in item) {
    const adapter = adapterIn(
      catalog,
      (owner.type === 'agent' ? owner.data.adapter : undefined) ?? defaultAdapter,
    );
    if (adapter && !adapter.actions.some(({ name }) => name === item.action)) {
      return `${adapter.name} declares no action "${item.action}", so ${agentName(nodes, owner.id)} can’t take that step (${item.id}).`;
    }
  }
  if ((isMessage(item) || 'action' in item) && item.target !== undefined) {
    if (!agentOf(item.target)) return `There is no agent ${item.target} for ${item.id} to go to.`;
  }
  if (isWait(item)) {
    for (const { agent, item: awaited } of item.waitFor) {
      const node = agentOf(agent);
      if (!node) return `There is no agent ${agent} for ${item.id} to wait for.`;
      if (awaited !== undefined && !findItem(node.data.queue ?? [], awaited)) {
        return `${agentName(nodes, agent)} has no queue item ${awaited} for ${item.id} to wait for.`;
      }
    }
  }
  if (isRepeat(item) && isRepeatEnds(item.until)) {
    const { agent, item: leader } = item.until;
    const node = agentOf(agent);
    if (!node) return `There is no agent ${agent} for ${item.id} to go round with.`;
    const found = findItem(node.data.queue ?? [], leader)?.item;
    if (!found || !isRepeat(found)) {
      return `${agentName(nodes, agent)} has no repeat ${leader} for ${item.id} to go round with.`;
    }
  }
  return undefined;
}

/** A queue's items, at any depth: what each if-then and repeat holds after it. */
function itemsOf(queue: readonly QueueItem[]): QueueItem[] {
  return queue.flatMap((item) => [
    item,
    ...(isIf(item) ? item.then : isRepeat(item) ? item.repeat : []),
  ]);
}
