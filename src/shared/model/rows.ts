import type { AdapterId, ConnectionId } from '../adapter';
import type { CanvasId } from '../canvas';
import type { AgentSettings } from '../session';
import { MAX_POSITION } from './canvas';
import type { AgentData, CanvasDocument, CanvasNode, Link } from './canvas';
import { inFileOrder } from './file';
import { isApproval, isDelay, isIf, isRepeat, isWait } from './queue';
import type { QueueItem, QueueRepeat, RepeatedItem } from './queue';

/*
 * A canvas's document as rows (B9 Design §2): what the core keeps it in (core.db's document, node,
 * link and queue_item) and what its `canvas:<c>` topic carries, read back by one function wherever
 * it is read (fromRows). One row an entity, each under its key:
 *
 *   node/<id>           an agent or a frame
 *   link/<a>/<b>        a link between two agents: the lesser id first, by code point (as SQLite
 *                       compares text), whichever end it was drawn from
 *   item/<agent>/<id>   an item of an agent's queue, at any depth (ids are unique across a queue)
 *   meta                what the document says of itself: whether it is arranged
 *
 * each id escaped as Needs ids are (encodeURIComponent), so that a slash in one never runs into
 * what follows. An item's fields but its id, and the items it holds, are its body (never a live
 * submission's record, which only a view shows); its settings and body are written in a file's
 * order (file.ts), so rows depend only on what the document means.
 *
 * Rows keep their order as places, numbers: a node's among the canvas's nodes, a link's among its
 * links, an item's among its queue's, or the if-then's or repeat's that holds it. A row keeps its
 * place while its order among the others holds, so moving an item rewrites its row alone, and one
 * added between two takes a place between theirs. A list whose places ran out (no number lies
 * between two) is numbered anew, which changes no entity.
 *
 * Plain data, free of Node, Electron and the DOM: it is compiled into every process.
 */

/** An entity of a document: `node/<id>`, `link/<a>/<b>`, `item/<agent>/<id>` or `meta`. */
export type EntityKey = string;

/** What the document says of itself. */
export const META: EntityKey = 'meta';

/** An agent or a frame: what it is, where it sits (in its parent, if it has one) and its order. */
export interface NodeRow {
  id: string;
  kind: 'agent' | 'frame';
  parent?: string;
  place: number;
  label: string;
  x: number;
  y: number;
  color?: number;
  adapter?: AdapterId;
  connection?: ConnectionId;
  settings?: Partial<Record<AdapterId, AgentSettings>>;
  role?: string;
}

/** A link between agents `a` and `b` (a before b), drawn from `source` between its `dots`. */
export interface LinkRow {
  a: string;
  b: string;
  source: string;
  dots?: [from: string, to: string];
  place: number;
}

/** What a queue item is. */
export type ItemKind = 'step' | 'message' | 'if' | 'wait' | 'delay' | 'approval' | 'repeat';

/** A queue item of `agent`'s: in its queue, or in the if-then or repeat (`container`) holding it. */
export interface ItemRow {
  agent: string;
  id: string;
  container?: string;
  place: number;
  kind: ItemKind;
  /** Its fields but its id and the items it holds: JSON. */
  body: Readonly<Record<string, unknown>>;
}

/** What the document says of itself. */
export interface MetaRow {
  arrange: boolean;
}

export type Row = NodeRow | LinkRow | ItemRow | MetaRow;

/** A placed row, before it is placed. */
type Unplaced = Omit<NodeRow, 'place'> | Omit<LinkRow, 'place'> | Omit<ItemRow, 'place'>;

/** A document's rows, by key. */
export type Rows = Readonly<Record<EntityKey, Row>>;

/** What a document's change is to its rows. */
export interface RowsChange {
  /** The rows it is kept in now. */
  rows: Record<EntityKey, Row>;
  /**
   * The entities it changed, in the order of its rows, then of those removed: added, removed,
   * moved among their siblings, or changed in more than their place.
   */
  changed: EntityKey[];
  /** The rows whose place alone was numbered anew: written again, though no entity changed. */
  renumbered: EntityKey[];
}

