import { connectionIn } from '../../../shared/adapter';
import { routeOf, routeRefusal } from '../../../shared/routing';
import { DEFAULT_PAGE } from '../../../shared/api/limits';
import { imageRefusal } from '../../../shared/images';
import { nameOf } from '../parties';
import type { AGENT_STATES } from '../../../shared/api/ops/conversation';
import { needs } from '../../../shared/model/needs-selectors';
import { needFor } from '../../../shared/model/prompt-views';
import type { CanvasId } from '../../../shared/canvas';
import type { NeedsItem } from '../../../shared/model/needs';
import { agentName, areLinked, teamOf } from '../../../shared/model/queries';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { ownTurn } from '../attempts';
import { canvasesOf, isTokenCaller, partyIdOf, promptReaderOf } from '../caller';
import type { MessageId } from '../../../shared/api/ids';
import { agentOf as partyAgent, agentParty } from '../../../shared/model/messages';
import { DeliveryError } from '../delivery/errors';
import { capBody, cursorOf, readCursor } from '../delivery/messages';
import { resultKey } from '../delivery/tasks';
import { needsInput } from '../engines';
import type { OpenCanvas } from '../engines';
import { agentsReached } from '../reach';
import { agentOf, openCanvas, pageOf, reachFor } from './open';
import { fallbackOf, handoffOf, messagesSeen, promptsOf } from './views';
import type { Implementations, OpServices } from '.';

/** Conversation (Core Server §4 H; API Spec §7.2). */
export function conversationOps(
  services: OpServices,
): Pick<
  Implementations,
  'agents' | 'status' | 'needs' | 'messages' | 'message' | 'withdraw' | 'ask' | 'complete'
