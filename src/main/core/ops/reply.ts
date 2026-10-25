import { OpFailure } from '../call';
import type { OpContext } from '../call';
import type { Lifecycle } from '../canvas/lifecycle';
import { cleanupOf, isDocOp, itemOf } from '../canvas/proposals';
import type { Outcome } from '../canvas/proposals';
import { itemOf as reviewItemOf } from '../canvas/reviews';
import { partyText } from '../parties';
import { notFound, ReplyRouter } from '../replies';
import type { Answer, ReplyHandler, ReplyResult } from '../replies';
import { SetupError } from '../workspaces/setup';
import type { Implementations, OpServices } from '.';

/*
 * `reply` (API Spec §7.5, B9 Design §5, B11 Design §7): answers a Needs item its caller may answer,
 * by its id, through the one reply router (replies.ts), which checks that it waits now at the
 * generation its id names, that its caller is no agent answering what waits on itself (R6), is one
 * its `by` names (R3, checked as the call arrives too: rules.ts), and that the answer is one it
 * takes and, if only you may choose it, yours; then its handler acts:
 *
 * - A proposal (canvas/proposals.ts): Refuse settles it. Allow runs its op again, as you, recording
 *   who proposed it, in this call's turn (ctx.call), draining its lanes: its change, the settlement
 *   and the proposer's record in one write, only if neither its original touched entities nor
 *   anything its replay now changes has another revision than the canvas had when it was proposed;
 *   if one has, or the op no longer applies (what it named is gone, or it would change nothing), it
 *   is settled stale, changing nothing. A proposal of a close, a replace or a save (R4's argument
 *   half) touched a canvas's document and file, not its entities: it goes stale if either changed
 *   since (its document's fingerprint covers work added since); Allow of one, a command with no
 *   change of a document's to carry its settlement, settles it in a write of its own once it
 *   applied. Either way the proposer gets a record, whose id this returns.
 * - A file review (canvas/reviews.ts): Apply reads the file again and, if its bytes are still those
 *   reviewed, makes the canvas it holds your change (`file.apply`), its hashes and the settlement in
 *   the same commit, which the canvas's run follows; if the file changed since, the review is
 *   superseded by one of what is there now (none if that is as the core has it), changing nothing.
 *   Keep settles it; the canvas's next save writes it over the file.
 * - A silent turn's stalled/<agent> prompt offers Interrupt or Interrupt and resend, for you alone;
 *   it never stops a turn on its own.
 * - A worktree's setup card (workspaces/setup.ts, B9a): yours alone, answered only at the
 *   generation it names, so a card raised anew (its command changed) is stale; Run and Always return
 *   once your approval is on disk and the command is scheduled, not when it is done.
 * - What a canvas's runtime asks (its run's holds, its sessions' prompts: run-replies.ts) and a
 *   workspace's change (workspaces/rebind.ts) are answered by the handlers the core composes for
 *   them (`OpServices.replies`, B11 C7); without them, answer them in corrallm's
 *   window.
 */

/** The failures of Allow's run that mean the canvas moved on under the proposal: it went stale. */
const STALE = new Set(['conflict', 'not-found', 'invalid', 'refused']);
/** The keys of a document's entities, which Allow's change expects to be at their revisions still. */
const ENTITY = /^(?:(?:node|link|item)\/|meta$)/;

