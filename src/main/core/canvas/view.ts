import type { Reach } from '../../../shared/api/surface';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { entityOf, nodeKey } from '../../../shared/model/rows';
import type { EntityKey } from '../../../shared/model/rows';
import type {
  Entities,
  Entity,
  ItemEntity,
  LinkEntity,
  NodeEntity,
} from '../../../shared/model/state';
import type { Caller } from '../caller';
import { reachesAgent } from '../reach';

/*
 * What of a canvas a caller sees (Core Server §3.4, §5.1): `canvas.get` and the `canvas:<c>` topic
 * alike, so that a topic is never a second way to reach anything. You, and a token reaching its
 * whole canvas, see every entity. An agent (a lead: canvas.get's reach) sees the agents it reaches,
 * the groups around them and the links between them, each agent's queue, and the canvas's meta. A
 * node it sees inside one it doesn't is placed inside the nearest it sees instead (none: on the
 * canvas), where it is on the canvas, so that its rows still read as a canvas (fromRows).
 */

/** Whether `caller` sees every entity of a canvas, as far as `reach`. */
export function seesAll(caller: Caller, reach: Reach): boolean {
  return caller.kind === 'human' || reach === 'all' || reach === 'canvas';
}

/**
 * The entities of a canvas whose document is `document` that `caller` sees, as far as `reach`
 * (`lead`: whether it is a lead now). Those it sees whole are the very objects given.
 */
export function viewOf(
  document: CanvasDocument,
  entities: Entities,
  caller: Caller,
  reach: Reach,
  lead: boolean,
): Entities {
  if (seesAll(caller, reach) || caller.kind === 'human') return entities;
  const agents = new Set(
    document.nodes.flatMap((node) =>
      node.type === 'agent' && reachesAgent(document, caller, reach, node.id, lead)
        ? [node.id]
        : [],
    ),
  );
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const frames = new Set<string>();
  for (const agent of agents) {
    const seen = new Set<string>();
    for (let at = byId.get(agent)?.parentId; at !== undefined && !seen.has(at);) {
      seen.add(at);
      const node = byId.get(at);
      if (node?.type === 'frame') frames.add(at);
      at = node?.parentId;
    }
  }
  const sees = (id: string) => agents.has(id) || frames.has(id);
  const seen: Record<EntityKey, Entity> = {};
  for (const [key, entity] of Object.entries(entities)) {
    switch (entityOf(key)) {
      case 'meta':
        seen[key] = entity;
        break;
      case 'node': {
        const node = entity as NodeEntity;
        if (sees(node.id)) seen[key] = placed(node, entities, sees);
        break;
      }
      case 'link': {
        const link = entity as LinkEntity;
        if (agents.has(link.a) && agents.has(link.b)) seen[key] = entity;
        break;
      }
      case 'item':
        if (agents.has((entity as ItemEntity).agent)) seen[key] = entity;
        break;
    }
  }
  return seen;
}

/**
 * A node as one who sees only some of a canvas sees it: inside the nearest of its containers it
 * sees, where it is on the canvas (its position is its parent's, plus its own).
 */
function placed(node: NodeEntity, entities: Entities, sees: (id: string) => boolean): NodeEntity {
  if (node.parent === undefined || sees(node.parent)) return node;
  let { x, y } = node;
  let parent: string | undefined = node.parent;
  const passed = new Set<string>();
  while (parent !== undefined && !sees(parent) && !passed.has(parent)) {
    passed.add(parent);
    const container = entities[nodeKey(parent)] as NodeEntity | undefined;
    if (container === undefined) {
      parent = undefined;
      break;
    }
    x += container.x;
    y += container.y;
    parent = container.parent;
  }
  const moved: NodeEntity = { ...node, x, y };
  if (parent === undefined || !sees(parent)) delete moved.parent;
  else moved.parent = parent;
  return moved;
}