const escape = encodeURIComponent;

export function nodeKey(id: string): EntityKey {
  return `node/${escape(id)}`;
}

export function linkKey(one: string, other: string): EntityKey {
  const [a, b] = ends(one, other);
  return `link/${escape(a)}/${escape(b)}`;
}

export function itemKey(agent: string, id: string): EntityKey {
  return `item/${escape(agent)}/${escape(id)}`;
}

/** What `key` names: a node, a link, an item or the document's meta. Throws for anything else. */
export function entityOf(key: EntityKey): 'node' | 'link' | 'item' | 'meta' {
  if (key === META) return 'meta';
  const [kind] = key.split('/', 1);
  if (kind === 'node' || kind === 'link' || kind === 'item') return kind;
  throw new Error(`${key} names no entity of a canvas`);
}

/** The ends of a link between `one` and `other`, as its row keeps them: the lesser first. */
export function ends(one: string, other: string): [a: string, b: string] {
  return byCodePoint(one, other) <= 0 ? [one, other] : [other, one];
}

/** The rows `document` is kept in, placed after `before`'s, the rows it was kept in. */
export function toRows(document: CanvasDocument, before: Rows = {}): Record<EntityKey, Row> {
  return placed(document, before).rows;
}

/**
 * What `next` changes of a document kept in `before`. With `was`, the document `before` keeps, what
 * `next` shares with it (the same list, node, link or item) is taken as it was, its row not made
 * nor compared again: an op that changes one entity, keeping the objects it doesn't change, makes
 * one row anew. The change is the same either way.
 */
export function diffRows(before: Rows, next: CanvasDocument, was?: CanvasDocument): RowsChange {
  const { rows, moved, shared } = placed(next, before, was);
  const changed: EntityKey[] = [];
  const renumbered: EntityKey[] = [];
  for (const [key, row] of Object.entries(rows)) {
    const prior = before[key];
    if (prior === undefined || moved.has(key)) changed.push(key);
    else if (shared.has(key)) {
      if (row !== prior) renumbered.push(key);
    } else if (!same(unplaced(prior), unplaced(row))) changed.push(key);
    else if (!same(prior, row)) renumbered.push(key);
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(rows, key)) changed.push(key);
  return { rows, changed, renumbered };
}

/**
 * The document canvas `id`'s rows hold. Throws, naming the row, for rows that hold no canvas: an
 * item of no agent, or inside nothing of its agent's or what holds no items; a node inside nothing
 * or inside itself; a link to what is no agent.
 */
