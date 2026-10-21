import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { managerOf } from '../../../shared/model/queries';
import { entityOf } from '../../../shared/model/rows';
import type { EntityKey, NodeRow, Row, Rows, RowsChange } from '../../../shared/model/rows';

/*
 * What a commit changes of a canvas's document (B9 Design §4), as the change rules read it,
 * whatever op made it: each entity it touched, as it was and as it is, with the revision it had;
 * the agents it created and removed, those it made as copies of another, the agents it changed the
 * manager of; which agents existed before it; and the document before and after it, for what a
 * rule reads across entities (an item's place in its queue against an OK's).
 */

/** An entity a commit touched: its row before (none: it is new) and after (none: it is gone). */
export interface EntityChange {
  before: Row | null;
  after: Row | null;
  /** The revision it had: none for one that is new. */
  rev: number | null;
}

export interface ChangeSet {
  readonly canvas: CanvasId;
  readonly by: PartyId;
  readonly op: string;
  /** Each entity it touched, by key, in the order its rows are written. */
  readonly entities: ReadonlyMap<EntityKey, EntityChange>;
  /** The agents it created, and those it removed. */
  readonly created: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
  /** The agents it created as exact copies of another (spawnAgent's), new → source. */
  readonly copies: ReadonlyMap<string, string>;
  /** Each agent it kept whose manager (the nearest agent it is in) it changed: before, after. */
  readonly manager: ReadonlyMap<string, readonly [string | null, string | null]>;
  /** Whether `agent` was an agent before the commit. */
  existed(agent: string): boolean;
  /** The document before the commit, and after it. */
  readonly before: CanvasDocument;
  readonly after: CanvasDocument;
}

/** A canvas's document before a commit: its rows, and each entity's revision. */
export interface Before {
  document: CanvasDocument;
  rows: Rows;
  revs: ReadonlyMap<EntityKey, number>;
}

/** What `next` changes of `before`, made by op `op` of `by`, by `rows` (diffRows'). */
export function changeSetOf(
  before: Before,
  next: CanvasDocument,
  rows: RowsChange,
  { op, by }: { op: string; by: PartyId },
  copies: ReadonlyMap<string, string> = new Map(),
): ChangeSet {
  const entities = new Map<EntityKey, EntityChange>();
  const created = new Set<string>();
  const removed = new Set<string>();
  /** Whether a node came, went, or moved into another node or changed what it is. */
  let nested = false;
  for (const key of rows.changed) {
    const was = before.rows[key] ?? null;
    const is = rows.rows[key] ?? null;
    entities.set(key, { before: was, after: is, rev: before.revs.get(key) ?? null });
    if (entityOf(key) !== 'node') continue;
    const [old, now] = [was as NodeRow | null, is as NodeRow | null];
    // A node that keeps its id but becomes an agent (addParent's frame) is one created, and one
    // that stops being one is one removed.
    if (now?.kind === 'agent' && old?.kind !== 'agent') created.add(now.id);
    if (old?.kind === 'agent' && now?.kind !== 'agent') removed.add(old.id);
    if (old === null || now === null || old.parent !== now.parent || old.kind !== now.kind) {
      nested = true;
    }
  }
  const agents = new Set(
    before.document.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : [])),
  );
  const manager = new Map<string, readonly [string | null, string | null]>();
  if (nested) {
    for (const node of next.nodes) {
      if (node.type !== 'agent' || !agents.has(node.id)) continue;
      const was = managerOf(before.document.nodes, node.id) ?? null;
      const is = managerOf(next.nodes, node.id) ?? null;
      if (was !== is) manager.set(node.id, [was, is]);
    }
  }
  return {
    canvas: next.id,
    by,
    op,
    entities,
    created,
    removed,
    copies,
    manager,
    existed: (agent) => agents.has(agent),
    before: before.document,
    after: next,
  };
}
