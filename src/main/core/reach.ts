import type { Brand, IdRef } from '../../shared/api/ids';
import type { Reach } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { CanvasNode, Link } from '../../shared/model/canvas';
import type { Message } from '../../shared/model/messages';
import { areLinked, groupMembers, isGroup, managerOf, teamOf } from '../../shared/model/queries';
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
 * Whether `caller` reaches the id `id` of one kind, as far as `reach`, on `canvas` (the canvas the
 * call names, if it names one: ids other than a canvas's are unique within their canvas only).
 */
export type Resolver = (
  id: string,
  caller: TokenCaller,
  reach: Reach,
  canvas: string | undefined,
) => boolean;

/** What each kind of id names, as a sentence says it. */
const WORDS: Readonly<Record<Brand, string>> = {
  CanvasId: 'canvas',
  AgentId: 'agent',
  NodeId: 'node',
  LinkId: 'link',
  ItemId: 'queue item',
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
  const missing = ids.find((ref) => resolvers[ref.brand]?.(ref.id, caller, reach, canvas) !== true);
  return (
    missing && `There is no ${WORDS[missing.brand]} ${missing.id} (at ${missing.path.slice(1)}).`
  );
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
 * canvas it has; an agent or a group it reaches there; a message it sent or received there. On a
 * canvas of its own that isn't open, nothing can be told, so the op answers that it isn't open.
 */
export function resolvers(
  engines: Engines,
  isLead: (canvas: CanvasId, agent: string) => boolean,
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
      ) => boolean,
    ): Resolver =>
    (id, caller, reach, canvas) => {
      if (canvas === undefined || !canvasesOf(caller).includes(canvas as CanvasId)) return false;
      const open = engines.canvas(canvas as CanvasId);
      return !open || reaches(open.document, id, caller, reach, lead(caller, canvas as CanvasId));
    };
  return {
    CanvasId: (id, caller) => canvasesOf(caller).includes(id as CanvasId),
    AgentId: over((world, id, caller, reach, isALead) =>
      reachesAgent(world, caller, reach, id, isALead),
    ),
    NodeId: over((world, id, caller, reach, isALead) =>
      reachesGroup(world, caller, reach, id, isALead),
    ),
    MessageId: (id, caller, _reach, canvas) => {
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