export function replyOps({
  proposals,
  reviews,
  documents,
  engines,
  needOf,
  lifecycle,
  windows,
  stalled,
  sessions,
  setups,
  replies,
  workspaceReplies,
}: Pick<
  OpServices,
  'proposals' | 'reviews' | 'needOf' | 'setups' | 'replies' | 'workspaceReplies'
> & {
  documents: Pick<OpServices['documents'], 'applyFile' | 'keepFile'>;
  engines: Pick<OpServices['engines'], 'changed' | 'resendAfter' | 'cancelResend'>;
  lifecycle: Pick<Lifecycle, 'touched'>;
  windows: Pick<OpServices['windows'], 'shownIn'>;
  stalled: OpServices['stalled'];
  sessions: Pick<OpServices['sessions'], 'interruptIf'>;
}): Pick<Implementations, 'reply'> {
  const proposal: ReplyHandler = {
    prefixes: ['proposal'],
    current: (canvas, to) => {
      const open = proposals.get(canvas, to);
      return open === undefined ? undefined : itemOf(open);
    },
    gone: (canvas, to) => {
      const settled = proposals.settled(canvas, to);
      if (settled === undefined) return undefined;
      return new OpFailure(
        'conflict',
        `${to} is settled already: ${partyText([], settled.by)} ${settled.outcome === 'stale' ? 'allowed it, and it went stale' : settled.outcome} it.`,
      );
    },
    act: async (canvas, item, answer, ctx) => {
      const open = proposals.get(canvas, item.id);
      if (open === undefined) throw notFound(item.id);
      const choice = 'choice' in answer ? answer.choice : '';
      const settled = async (outcome: Outcome, why?: string): Promise<ReplyResult> => {
        const record = await proposals.settle(open, outcome, ctx.by, why);
        return { id: record.id, outcome };
      };
      if (choice === 'refuse') return settled('refused');
      // A command (R4's argument half: a close, a replace, a save) has no `before`: its guard is
      // what it touched, its canvas's document and file, checked here.
      const command = !isDocOp(open.op);
      // What it touched beyond the document's entities (a canvas's document, its file: R4's
      // argument half, canvas/lifecycle.ts) must be as it was, or it went stale.
      const expect: Record<string, number> = {};
      for (const [key, rev] of Object.entries(open.touched)) {
        if (ENTITY.test(key)) expect[key] = rev;
        else if ((await lifecycle.touched(key)) !== rev) {
          return settled(
            'stale',
            key.startsWith('file:')
              ? 'its file changed on disk since it was proposed'
              : 'the canvas changed since it was proposed',
          );
        }
      }
      const settlement = await proposals.settlement(open, 'allowed', ctx.by);
      const cleanups: (() => Promise<void>)[] = [];
      // A deletion's trees (B9a C7): kept (Allow) or discarded, as each held when proposed.
      const cleanup = cleanupOf(open, choice);
      try {
        await ctx.call(open.op, open.args, {
          proposedBy: open.by,
          expect,
          ...(cleanup === undefined ? {} : { cleanup }),
          ...(open.before === undefined ? {} : { unchanged: open.before }),
          // A code restore's guard (R5), which its op checks again under the workspace gate.
          ...(open.guard === undefined ? {} : { guard: open.guard }),
          ...(command
            ? {
                after: (cleanup: () => Promise<void>) => {
                  cleanups.push(cleanup);
                },
              }
            : { within: () => settlement.within() }),
        });
      } catch (error) {
        if (!(error instanceof OpFailure) || !STALE.has(error.code)) throw error;
        return settled('stale', error.code === 'conflict' ? undefined : clause(error.message));
      }
      const { record } = settlement;
      if (record === undefined) {
        // A command (a close, a save) applied with no change of a document's to settle it with: it
        // is settled in a write of its own.
        if (command) {
          const result = await settled('allowed');
          for (const cleanup of cleanups) await cleanup();
          return result;
        }
        // It committed nothing: what it would change is no longer there to change.
        return settled('stale', 'it would change nothing now');
      }
      return { id: record.id, outcome: 'allowed' };
    },
  };

  const review: ReplyHandler = {
    prefixes: ['file'],
    current: (canvas, to) => {
      const open = reviews.get(canvas, to);
      return open === undefined ? undefined : reviewItemOf(open);
    },
    gone: (canvas, to) => {
      const settled = reviews.settled(canvas, to);
      if (settled === undefined) return undefined;
      return new OpFailure(
        'conflict',
        `${to} is settled already: ${settled.outcome === 'superseded' ? 'the file changed since, which superseded it' : `${partyText([], settled.by)} ${settled.outcome} it`}.`,
      );
    },
    act: async (canvas, item, answer, ctx) => {
      const open = reviews.get(canvas, item.id);
      if (open === undefined) throw notFound(item.id);
      if ('choice' in answer && answer.choice === 'keep') {
        await documents.keepFile(canvas, open, ctx.by);
        return { outcome: 'kept' };
      }
      const applied = await documents.applyFile(canvas, open, ctx.by, ctx);
      if ('superseded' in applied) {
        const { superseded: raised } = applied;
        return { outcome: 'superseded', ...(raised === undefined ? {} : { raised: raised.id }) };
      }
      // Its run follows it, as it follows any change.
      engines.changed(canvas);
      ctx.reached(canvas, applied.rev);
      return { outcome: 'applied' };
    },
  };

  const silent: ReplyHandler = {
    prefixes: ['stalled'],
    current: (canvas, to) => stalled.items(canvas).find((one) => one.id === to),
    act: async (canvas, item, answer, ctx) => {
      const agent = item.agent;
      if (agent === undefined) throw notFound(item.id);
      const turn = stalled.take(canvas, agent);
      if (!turn) throw notFound(item.id);
      ctx.noReturn();
      const resend = 'choice' in answer && answer.choice === 'resend';
      try {
        if (resend) await engines.resendAfter(canvas, agent, turn.messages, turn.connection);
        if (!(await sessions.interruptIf(canvas, agent, turn.current, resend)))
          await engines.cancelResend(canvas, agent, turn.connection);
      } catch (error) {
        await engines.cancelResend(canvas, agent, turn.connection);
        turn.release();
        throw error;
      }
      return {};
    },
  };

  const setup: ReplyHandler = {
    prefixes: ['setup'],
    current: (canvas, to) => setups?.items(canvas).find((one) => one.id === to),
    gone: (canvas, to) => {
      // Settled, or raised anew since (what it would run changed).
      const why = setups?.gone(canvas, to);
      return why === undefined ? undefined : new OpFailure(why.code, why.message);
    },
    act: async (canvas, item, answer, ctx) => {
      if (setups === undefined) throw notFound(item.id);
      try {
        return await setups.reply(
          canvas,
          item.id,
          'choice' in answer ? answer.choice : '',
          ctx.by,
          ctx,
        );
      } catch (error) {
        if (error instanceof SetupError) throw new OpFailure(error.code, error.message);
        throw error;
      }
    },
  };

  // Without the runtime's handlers, what it asks is answered in corrallm's window.
  const window: ReplyHandler = {
    prefixes: ['hold', 'start', 'unasking', 'limited', 'prompt'],
    current: (canvas, to) => needOf(canvas, to),
    fits: () => undefined,
    act: (_canvas, item) =>
      Promise.reject(
        new OpFailure(
          'unavailable',
          `corrallm answers only proposals and file reviews with reply so far: answer ${item.id} in corrallm’s window.`,
        ),
      ),
  };

  const router = new ReplyRouter([
    proposal,
    review,
    silent,
    setup,
    ...(workspaceReplies ?? []),
    ...(replies ?? [window]),
  ]);

  const answer = (
    args: { canvas?: string | undefined; to: string; answer: Answer },
    ctx: OpContext,
  ) => router.reply(args, ctx);

  return {
    reply: async (args, ctx) => {
      const window =
        ctx.caller.kind === 'human' && ctx.caller.window !== 'host' ? ctx.caller.window : undefined;
      const before = window === undefined ? undefined : windows.shownIn(window);
      const result = await answer(args, ctx);
      const shown = window === undefined ? undefined : windows.shownIn(window);
      return (
        shown !== undefined && shown !== before ? { ...result, canvas: shown } : result
      ) as never;
    },
  };
}

/** A sentence as a clause, to follow "but": its first letter small, its stop gone. */
function clause(sentence: string): string {
  const trimmed = sentence.replace(/[.\s]+$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