> {
  const { engines, states, isLead, locale, proposals, reviews, stalled } = services;
  const lead = (canvas: CanvasId, { caller }: OpContext) =>
    caller.kind === 'agent' && isLead(canvas, caller.agent);

  /** The agents of an open canvas the caller reaches for `op`, in their order. */
  const reached = (open: OpenCanvas, op: Parameters<typeof reachFor>[0], ctx: OpContext) =>
    agentsReached(open.document, ctx.caller, reachFor(op, ctx), lead(open.document.id, ctx));

  /**
   * What waits on an open canvas for the caller: yours (the run's holds, the sessions' prompts,
   * the proposals and the review of its file changed on disk waiting for you), with their choices,
   * for you; for anyone else, yours on the agents it reaches (never a review, which is on no
   * agent), and an agent's team's prompts too, each as a token sees it (B13 C11's selector: no
   * choices or form, a prompt the core's owner holds without a form's own words or a terminal's
   * screen).
   */
  const waiting = (open: OpenCanvas, ctx: OpContext, reach: readonly string[]): NeedsItem[] => {
    const id = open.document.id;
    const reader = promptReaderOf(ctx.caller);
    const items = [
      ...needs(needsInput(open, locale)).map((item) => needFor(item, reader)),
      // B21 C5, C6: its asks, parties’ messages to you and the pairs held after ten turns (yours alone).
      ...open.delivery.items().map((item) => needFor(item, reader)),
      ...(services.prompts?.items(
        id,
        reader,
        ctx.caller.kind === 'human' ? undefined : partyIdOf(ctx.caller),
      ) ?? []),
      ...[
        ...proposals.items(id, ctx.caller.kind === 'human' ? undefined : reach),
        ...reviews.items(id),
        ...stalled.items(id),
        ...(services.runProblems?.(id) ?? []),
        // A worktree's setup card names no agent: a token's view below never holds it; nor does
        // a workspace change's (B9a C7).
        ...(ctx.caller.kind === 'human' ? (services.setups?.items(id) ?? []) : []),
        ...(ctx.caller.kind === 'human' ? (services.workspaceItems?.(id) ?? []) : []),
      ].map((item) => needFor(item, reader)),
    ];
    if (ctx.caller.kind === 'human') return items;
    const { caller } = ctx;
    const team = caller.kind === 'agent' ? teamOf(open.document.nodes, caller.agent) : [];
    const party = partyIdOf(caller);
    return items.filter((item) =>
      // An ask is on no agent: its recipient sees it, as one it may answer (B21 C6).
      item.id.startsWith('ask/')
        ? item.by.includes(party)
        : item.agent !== undefined &&
          (reach.includes(item.agent) || (item.kind === 'prompt' && team.includes(item.agent))),
    );
  };

  return {
    agents: ({ canvas }, ctx) => {
      const open = openCanvas(engines, canvas);
      const { document, engine } = open;
      const reach = reached(open, 'agents', ctx);
      return {
        agents: reach.map((id) => {
          const node = agentOf(open, id);
          const endpoint = engine.catalog.endpointOf(node.data);
          return {
            id,
            name: agentName(document.nodes, id),
            adapter: endpoint.kind === 'unchosen' ? null : endpoint.adapter,
            connection: engine.catalog.connectionOf(node.data) ?? null,
            state: stateOf(open, id),
            prompts: promptsOf(open, id),
            linked: reach.filter((other) => other !== id && areLinked(document.links, id, other)),
            // Observed, never claimed: its session's generation listed corrallm's tools.
            api: services.listed?.(document.id, id) === true,
            fallback: fallbackOf(open, id),
            handoff: handoffOf(open, id),
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
            fallback: fallbackOf(open, id),
            handoff: handoffOf(open, id),
          };
        }),
        waitingForYou: waiting(open, ctx, reach),
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
                  ...(services.workspaceItems?.(id) ?? []),
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
      // The messages the caller sees, whole (as its topic gives them), then paged.
      const items = pageOf(
        messagesSeen(open, ctx.caller)
          .filter(
            (message) =>
              (other === undefined || message.from === other || message.to === other) &&
              (open.messages.seqOf(message.id) ?? 0) > (from ?? 0),
          )
          .slice(0, limit),
      );
      const last = items.at(-1);
      const next = last === undefined ? (from ?? 0) : (open.messages.seqOf(last.id) ?? 0);
      return { items, next: cursorOf('messages', { [id]: next }) };
    },
    message: async ({ canvas, to, body, images, replyTo }, ctx) => {
      const open = openCanvas(engines, canvas);
      if (replyTo !== undefined && !open.messages.get(replyTo)) {
        throw new OpFailure('not-found', `There is no message ${replyTo}.`);
      }
      // B21 C5: to you, or to the sender's manager: a record and a Needs item for you; B24 C4: to
      // the nearest lead granted questions, an ordinary message to it, shown as to its manager.
      if (typeof to !== 'string') {
        const { via } = partyTarget(to, ctx);
        const from = partyIdOf(ctx.caller);
        const lead = via === undefined ? undefined : partyAgent(open.delivery.asks.managerOf(from));
        try {
          if (lead !== undefined) {
            const sent = await open.delivery.send(from, lead, body, replyTo, { via: 'manager' });
            return { id: sent.id };
          }
          const sent = await open.delivery.asks.toYou({
            from,
            body,
            ...(replyTo === undefined ? {} : { replyTo }),
            ...(via === undefined ? {} : { via }),
          });
          return { id: sent.id };
        } catch (error) {
          return failed(error);
        }
      }
      const node = agentOf(open, to);
      // B16 C2: command text is routed by the recipient's connection, the same for every caller,
      // on the body as given: what its view answers, or only another connection runs, never goes.
      const routed = commandRefusal(open, services, to, body);
      if (routed !== undefined) throw new OpFailure('refused', routed);
      // Images only of the kinds, number and size its connection takes (yours alone: human-text).
      const pasted = images ?? [];
      if (pasted.length > 0) {
        const connection = open.engine.catalog.connectionOf(node.data);
        const refusal = imageRefusal(
          pasted,
          open.engine.catalog.images(connection),
          `${nameOf(open.document.nodes, to)}’s connection`,
        );
        if (refusal !== undefined) throw new OpFailure('refused', refusal);
      }
      try {
        const sent = await open.delivery.send(
          partyIdOf(ctx.caller),
          to,
          body,
          replyTo,
          pasted.length > 0 ? { images: pasted } : {},
        );
        return { id: sent.id };
      } catch (error) {
        return failed(error);
      }
    },
    // B21 C4, C6: on disk before it returns; its answer comes later, as a message.
    ask: async ({ canvas, to, questions, deadlineSeconds, request }, ctx) => {
      const open = openCanvas(engines, canvas);
      const recipient =
        typeof to === 'string'
          ? { to: agentParty(agentOf(open, to).id) }
          : { to: 'you' as const, ...partyTarget(to, ctx) };
      // B21 C7: asked during one of its task's attempt's own turns, it belongs to that task.
      const own = ctx.caller.kind === 'agent' ? ownTurn(open, ctx.caller.agent) : undefined;
      try {
        const asked = await open.delivery.asks.ask({
          from: partyIdOf(ctx.caller),
          ...recipient,
          questions,
          seconds: deadlineSeconds,
          ...(request === undefined ? {} : { request }),
          ...(own === undefined ? {} : { task: own.task }),
        });
        return { id: asked.id as MessageId };
      } catch (error) {
        return failed(error);
      }
    },
    // B21 C5 (Design §9.2 C8): the caller's own tool step's attempt, during its own turn, once; a
    // result record on disk before it returns, its verdict fixed then and applied as that turn ends.
    complete: async ({ canvas, task, outcome, summary }, ctx) => {
      const open = openCanvas(engines, canvas);
      const { caller } = ctx;
      // Its reach resolved it as the caller's own (`ownTurn`): read again here, nothing awaited.
      const own = caller.kind === 'agent' ? ownTurn(open, caller.agent) : undefined;
      if (own?.task.attempt !== task) {
        throw new OpFailure('not-found', `There is no attempt ${task}.`);
      }
      const { messages } = open;
      const first = messages.toldAs(resultKey(task));
      if (first !== undefined) {
        throw new OpFailure(
          'conflict',
          `This step was already reported ${first.verdict?.outcome ?? 'once'}.`,
        );
      }
      messages.add(
        {
          from: partyIdOf(caller),
          to: 'corrallm',
          kind: 'result',
          origin: 'party',
          body: capBody(`${outcome === 'succeeded' ? 'Succeeded' : 'Failed'}: ${summary}`, 'reply'),
          replyTo: own.message.id,
          task: own.task,
          state: 'delivered',
          verdict: { v: 1, outcome, summary },
        },
        resultKey(task),
      );
      // At once: its open asks and its continuations to come are withdrawn, so no later turn joins
      // its task; nothing downstream moves before its turn's native end.
      open.delivery.asks.withdrawTask(own.task, 'completed');
      try {
        await messages.durable();
      } catch (error) {
        throw new OpFailure(
          'unavailable',
          `The report stands now, but it could not be saved and may not survive a restart (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      return {};
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

/**
 * Where a party target goes (B21 C4, C5; B24 C4): you, or the caller's manager, which delivery
 * resolves to the nearest lead its tree grants questions, else you, `via` it. You name neither (you
 * message agents), and an outside orchestrator has no manager.
 */
function partyTarget(
  { party }: { party: 'you' | 'manager' },
  { caller }: OpContext,
): { via?: 'manager' } {
  if (caller.kind === 'human') {
    throw new OpFailure('invalid', 'You message agents: name an agent, not a party.');
  }
  if (party === 'manager' && caller.kind === 'outside') {
    throw new OpFailure(
      'invalid',
      "An outside orchestrator has no manager: name an agent, or { party: 'you' }.",
    );
  }
  return party === 'manager' ? { via: 'manager' } : {};
}

/**
 * Throws what delivery refused, or couldn't save, as the op's failure, with its code; anything else
 * as it is.
 */
function failed(error: unknown): never {
  if (error instanceof DeliveryError) throw new OpFailure(error.code, error.message);
  throw error;
}

/**
 * How an agent is now: waiting for you (by its session's word, or on a prompt the core's owner
 * holds: B13 C9), working, limited by usage, paused, or idle.
 */
export function stateOf(
  { engine, delivery, waitingOn }: OpenCanvas,
  id: string,
): (typeof AGENT_STATES)[number] {
  const session = engine.sessions.of(id);
  if (session.status === 'waiting' || waitingOn?.(id) !== undefined) return 'waiting';
  if (session.status === 'working') return 'working';
  if (delivery.limited().some(({ agent }) => agent === id)) return 'limited';
  return engine.run.snapshot().agents[id]?.paused ? 'paused' : 'idle';
}

/**
 * Why `body` isn't sent to agent `to` as a message (B16 C2, the API Spec's §5.6): its current
 * connection's view answers it in a panel, or it runs only in that connection's `continueIn`
 * connection (a command, or shell text by that connection's own prefix). None: it goes.
 */
function commandRefusal(
  open: OpenCanvas,
  services: Pick<OpServices, 'catalog'>,
  to: string,
  body: string,
): string | undefined {
  const node = agentOf(open, to);
  const id = open.engine.catalog.connectionOf(node.data);
  const found = id === undefined ? undefined : connectionIn(services.catalog, id);
  if (found === undefined) return undefined;
  const { connection } = found;
  const target =
    connection.continueIn === undefined
      ? undefined
      : connectionIn(services.catalog, connection.continueIn.connection);
  const route = routeOf(body, {
    connection,
    target: target?.connection,
    offered: open.engine.sessions.of(to).commands,
  });
  const named = target === undefined ? '' : `${target.adapter.name} · ${target.connection.label}`;
  return routeRefusal(route, nameOf(open.document.nodes, to), named);
}
