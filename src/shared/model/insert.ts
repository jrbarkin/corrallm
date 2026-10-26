import { autosize, bounds, size, PADDING, topInset } from './geometry';
import type { Sizing } from './geometry';
import type { CanvasDocument, CanvasNode } from './canvas';
import { fitDocument } from './structure';
import type { Built } from './structure';
import { isApproval, isDelay, isIf, isRepeat, isRepeatEnds, isWait } from './queue';
import type { QueueItem } from './queue';

/** Space between what is on the canvas and the template inserted beside it. */
const GAP = 120;

export interface Inserted {
  roots: string[];
  select?: string[];
}

/**
 * Adds the template's own top-level nodes, in order, to the right of existing content (or beside
 * a named parent's children). No wrapper changes its workspace grouping. Every node gets a new
 * id (`newId`), and what pointed at
 * them (links, work aimed at an agent, waits, inside if-thens and repeats too, and the repeats
 * others go round with) follows. Roots retain their relative layout and become children of
 * `parent` only when given; the result selects all inserted roots.
 */
export function insert(
  graph: CanvasDocument,
  part: CanvasDocument,
  { parent }: { parent?: string },
  context: { newId: () => string; sizing?: Sizing<CanvasNode> },
): Built<Inserted> {
  const original = context.sizing ? graph.nodes : autosize(graph.nodes);
  const source = autosize(part.nodes);
  const parentNode = parent === undefined ? undefined : original.find((node) => node.id === parent);
  if (parent !== undefined && !parentNode) return { next: graph, result: { roots: [] } };
  const ids = new Map(source.map((n) => [n.id, context.newId()]));
  const rename = (id: string) => ids.get(id) ?? id;
  const retarget = <T extends QueueItem>(item: T): T => {
    if (isWait(item)) {
      const waitFor = item.waitFor.map((target) =>
        rename(target.agent) === target.agent ? target : { ...target, agent: rename(target.agent) },
      );
      return waitFor.every((target, i) => target === item.waitFor[i]) ? item : { ...item, waitFor };
    }
    if (isDelay(item) || isApproval(item)) return item;
    if (isIf(item)) {
      const then = item.then.map(retarget);
      return then.every((one, i) => one === item.then[i]) ? item : { ...item, then };
    }
    if (isRepeat(item)) {
      const { until } = item;
      const repeat = item.repeat.map(retarget);
      const nextUntil =
        isRepeatEnds(until) && rename(until.agent) !== until.agent
          ? { ...until, agent: rename(until.agent) }
          : until;
      return repeat.every((one, i) => one === item.repeat[i]) && nextUntil === until
        ? item
        : { ...item, repeat, until: nextUntil };
    }
    return item.target === undefined || rename(item.target) === item.target
      ? item
      : { ...item, target: rename(item.target) };
  };

  const onCanvas = original.filter((n) => n.parentId === parent);
  const at =
    onCanvas.length === 0
      ? parentNode
        ? { x: PADDING, y: topInset(parentNode.type) }
        : { x: 0, y: 0 }
      : place(bounds(onCanvas, (node) => context.sizing?.size(node) ?? size(node)));
  const partTop = source.filter((n) => n.parentId === undefined);
  const origin = partTop.length === 0 ? { x1: 0, y1: 0 } : bounds(partTop);
  const roots = partTop.map((node) => rename(node.id));
  const members = source.map((n): CanvasNode => {
    const top = n.parentId === undefined;
    const queue = n.type === 'agent' && n.data.queue ? n.data.queue.map(retarget) : undefined;
    const data =
      n.type === 'agent' && queue && !queue.every((item, i) => item === n.data.queue?.[i])
        ? { ...n.data, queue }
        : n.data;
    return {
      ...n,
      id: rename(n.id),
      ...(top
        ? parent === undefined
          ? {}
          : { parentId: parent }
        : { parentId: rename(n.parentId ?? '') }),
      position: top
        ? {
            x: n.position.x - origin.x1 + at.x,
            y: n.position.y - origin.y1 + at.y,
          }
        : n.position,
      data,
    };
  });
  return fitDocument(
    graph,
    [...original, ...members],
    [
      ...graph.links,
      ...part.links.map((link) => ({
        ...link,
        source: rename(link.source),
        target: rename(link.target),
      })),
    ],
    { roots, select: roots },
    context,
  );
}

/** Where a template inserted beside existing content (`box`, its bounds) goes. */
function place(box: { x2: number; y1: number }) {
  return { x: box.x2 + GAP, y: box.y1 };
}
