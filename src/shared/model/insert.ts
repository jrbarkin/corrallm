import { autosize, bounds, size, PADDING, nextGroupColor, topInset } from './geometry';
import type { Sizing } from './geometry';
import type { CanvasDocument, CanvasNode } from './canvas';
import { fitDocument } from './structure';
import type { Built, Created } from './structure';
import { isApproval, isDelay, isIf, isRepeat, isRepeatEnds, isWait } from './queue';
import type { QueueItem } from './queue';

/** Space between what is on the canvas and a group inserted beside it. */
const GAP = 120;

/**
 * A canvas with another (`part`, such as a template) added as one new group (`group`, labelled
 * `name`, or "name 2" and so on if a group has that name), to the right of everything already
 * there (or beside its children when `parent` is named), with a selection hint for the group.
 * The group and the part's agents get new ids (`newId`), and what pointed at
 * them (links, work aimed at an agent, waits, inside if-thens and repeats too, and the repeats
 * others go round with) follows; they keep their layout inside the group.
 */
export function insert(
  graph: CanvasDocument,
  part: CanvasDocument,
  { name, parent }: { name: string; parent?: string },
  context: { newId: () => string; sizing?: Sizing<CanvasNode> },
): Built<Created> {
  const original = context.sizing ? graph.nodes : autosize(graph.nodes);
  const source = autosize(part.nodes);
  const parentNode = parent === undefined ? undefined : original.find((node) => node.id === parent);
  if (parent !== undefined && !parentNode) return { next: graph, result: {} };
  const group = context.newId();
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
  const taken = new Set(graph.nodes.filter((n) => n.type === 'frame').map((n) => n.data.label));
  let label = name;
  for (let i = 2; taken.has(label); i++) label = `${name} ${String(i)}`;

  const frame: CanvasNode = {
    id: group,
    type: 'frame',
    position: at,
    data: { label, color: nextGroupColor(graph.nodes) },
    ...(parent === undefined ? {} : { parentId: parent }),
  };
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
      parentId: top ? group : rename(n.parentId ?? ''),
      position: top
        ? {
            x: n.position.x - origin.x1 + PADDING,
            y: n.position.y - origin.y1 + topInset('frame'),
          }
        : n.position,
      data,
    };
  });
  return fitDocument(
    graph,
    [...original, frame, ...members],
    [
      ...graph.links,
      ...part.links.map((link) => ({
        ...link,
        source: rename(link.source),
        target: rename(link.target),
      })),
    ],
    { id: group, select: [group] },
    context,
  );
}

/** Where a group inserted beside a canvas's contents (`box`, their bounds) goes. */
function place(box: { x2: number; y1: number }) {
  return { x: box.x2 + GAP, y: box.y1 };
}
