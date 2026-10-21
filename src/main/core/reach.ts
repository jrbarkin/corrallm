import type { Brand, IdRef } from '../../shared/api/ids';
import type { Reach } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { CanvasNode, Link } from '../../shared/model/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import { areLinked, groupMembers, isGroup, managerOf, teamOf } from '../../shared/model/queries';
import { findItem } from '../../shared/model/queue';
import { itemKey, linkKey, nodeKey } from '../../shared/model/rows';
import { canvasesOf, partyIdOf } from './caller';
import type { Caller, TokenCaller } from './caller';
import type { Engines } from './engines';

/*
 * Reach, resolved in core.call, never in an op (Core Server §3.1): every branded id a token names
 * must be one its party reaches for that op, or the call is not-found, worded as if the thing were
 * not there at all, so a caller learns nothing about what it can't reach. The core resolves each
 * kind of id over what it keeps (a canvas, its agents, a queue's items, messages, Needs), and finds
 * no id of a kind it resolves none of in anyone's reach, nor any id where an op's schema hides which
 * one the op gets (`UnreadableIds`). You reach everything.
 */

/**
 * Whether `caller` reaches the id `id` of one kind, as far as `reach`, where the call names it:
 * on `at.canvas`, the canvas the call names, if it names one (ids other than a canvas's are unique
 * within their canvas only), and beside `at.agent`, the agent named in the same object as it, if
 * one is (a queue item's id is unique within its agent's queue only).
 */
export type Resolver = (
  id: string,
  caller: TokenCaller,
  reach: Reach,
  at: { canvas?: string; agent?: string },
) => boolean;

/** What each kind of id names, as a sentence says it. */
const WORDS: Readonly<Record<Brand, string>> = {
  CanvasId: 'canvas',
  AgentId: 'agent',
  NodeId: 'node',
  GroupId: 'group',
  ItemId: 'queue item',
  EntityKey: 'entity',
  NeedId: 'Needs item',
  MessageId: 'message',
  ConversationId: 'conversation',
  TaskId: 'task',
  TokenId: 'token',
};

/**
 * Why `caller` may not name the first of `ids` it doesn't reach, as the sentence that there is no
 * such thing; undefined if it reaches them all.
 */
export function outOfReach(
  ids: readonly IdRef[],
  caller: TokenCaller,
  reach: Reach,
  resolvers: Readonly<Partial<Record<Brand, Resolver>>>,
): string | undefined {
  const canvas = ids.find((ref) => ref.brand === 'CanvasId')?.id;
  const missing = ids.find((ref) => {
    const agent = besideOf(ids, ref);
    const at = {
      ...(canvas === undefined ? {} : { canvas }),
      ...(agent === undefined ? {} : { agent }),
    };
    return resolvers[ref.brand]?.(ref.id, caller, reach, at) !== true;
  });
  return (
    missing && `There is no ${WORDS[missing.brand]} ${missing.id} (at ${missing.path.slice(1)}).`
  );
}

