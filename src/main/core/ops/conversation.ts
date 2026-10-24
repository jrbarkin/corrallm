import { DEFAULT_PAGE } from '../../../shared/api/limits';
import type { AGENT_STATES } from '../../../shared/api/ops/conversation';
import { needs, withoutChoices } from '../../../shared/engine/needs';
import { isOpen } from '../../../shared/model/session';
import type { CanvasId } from '../../../shared/canvas';
import type { NeedsItem } from '../../../shared/model/needs';
import { agentName, areLinked, teamOf } from '../../../shared/model/queries';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { canvasesOf, isTokenCaller, partyIdOf } from '../caller';
import { DeliveryError } from '../delivery/delivery';
import { cursorOf, readCursor } from '../delivery/messages';
import { needsInput } from '../engines';
import type { OpenCanvas } from '../engines';
import { agentsReached } from '../reach';
import { agentOf, openCanvas, pageOf, reachFor } from './open';
import type { Implementations, OpServices } from '.';

/** Conversation (Core Server §4 H; API Spec §7.2). */
export function conversationOps(
  services: OpServices,
): Pick<Implementations, 'agents' | 'status' | 'needs' | 'messages' | 'message' | 'withdraw'> {
  const { engines, states, isLead, locale, proposals, reviews, stalled } = services;
  const lead = (canvas: CanvasId, { caller }: OpContext) =>
    caller.kind === 'agent' && isLead(canvas, caller.agent);

  /** The agents of an open canvas the caller reaches for `op`, in their order. */
  const reached = (open: OpenCanvas, op: Parameters<typeof reachFor>[0], ctx: OpContext) =>
    agentsReached(open.document, ctx.caller, reachFor(op, ctx), lead(open.document.id, ctx));

  /**
   * What waits on an open canvas for the caller: yours (the run's holds, the sessions' prompts,
   * the proposals and the review of its file changed on disk waiting for you), with their choices,
   * for you; for anyone else, yours on the agents it reaches without them (never a review, which
   * is on no agent), and an agent's team's prompts too.
   */
  const waiting = (open: OpenCanvas, ctx: OpContext, reach: readonly string[]): NeedsItem[] => {
    const id = open.document.id;
    const items = [
      ...needs(needsInput(open, locale)),
      ...proposals.items(id, ctx.caller.kind === 'human' ? undefined : reach),
      ...reviews.items(id),
      ...stalled.items(id),
      ...(services.runProblems?.(id) ?? []),
      // A worktree's setup card names no agent: a token's view below never holds it; nor does
      // a workspace change's (B9a C7).
      ...(ctx.caller.kind === 'human' ? (services.setups?.items(id) ?? []) : []),
      ...(ctx.caller.kind === 'human' ? (services.workspaceItems?.(id) ?? []) : []),
    ];
    if (ctx.caller.kind === 'human') return items;
    const { caller } = ctx;
    const team = caller.kind === 'agent' ? teamOf(open.document.nodes, caller.agent) : [];
    return items
      .filter(
        (item) =>
          item.agent !== undefined &&
          (reach.includes(item.agent) || (item.kind === 'prompt' && team.includes(item.agent))),
      )
      .map(withoutChoices);
  };

  return {
    agents: ({ canvas }, ctx) => {
      const open = openCanvas(engines, canvas);
      const { document, engine } = open;
      const reach = reached(open, 'agents', ctx);
      return {
        agents: reach.map((id) => {
          const node = agentOf(open, id);
          return {
            id,
            name: agentName(document.nodes, id),
            adapter: node.data.adapter ?? engine.catalog.defaultAdapter,
            connection: engine.catalog.connectionOf(node.data),
            state: stateOf(open, id),
            prompts: promptsOf(open, id),
            linked: reach.filter((other) => other !== id && areLinked(document.links, id, other)),
            api: false,
          };
        }),
      };
    },
    status: ({ canvas }, ctx) => {
      const open = openCanvas(engines, canvas);
      const reach = reached(open, 'status', ctx);
      return {
        agents: reach.map((id) => {
          const session = open.engine.sessions.of(id);
          return {
            id,
            state: stateOf(open, id),
            message: open.delivery.current(id) ?? null,
            model: session.model,
            effort: session.effort ?? null,
          };
        }),
        waitingForYou: waiting(open, ctx, reach).map(withoutChoices),
        // At the end of every canvas the caller has, so a `wait` from it reads only what comes.
        next: cursorOf(
          'wait',
          Object.fromEntries(
            (isTokenCaller(ctx.caller) ? canvasesOf(ctx.caller) : engines.opened()).flatMap(
              (id) => {
                const one = engines.canvas(id);
                return one ? [[id, one.messages.end()]] : [];
              },
            ),
          ),
        ),
      };
    },
    needs: ({ canvas }, ctx) => {
      // A canvas the core keeps but doesn't run (the app's, until B11): what waits on it in the
      // core, the proposals and the review of its file waiting for you (B9 Design §7), which only
      // you see there.
      const id = canvas as string | undefined as CanvasId | undefined;
      if (id !== undefined && !engines.canvas(id) && states.keeps(id)) {
        return {
          items:
            ctx.caller.kind === 'human'
              ? [
                  ...proposals.items(id),
                  ...reviews.items(id),
                  ...stalled.items(id),
                  ...(services.runProblems?.(id) ?? []),
                  ...(services.setups?.items(id) ?? []),
                ]
              : [],
        };
      }
      const open = openCanvas(engines, canvas);
      return { items: waiting(open, ctx, reached(open, 'needs', ctx)) };
    },
    messages: ({ canvas, with: other, after, limit = DEFAULT_PAGE }, ctx) => {
      const open = openCanvas(engines, canvas);
      const id = open.document.id;
      const from = after === undefined ? 0 : readCursor(after, ['messages', 'wait'])?.[id];
      if (after !== undefined && from === undefined) {
        throw new OpFailure('invalid', 'That cursor isn’t one this canvas gave.');
      }
      const party = partyIdOf(ctx.caller);
      const items = pageOf(
        open.messages
          .all()
          .filter(
            (message) =>
              (ctx.caller.kind === 'human' || message.from === party || message.to === party) &&
              (other === undefined || message.from === other || message.to === other) &&
              (open.messages.seqOf(message.id) ?? 0) > (from ?? 0),
          )
          .slice(0, limit),
      );
      const last = items.at(-1);
      const next = last === undefined ? (from ?? 0) : (open.messages.seqOf(last.id) ?? 0);
      return { items, next: cursorOf('messages', { [id]: next }) };
    },
    message: async ({ canvas, to, body, replyTo }, ctx) => {
      const open = openCanvas(engines, canvas);
      agentOf(open, to);
      if (replyTo !== undefined && !open.messages.get(replyTo)) {
        throw new OpFailure('not-found', `There is no message ${replyTo}.`);
      }
      try {
        const sent = await open.delivery.send(partyIdOf(ctx.caller), to, body, replyTo);
        return { id: sent.id };
      } catch (error) {
        return failed(error);
      }
    },
    withdraw: async ({ canvas, id }, ctx) => {
      const open = openCanvas(engines, canvas);
      try {
        return await open.delivery.withdraw(id, partyIdOf(ctx.caller));
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/** Throws what delivery refused as the op's failure, with its code; anything else as it is. */
function failed(error: unknown): never {
  if (error instanceof DeliveryError) throw new OpFailure(error.code, error.message);
  throw error;
}

/** How an agent is now: waiting for you, working, limited by usage, paused, or idle. */
export function stateOf(
  { engine, delivery }: OpenCanvas,
  id: string,
): (typeof AGENT_STATES)[number] {
  const session = engine.sessions.of(id);
  if (session.status === 'waiting' || (session.asking?.length ?? 0) > 0) return 'waiting';
  if (session.status === 'working') return 'working';
  if (delivery.limited().some(({ agent }) => agent === id)) return 'limited';
  return engine.run.snapshot().agents[id]?.paused ? 'paused' : 'idle';
}

/** How many prompts of its own an agent waits on an answer to: its session's, and its terminal's. */
export function promptsOf({ engine }: OpenCanvas, id: string): number {
  const session = engine.sessions.of(id);
  return session.entries.filter(isOpen).length + (session.asking?.length ?? 0);
}
