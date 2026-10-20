import { isIf, isRepeat } from '../../shared/model/queue';
import type { QueueItem, QueueIf, RepeatedItem } from '../../shared/model/queue';
import type { Edge, Node } from '@xyflow/react';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, CanvasDocument, CanvasNode } from '../../shared/model/canvas';
import { autosize, size } from '../../shared/model/geometry';
import { entityOf, fromRows, nodeKey } from '../../shared/model/rows';
import type { Rows } from '../../shared/model/rows';
import type {
  CanvasMeta,
  Entities,
  ItemEntity,
  LinkEntity,
  MetaEntity,
  NodeEntity,
} from '../../shared/model/state';

/** React Flow's view objects. Selection, measurements and dragging never enter the model. */
export type GraphNode = Node<{ [K in keyof AgentData]: AgentData[K] }, 'agent' | 'frame'>;
export interface Graph {
  arrange?: boolean;
  nodes: GraphNode[];
  edges: Edge[];
}
export interface Flow {
  document: CanvasDocument;
  graph: Graph;
  meta: CanvasMeta;
  rev: number;
}
const NO_META: CanvasMeta = { arrange: false, name: null, project: null, edited: false };
const same = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Memoizes by the mirror's entity objects; a queue edit rebuilds only its owner's node. */
export class CanvasFlow {
  readonly #nodes = new Map<string, { row: NodeEntity; items: ItemEntity[]; node: CanvasNode }>();
  readonly #items = new WeakMap<ItemEntity, { children: QueueItem[]; item: QueueItem }>();
  readonly #links = new WeakMap<
    LinkEntity,
    { link: CanvasDocument['links'][number]; edge: Edge }
  >();
  readonly #views = new Map<string, { model: CanvasNode; view: GraphNode }>();
  #last: Flow | undefined;
  #input: { canvas: CanvasId; rev: number; entities: Entities } | undefined;
  read(canvas: CanvasId, rev: number, entities: Entities): Flow {
    if (
      this.#last &&
      this.#input?.canvas === canvas &&
      this.#input.rev === rev &&
      this.#input.entities === entities
    )
      return this.#last;
    this.#input = { canvas, rev, entities };
    const items = new Map<string, ItemEntity[]>();
    const rows: NodeEntity[] = [];
    const linkRows: LinkEntity[] = [];
    for (const [key, entity] of Object.entries(entities)) {
      const kind = entityOf(key);
      if (kind === 'node') rows.push(entity as NodeEntity);
      else if (kind === 'link') linkRows.push(entity as LinkEntity);
      else if (kind === 'item') {
        const item = entity as ItemEntity;
        const list = items.get(item.agent) ?? [];
        list.push(item);
        items.set(item.agent, list);
      }
    }
    const alive = new Set(rows.map((row) => row.id));
    for (const id of this.#nodes.keys())
      if (!alive.has(id)) {
        this.#nodes.delete(id);
        this.#views.delete(id);
      }
    const byId = new Map<string, CanvasNode>();
    for (const row of rows) {
      const queue = items.get(row.id) ?? [];
      let kept = this.#nodes.get(row.id);
      if (kept?.row !== row || !same(kept.items, queue)) {
        const { parent, ...withoutParent } = row;
        const part: Rows = {
          [nodeKey(row.id)]: withoutParent,
          ...Object.fromEntries(
            queue.map((item) => [
              `item/${encodeURIComponent(item.agent)}/${encodeURIComponent(item.id)}`,
              item,
            ]),
          ),
        };
        const plain = fromRows(canvas, part).nodes[0];
        if (!plain) throw new Error(`No node ${row.id} in its rows.`);
        let node = parent === undefined ? plain : { ...plain, parentId: parent };
        if (node.type === 'agent' && node.data.queue) {
          const byItem = new Map(queue.map((row) => [row.id, row]));
          const memo = (item: QueueItem): QueueItem => {
            const row = byItem.get(item.id);
            if (!row) throw new Error(`No row for ${item.id}`);
            const children = (isIf(item) ? item.then : isRepeat(item) ? item.repeat : []).map(memo);
            const old = this.#items.get(row);
            if (old && same(old.children, children)) return old.item;
            const next = isIf(item)
              ? { ...item, then: children as QueueIf['then'] }
              : isRepeat(item)
                ? { ...item, repeat: children as RepeatedItem[] }
                : item;
            this.#items.set(row, { children, item: next });
            return next;
          };
          const items = node.data.queue.map(memo);
          const oldQueue = kept?.node.type === 'agent' ? kept.node.data.queue : undefined;
          node = {
            ...node,
            data: { ...node.data, queue: oldQueue && same(oldQueue, items) ? oldQueue : items },
          };
        }
        kept = { row, items: queue, node };
        this.#nodes.set(row.id, kept);
      }
      byId.set(row.id, kept.node);
    }
    const ordered: CanvasNode[] = [];
    const visited = new Set<string>();
    const add = (node: CanvasNode) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
      if (parent) add(parent);
      ordered.push(node);
    };
    for (const row of rows.sort((a, b) => a.place - b.place)) {
      const node = byId.get(row.id);
      if (node) add(node);
    }
    const links = linkRows
      .sort((a, b) => a.place - b.place)
      .map((row) => {
        let kept = this.#links.get(row);
        if (!kept) {
          const target = row.source === row.a ? row.b : row.a;
          const link = { source: row.source, target, ...(row.dots ? { dots: row.dots } : {}) };
          kept = {
            link,
            edge: {
              id: edgeId(link.source, target),
              source: link.source,
              target,
              ...(row.dots ? { sourceHandle: row.dots[0], targetHandle: row.dots[1] } : {}),
            },
          };
          this.#links.set(row, kept);
        }
        return kept;
      });
    const meta = (entities.meta as MetaEntity | undefined) ?? NO_META;
    const old = this.#last;
    const nodes = old && same(old.document.nodes, ordered) ? old.document.nodes : ordered;
    const modelLinks = links.map(({ link }) => link);
    const document =
      old?.document.id === canvas &&
      old.document.arrange === meta.arrange &&
      nodes === old.document.nodes &&
      same(old.document.links, modelLinks)
        ? old.document
        : { id: canvas, arrange: meta.arrange, nodes, links: modelLinks };
    const fitted = autosize<CanvasNode & { width?: number; height?: number }>(nodes);
    const views = fitted.map((node, i) => {
      const model = nodes[i];
      if (!model) throw new Error('No model node for its view.');
      const kept = this.#views.get(node.id);
      if (
        kept?.model === model &&
        kept.view.width === node.width &&
        kept.view.height === node.height &&
        kept.view.position.x === node.position.x &&
        kept.view.position.y === node.position.y
      )
        return kept.view;
      const view: GraphNode = {
        id: node.id,
        type: node.type,
        position: node.position,
        data: node.data,
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        ...(node.width === undefined ? {} : { width: node.width, height: node.height ?? 0 }),
      };
      this.#views.set(node.id, { model, view });
      return view;
    });
    const edges = links.map(({ edge }) => edge);
    const graph = {
      arrange: meta.arrange,
      nodes: old && same(old.graph.nodes, views) ? old.graph.nodes : views,
      edges: old && same(old.graph.edges, edges) ? old.graph.edges : edges,
    };
    return (this.#last = { document, graph, meta, rev });
  }
}
export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

const decoratedNodes = new WeakMap<
  GraphNode,
  { className: string; ariaLabel: string | undefined; data: GraphNode['data']; node: GraphNode }
>();
/** Runtime badges and view classes preserve the untouched node objects too. */
export function nodeView(
  node: GraphNode,
  className: string,
  ariaLabel: string | undefined,
  data: GraphNode['data'] = node.data,
): GraphNode {
  const kept = decoratedNodes.get(node);
  if (kept?.className === className && kept.ariaLabel === ariaLabel && kept.data === data)
    return kept.node;
  const next = {
    ...node,
    // Every controlled copy, including the selection after an add, must retain handle bounds
    // when React Flow adopts it before its ResizeObserver has measured that copy.
    measured: node.measured ?? size(node),
    data,
    ...(className ? { className } : {}),
    ...(ariaLabel === undefined ? {} : { ariaLabel }),
  };
  decoratedNodes.set(node, { className, ariaLabel, data, node: next });
  return next;
}