/** The agent named beside `ref`, in the same object as it (`.agent` there), if one is. */
function besideOf(ids: readonly IdRef[], ref: IdRef): string | undefined {
  const parent = ref.path.replace(/(?:\.[^.[]+|\[\d+\])$/, '');
  return ids.find((one) => one.brand === 'AgentId' && one.path === `${parent}.agent`)?.id;
}

/** What reach is read over: a canvas's nodes and links. */
export interface World {
  nodes: readonly CanvasNode[];
  links: readonly Link[];
}

/**
 * Whether `caller` reaches agent `id` on a canvas as far as `reach` (Core Server §3.1): an outside
 * token every agent of its canvases; an agent itself ('own'), its team too ('team': every agent
 * nested inside it), or its manager and the agents linked to it too ('linked', where a lead's team
 * counts as well). `lead`: whether the agent calling is a lead now.
 */
export function reachesAgent(
  { nodes, links }: World,
  caller: TokenCaller,
  reach: Reach,
  id: string,
  lead: boolean,
): boolean {
  if (!nodes.some((node) => node.id === id && node.type === 'agent')) return false;
  if (caller.kind === 'outside') return reach === 'canvas';
  const self = caller.agent;
  if (id === self) return true;
  const team = () => lead && teamOf(nodes, self).includes(id);
  switch (reach) {
    case 'own':
      return false;
    case 'team':
      return team();
    case 'linked':
      return areLinked(links, self, id) || managerOf(nodes, self) === id || team();
    default:
      return false;
  }
}

/** Whether `caller` reaches node `id` as far as `reach`: an agent as itself, a frame as its agents. */
export function reachesNode(
  world: World,
  caller: TokenCaller,
  reach: Reach,
  id: string,
  lead: boolean,
): boolean {
  const node = world.nodes.find((one) => one.id === id);
  if (node?.type === 'agent') return reachesAgent(world, caller, reach, id, lead);
  return node !== undefined && reachesGroup(world, caller, reach, id, lead);
}

/**
 * Whether `caller` reaches item `id` of agent `agent`'s queue, at any depth, as far as `reach`:
 * only if it reaches the agent.
 */
export function reachesItem(
  world: World,
  caller: TokenCaller,
  reach: Reach,
  agent: string,
  id: string,
  lead: boolean,
): boolean {
  const node = world.nodes.find((one) => one.id === agent);
  return (
    node?.type === 'agent' &&
    findItem(node.data.queue ?? [], id) !== undefined &&
    reachesAgent(world, caller, reach, agent, lead)
  );
}

/**
 * Whether `caller` reaches the entity a document's key names (src/shared/model/rows.ts) as far as
 * `reach`: its node, both ends of its link, its item's agent. One reaching its whole canvas reaches
 * whatever a key names there, there or not; any other, only what is there. A key that isn't one as
 * rows.ts writes it names nothing.
 */
export function reachesEntity(
  world: World,
  caller: TokenCaller,
  reach: Reach,
  key: string,
  lead: boolean,
): boolean {
  const named = namedBy(key);
  if (named === undefined) return false;
  if (caller.kind === 'outside') return reach === 'canvas';
  switch (named.entity) {
    case 'node':
      return reachesNode(world, caller, reach, named.id, lead);
    case 'link':
      return named.ends.every((end) => reachesAgent(world, caller, reach, end, lead));
    case 'item':
      return reachesAgent(world, caller, reach, named.agent, lead);
  }
}

/** What a document's key names, if it is a key as rows.ts writes one. */
function namedBy(
  key: string,
):
  | { entity: 'node'; id: string }
  | { entity: 'link'; ends: [string, string] }
  | { entity: 'item'; agent: string; id: string }
  | undefined {
  const [entity, ...parts] = key.split('/');
  let ids: string[];
  try {
    ids = parts.map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [one, other] = ids;
  if (one === undefined) return undefined;
  if (entity === 'node' && ids.length === 1 && nodeKey(one) === key) return { entity, id: one };
  if (other === undefined || ids.length !== 2) return undefined;
  if (entity === 'link' && linkKey(one, other) === key) return { entity, ends: [one, other] };
  if (entity === 'item' && itemKey(one, other) === key) return { entity, agent: one, id: other };
  return undefined;
}

/** Whether `caller` reaches the group `id` as far as `reach`: every agent of it. */
export function reachesGroup(
  world: World,
  caller: TokenCaller,
  reach: Reach,
  id: string,
  lead: boolean,
): boolean {
  return (
    isGroup(world.nodes, id) &&
    groupMembers(world.nodes, id).every((agent) => reachesAgent(world, caller, reach, agent, lead))
  );
}

/** The agents of a canvas `caller` reaches as far as `reach`, in their order: you, every one. */
export function agentsReached(
  world: World,
  caller: Caller,
  reach: Reach | 'all',
  lead: boolean,
): string[] {
  const agents = world.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : []));
  if (caller.kind === 'human' || reach === 'all') return agents;
  return agents.filter((agent) => reachesAgent(world, caller, reach, agent, lead));
}

