import { autosize, bounds, edgeId, nextGroupColor, PADDING, topInset } from './graph';
import type { Graph, GraphNode } from './graph';
import { isDelay, isIf, isWait } from './queue';
import type { QueueItem } from './queue';

/** Space between what is on the canvas and a group inserted beside it. */
const GAP = 120;

/**
 * A canvas with another (`part`, such as a template) added as one new group (`group`, labelled
 * `name`, or "name 2" and so on if a group has that name), to the right of everything already
 * there, and the only selected node. The part's agents get new ids (`newId`), and what pointed at
 * them (links, work aimed at an agent, waits) follows; they keep their layout inside the group.
 */
export function insertGraph(
  graph: Graph,
  part: Graph,
  { group, name, newId }: { group: string; name: string; newId: () => string },
): Graph {
  const ids = new Map(part.nodes.map((n) => [n.id, newId()]));
  const rename = (id: string) => ids.get(id) ?? id;
  const retarget = (item: QueueItem): QueueItem =>
    isWait(item)
      ? { ...item, waitFor: item.waitFor.map((t) => ({ ...t, agent: rename(t.agent) })) }
      : isDelay(item)
        ? item
        : isIf(item)
          ? {
              ...item,
              then: item.then.map((s) =>
                s.target === undefined ? s : { ...s, target: rename(s.target) },
              ),
            }
          : item.target === undefined
            ? item
            : { ...item, target: rename(item.target) };

  const onCanvas = graph.nodes.filter((n) => n.parentId === undefined);
  const at = onCanvas.length === 0 ? { x: 0, y: 0 } : place(bounds(onCanvas));
  const partTop = part.nodes.filter((n) => n.parentId === undefined);
  const origin = partTop.length === 0 ? { x1: 0, y1: 0 } : bounds(partTop);
  const taken = new Set(graph.nodes.filter((n) => n.type === 'frame').map((n) => n.data.label));
  let label = name;
  for (let i = 2; taken.has(label); i++) label = `${name} ${String(i)}`;

  const frame: GraphNode = {
    id: group,
    type: 'frame',
    position: at,
    data: { label, color: nextGroupColor(graph.nodes) },
    selected: true,
  };
  const members = part.nodes.map((n): GraphNode => {
    const top = n.parentId === undefined;
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
      selected: false,
      data: n.data.queue ? { ...n.data, queue: n.data.queue.map(retarget) } : n.data,
    };
  });
  return {
    nodes: autosize([
      ...graph.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      frame,
      ...members,
    ]),
    edges: [
      ...graph.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      ...part.edges.map((e) => {
        const source = rename(e.source);
        const target = rename(e.target);
        return { ...e, id: edgeId(source, target), source, target, selected: false };
      }),
    ],
  };
}

/** Where a group inserted beside a canvas's contents (`box`, their bounds) goes. */
function place(box: { x2: number; y1: number }) {
  return { x: box.x2 + GAP, y: box.y1 };
}