export function fromRows(id: CanvasId, rows: Rows): CanvasDocument {
  let arrange = false;
  const nodeRows: NodeRow[] = [];
  const linkRows: [EntityKey, LinkRow][] = [];
  const itemRows: [EntityKey, ItemRow][] = [];
  for (const [key, row] of Object.entries(rows)) {
    const entity = entityOf(key);
    if (entity === 'meta') arrange = (row as MetaRow).arrange;
    else if (entity === 'node') nodeRows.push(row as NodeRow);
    else if (entity === 'link') linkRows.push([key, row as LinkRow]);
    else itemRows.push([key, row as ItemRow]);
  }
  const byId = new Map(nodeRows.map((row) => [row.id, row]));

  // Each item under what holds it: its agent's node (its queue), or an if-then's or repeat's item.
  const held = new Map<EntityKey, ItemRow[]>();
  for (const [key, row] of itemRows) {
    if (byId.get(row.agent)?.kind !== 'agent') throw new Error(`${key}: its agent isn’t there`);
    const holder =
      row.container === undefined ? nodeKey(row.agent) : itemKey(row.agent, row.container);
    held.set(holder, [...(held.get(holder) ?? []), row]);
  }
  let read = 0;
  const inside = (holder: EntityKey) => (held.get(holder) ?? []).sort(byPlace).map(itemOf);
  function itemOf(row: ItemRow): QueueItem {
    read += 1;
    const inner = inside(itemKey(row.agent, row.id));
    const item = { id: row.id, ...row.body };
    if (row.kind === 'if') return { ...item, then: inner } as QueueItem;
    if (row.kind === 'repeat') {
      return { id: row.id, repeat: inner as RepeatedItem[], ...row.body } as QueueRepeat;
    }
    if (inner.length > 0) {
      throw new Error(`${itemKey(row.agent, row.id)}: ${HOLDERS[row.kind]} holds no items`);
    }
    return item as QueueItem;
  }

  const nodes = parentsFirst(nodeRows.sort(byPlace), byId).map((row): CanvasNode => {
    const at = {
      id: row.id,
      position: { x: row.x, y: row.y },
      ...(row.parent === undefined ? {} : { parentId: row.parent }),
    };
    const color = row.color === undefined ? {} : { color: row.color };
    if (row.kind === 'frame') return { ...at, type: 'frame', data: { label: row.label, ...color } };
    const queue = inside(nodeKey(row.id));
    const data: AgentData = {
      label: row.label,
      ...(row.adapter === undefined ? {} : { adapter: row.adapter }),
      ...(row.connection === undefined ? {} : { connection: row.connection }),
      ...(row.settings === undefined ? {} : { settings: row.settings }),
      ...(row.role === undefined ? {} : { role: row.role }),
      ...color,
      ...(queue.length === 0 ? {} : { queue }),
    };
    return { ...at, type: 'agent', data };
  });
  if (read < itemRows.length) {
    const lost = itemRows.find(([, row]) => !reached(row, held, byId));
    throw new Error(`${lost?.[0] ?? 'An item'}: what holds it isn’t there`);
  }

  const links = linkRows
    .sort(([, x], [, y]) => byPlace(x, y))
    .map(([key, row]): Link => {
      if (byId.get(row.a)?.kind !== 'agent' || byId.get(row.b)?.kind !== 'agent') {
        throw new Error(`${key}: one of its agents isn’t there`);
      }
      const target = row.source === row.a ? row.b : row.a;
      return { source: row.source, target, ...(row.dots ? { dots: row.dots } : {}) };
    });
  return { id, arrange, nodes, links };
}

/**
 * What keeps `document` from the rows it would be kept in, which would read back as another
 * document (fromRows), naming the row: two nodes of one id, a node inside one that isn't there or
 * that comes after it, a link to what is no agent, from an agent to itself or between agents linked
 * already, two items of one id in a queue. Undefined if nothing does.
 */
export function rowsFault(document: CanvasDocument): string | undefined {
  const kinds = new Map<string, CanvasNode['type']>();
  for (const node of document.nodes) {
    const key = nodeKey(node.id);
    if (
      [node.position.x, node.position.y].some(
        (value) => !Number.isFinite(value) || Math.abs(value) > MAX_POSITION,
      )
    )
      return `${key}: its position must be within ±${String(MAX_POSITION)} on each axis`;
    if (kinds.has(node.id)) return `${key}: two nodes have this id`;
    if (node.parentId !== undefined && !kinds.has(node.parentId)) {
      return document.nodes.some((one) => one.id === node.parentId)
        ? `${key}: it comes before its parent`
        : `${key}: its parent isn’t there`;
    }
    kinds.set(node.id, node.type);
  }
  const linked = new Set<EntityKey>();
  for (const { source, target } of document.links) {
    const key = linkKey(source, target);
    if (kinds.get(source) !== 'agent' || kinds.get(target) !== 'agent') {
      return `${key}: one of its agents isn’t there`;
    }
    if (source === target) return `${key}: it links an agent to itself`;
    if (linked.has(key)) return `${key}: the agents are linked twice`;
    linked.add(key);
  }
  for (const node of document.nodes) {
    if (node.type !== 'agent') continue;
    const ids = new Set<string>();
    for (const item of everyItemOf(node.data.queue ?? [])) {
      if (ids.has(item.id))
        return `${itemKey(node.id, item.id)}: two items of its queue have this id`;
      ids.add(item.id);
    }
  }
  return undefined;
}

