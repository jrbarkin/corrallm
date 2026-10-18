import type { Brand, IdRef } from '../../shared/api/ids';
import type { Reach } from '../../shared/api/surface';
import type { TokenCaller } from './caller';

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