/**
 * How the core resolves each kind of id a token names, over the canvases it runs (`engines`): a
 * canvas it has; a node, a group, an agent or an item of its queue it reaches there; a message it
 * sent or received there; a Needs item there (`needOf`: what waits for you, by its id) on an agent
 * it reaches. On a canvas of its own that isn't open, nothing can be told, so the op answers that
 * it isn't open; but no Needs item is in reach there.
 */
export function resolvers(
  engines: Engines,
  isLead: (canvas: CanvasId, agent: string) => boolean,
  needOf: (canvas: CanvasId, id: string) => NeedsItem | undefined = () => undefined,
): Readonly<Partial<Record<Brand, Resolver>>> {
  const lead = (caller: TokenCaller, canvas: CanvasId) =>
    caller.kind === 'agent' && isLead(canvas, caller.agent);
  /** A resolver over the open canvas a call names, if the caller has that canvas. */
  const over =
    (
      reaches: (
        world: World,
        id: string,
        caller: TokenCaller,
        reach: Reach,
        lead: boolean,
        agent: string | undefined,
      ) => boolean,
    ): Resolver =>
    (id, caller, reach, { canvas, agent }) => {
      if (canvas === undefined || !canvasesOf(caller).includes(canvas as CanvasId)) return false;
      const open = engines.canvas(canvas as CanvasId);
      return (
        !open || reaches(open.document, id, caller, reach, lead(caller, canvas as CanvasId), agent)
      );
    };
  return {
    CanvasId: (id, caller) => canvasesOf(caller).includes(id as CanvasId),
    AgentId: over((world, id, caller, reach, isALead) =>
      reachesAgent(world, caller, reach, id, isALead),
    ),
    NodeId: over((world, id, caller, reach, isALead) =>
      reachesNode(world, caller, reach, id, isALead),
    ),
    GroupId: over((world, id, caller, reach, isALead) =>
      reachesGroup(world, caller, reach, id, isALead),
    ),
    ItemId: over(
      (world, id, caller, reach, isALead, agent) =>
        agent !== undefined && reachesItem(world, caller, reach, agent, id, isALead),
    ),
    EntityKey: over((world, key, caller, reach, isALead) =>
      reachesEntity(world, caller, reach, key, isALead),
    ),
    // A token sees your items on the agents it reaches (Core Server §5.1), and only those.
    NeedId: (id, caller, reach, { canvas }) => {
      if (canvas === undefined || !canvasesOf(caller).includes(canvas as CanvasId)) return false;
      const open = engines.canvas(canvas as CanvasId);
      const item = needOf(canvas as CanvasId, id);
      if (!open || item?.agent === undefined) return false;
      return reachesAgent(
        open.document,
        caller,
        reach,
        item.agent,
        lead(caller, canvas as CanvasId),
      );
    },
    MessageId: (id, caller, _reach, { canvas }) => {
      // An op that takes no canvas (`wait`) names a message on any of the caller's open ones.
      if (canvas === undefined) {
        return canvasesOf(caller).some((one) =>
          isTheirs(engines.canvas(one)?.messages.get(id), caller),
        );
      }
      if (!canvasesOf(caller).includes(canvas as CanvasId)) return false;
      const open = engines.canvas(canvas as CanvasId);
      if (!open) return true;
      return isTheirs(open.messages.get(id), caller);
    },
  };
}

/**
 * Whether an open canvas holds, for `caller`, the message an id names (one it sent or got; you,
 * any): which of its canvases a call naming that message but no canvas is on.
 */
export function holder(
  engines: Engines,
): (canvas: CanvasId, ref: IdRef, caller: Caller) => boolean {
  return (canvas, { brand, id }, caller) =>
    brand === 'MessageId' &&
    (caller.kind === 'human'
      ? engines.canvas(canvas)?.messages.get(id) !== undefined
      : isTheirs(engines.canvas(canvas)?.messages.get(id), caller));
}

/** Whether a message is one `caller` sent or got. */
function isTheirs(message: Message | undefined, caller: TokenCaller): boolean {
  const party = partyIdOf(caller);
  return message !== undefined && (message.from === party || message.to === party);
}