/** What holds no items says so as: */
const HOLDERS: Record<Exclude<ItemKind, 'if' | 'repeat'>, string> = {
  step: 'a step',
  message: 'a message',
  wait: 'a wait',
  delay: 'a delay',
  approval: 'an OK',
};

/**
 * The document's rows, each placed after its row in `before`; the entities that moved; and those
 * whose rows are `before`'s but for their place (`shared`): with `was`, the document `before`
 * keeps, those of the nodes, links and items `document` shares with it, which it doesn't read.
 */
function placed(
  document: CanvasDocument,
  before: Rows,
  was?: CanvasDocument,
): { rows: Record<EntityKey, Row>; moved: Set<EntityKey>; shared: Set<EntityKey> } {
  const rows: Record<EntityKey, Row> = { [META]: { arrange: document.arrange } };
  const moved = new Set<EntityKey>();
  const shared = new Set<EntityKey>();
  /**
   * The places of a list's entities, by key: each its place in `before`, while its order among
   * them holds (`prior`: its place there, if it was in this list). A list `was` shares (`same`)
   * keeps every place it had.
   */
  const placesOf = (
    keys: EntityKey[],
    prior: (row: Row) => number | undefined,
    same = false,
  ): Map<EntityKey, number> => {
    const had = keys.map((key) => {
      const row = before[key];
      return row === undefined ? undefined : prior(row);
    });
    if (same && had.every((place) => place !== undefined)) {
      return new Map(keys.map((key, i) => [key, had[i] ?? i]));
    }
    const { at, kept } = places(had);
    keys.forEach((key, i) => {
      if (had[i] !== undefined && !kept.has(i)) moved.add(key);
    });
    return new Map(keys.map((key, i) => [key, at[i] ?? i]));
  };
  /**
   * Keeps an entity's row: `before`'s, at `place`, if `reused` (an object `was` shares) and it has
   * one; else made anew.
   */
  const keep = (key: EntityKey, place: number, reused: boolean, make: () => Unplaced) => {
    const prior = reused ? before[key] : undefined;
    if (prior === undefined) {
      rows[key] = { ...make(), place };
      return;
    }
    rows[key] = (prior as NodeRow).place === place ? prior : { ...prior, place };
    shared.add(key);
  };
  const own = (row: Row) => (row as NodeRow | LinkRow).place;

  const wasNodes = new Map(was?.nodes.map((node) => [node.id, node]));
  const nodeKeys = document.nodes.map((node) => nodeKey(node.id));
  const nodePlaces = placesOf(nodeKeys, own, document.nodes === was?.nodes);
  document.nodes.forEach((node, i) => {
    const key = nodeKeys[i] ?? nodeKey(node.id);
    keep(key, nodePlaces.get(key) ?? i, wasNodes.get(node.id) === node, () => nodeRow(node));
  });

  const linkKeys = document.links.map(({ source, target }) => linkKey(source, target));
  const wasLinks = new Map(was?.links.map((link) => [linkKey(link.source, link.target), link]));
  const linkPlaces = placesOf(linkKeys, own, document.links === was?.links);
  document.links.forEach((link, i) => {
    const key = linkKeys[i] ?? linkKey(link.source, link.target);
    keep(key, linkPlaces.get(key) ?? i, wasLinks.get(key) === link, () => linkRow(link));
  });

  for (const node of document.nodes) {
    if (node.type !== 'agent') continue;
    const agent = node.id;
    const wasNode = wasNodes.get(agent);
    const wasQueue = wasNode?.type === 'agent' ? wasNode.data.queue : undefined;
    /** The items `was` holds in this agent's queue, at any depth, by id: read once needed. */
    let wasItems: Map<string, QueueItem> | undefined;
    const wasItem = (id: string) => {
      wasItems ??= new Map(everyItemOf(wasQueue ?? []).map((item) => [item.id, item]));
      return wasItems.get(id);
    };
    /**
     * Places a list of items held by `container` (none: the queue), and what each holds, `wasList`
     * the list `was` holds there.
     */
    const list = (
      items: readonly QueueItem[],
      container: string | undefined,
      wasList: readonly QueueItem[] | undefined,
    ) => {
      const keys = items.map((item) => itemKey(agent, item.id));
      const at = placesOf(
        keys,
        (row) => ((row as ItemRow).container === container ? (row as ItemRow).place : undefined),
        items === wasList,
      );
      items.forEach((item, i) => {
        const key = keys[i] ?? itemKey(agent, item.id);
        const prior = items === wasList ? item : was && wasItem(item.id);
        const reused =
          prior === item && (before[key] as ItemRow | undefined)?.container === container;
        keep(key, at.get(key) ?? i, reused, () => itemRow(agent, item, container));
        const inner = (one: QueueItem | undefined) =>
          one === undefined
            ? undefined
            : isIf(one)
              ? one.then
              : isRepeat(one)
                ? one.repeat
                : undefined;
        if (isIf(item)) list(item.then, item.id, inner(prior));
        else if (isRepeat(item)) list(item.repeat, item.id, inner(prior));
      });
    };
    list(node.data.queue ?? [], undefined, wasQueue);
  }
  return { rows, moved, shared };
}

/** A queue's items, at any depth: each if-then's and repeat's after it. */
function everyItemOf(queue: readonly QueueItem[]): QueueItem[] {
  return queue.flatMap((item): QueueItem[] =>
    isIf(item) ? [item, ...item.then] : isRepeat(item) ? [item, ...item.repeat] : [item],
  );
}

/**
 * Places for a list whose entities were placed at `was` (none: new to the list): those whose
 * order holds (the longest run of increasing places, `kept`) keep theirs; each other takes one
 * between its kept neighbours'. If no number lies between two, the list is numbered anew.
 */
function places(was: readonly (number | undefined)[]): { at: number[]; kept: Set<number> } {
  const kept = increasing(was);
  const at: number[] = [];
  for (let i = 0; i < was.length;) {
    if (kept.has(i)) {
      at.push(was[i] ?? i);
      i += 1;
      continue;
    }
    let end = i;
    while (end < was.length && !kept.has(end)) end += 1;
    const low = at.at(-1);
    const high = end < was.length ? was[end] : undefined;
    const count = end - i;
    for (let n = 1; n <= count; n++) {
      if (low !== undefined && high !== undefined) at.push(low + ((high - low) * n) / (count + 1));
      else if (low !== undefined) at.push(low + n);
      else if (high !== undefined) at.push(high - (count + 1 - n));
      else at.push(n - 1);
    }
    i = end;
  }
  const ascending = at.every((place, i) => i === 0 || place > (at[i - 1] ?? place));
  return { at: ascending ? at : at.map((_, i) => i), kept };
}

/** The indices of the longest run of strictly increasing values (those given), in order. */
function increasing(values: readonly (number | undefined)[]): Set<number> {
  /** For each length, the index of the least value ending a run of it. */
  const tails: number[] = [];
  const previous = new Map<number, number | undefined>();
  values.forEach((value, i) => {
    if (value === undefined) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] ?? 0] ?? 0) < value) low = middle + 1;
      else high = middle;
    }
    previous.set(i, low > 0 ? tails[low - 1] : undefined);
    tails[low] = i;
  });
  const kept = new Set<number>();
  for (let i = tails.at(-1); i !== undefined; i = previous.get(i)) kept.add(i);
  return kept;
}

function nodeRow(node: CanvasNode): Omit<NodeRow, 'place'> {
  const row = {
    id: node.id,
    kind: node.type,
    ...(node.parentId === undefined ? {} : { parent: node.parentId }),
    label: node.data.label,
    x: node.position.x,
    y: node.position.y,
    ...(node.data.color === undefined ? {} : { color: node.data.color }),
  };
  if (node.type === 'frame') return row;
  const { adapter, connection, settings, role } = node.data;
  return {
    ...row,
    ...(adapter === undefined ? {} : { adapter }),
    ...(connection === undefined ? {} : { connection }),
    ...(settings === undefined ? {} : { settings: inFileOrder(settings) }),
    ...(role === undefined ? {} : { role }),
  };
}

function linkRow({ source, target, dots }: Link): Omit<LinkRow, 'place'> {
  const [a, b] = ends(source, target);
  return { a, b, source, ...(dots ? { dots: [dots[0], dots[1]] } : {}) };
}

function itemRow(
  agent: string,
  item: QueueItem,
  container: string | undefined,
): Omit<ItemRow, 'place'> {
  const kind = kindOf(item);
  const body: Record<string, unknown> = { ...item };
  delete body.id;
  if (kind === 'if') delete body.then;
  if (kind === 'repeat') delete body.repeat;
  delete body.submission;
  return {
    agent,
    id: item.id,
    ...(container === undefined ? {} : { container }),
    kind,
    body: inFileOrder(body),
  };
}

function kindOf(item: QueueItem): ItemKind {
  if (isIf(item)) return 'if';
  if (isRepeat(item)) return 'repeat';
  if (isWait(item)) return 'wait';
  if (isDelay(item)) return 'delay';
  if (isApproval(item)) return 'approval';
  return 'message' in item ? 'message' : 'step';
}

/** Nodes as a document lists them: each after the node that holds it, else in their order. */
function parentsFirst(rows: readonly NodeRow[], byId: ReadonlyMap<string, NodeRow>): NodeRow[] {
  const ordered: NodeRow[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const add = (row: NodeRow) => {
    if (done.has(row.id)) return;
    if (visiting.has(row.id)) throw new Error(`${nodeKey(row.id)}: it is inside itself`);
    visiting.add(row.id);
    if (row.parent !== undefined) {
      const parent = byId.get(row.parent);
      if (parent === undefined) throw new Error(`${nodeKey(row.id)}: its parent isn’t there`);
      add(parent);
    }
    visiting.delete(row.id);
    done.add(row.id);
    ordered.push(row);
  };
  rows.forEach(add);
  return ordered;
}

/** Whether an item's row is reached from its agent's queue, through what holds it. */
function reached(
  row: ItemRow,
  held: ReadonlyMap<EntityKey, readonly ItemRow[]>,
  byId: ReadonlyMap<string, NodeRow>,
): boolean {
  const seen = new Set<string>();
  for (let at: ItemRow | undefined = row; at !== undefined;) {
    if (at.container === undefined) return byId.get(at.agent)?.kind === 'agent';
    if (seen.has(at.id)) return false;
    seen.add(at.id);
    const holder: string = at.container;
    at = [...held.values()].flat().find((one) => one.agent === row.agent && one.id === holder);
  }
  return false;
}

function byPlace(x: { place: number }, y: { place: number }): number {
  return x.place - y.place;
}

/** Compares two texts by code point, as SQLite compares text (by its UTF-8 bytes). */
function byCodePoint(x: string, y: string): number {
  const length = Math.min(x.length, y.length);
  for (let i = 0; i < length; i++) {
    const a = x.charCodeAt(i);
    const b = y.charCodeAt(i);
    if (a === b) continue;
    // A surrogate stands for a code point past every unit that is none.
    const high = (unit: number) => unit >= 0xd800 && unit <= 0xdfff;
    if (high(a) !== high(b)) return high(a) ? 1 : -1;
    return a - b;
  }
  return x.length - y.length;
}

/** A row as it is but for its place. */
function unplaced(row: Row): object {
  const rest: Record<string, unknown> = { ...row };
  delete rest.place;
  return rest;
}

/** Whether two JSON values are the same, whatever order their objects' fields are in. */
function same(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (Array.isArray(x) || Array.isArray(y)) {
    return (
      Array.isArray(x) &&
      Array.isArray(y) &&
      x.length === y.length &&
      x.every((one, i) => same(one, y[i]))
    );
  }
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  const fields = Object.keys(x);
  return (
    fields.length === Object.keys(y).length &&
    fields.every(
      (field) =>
        Object.hasOwn(y, field) &&
        same((x as Record<string, unknown>)[field], (y as Record<string, unknown>)[field]),
    )
  );
}
