import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import type { Lifecycle } from '../canvas/lifecycle';
import { isDocOp, itemOf } from '../canvas/proposals';
import type { Outcome } from '../canvas/proposals';
import { partyText } from '../parties';
import type { Implementations, OpServices } from '.';

/*
 * `reply` (API Spec §7.5, B9 Design §5): answers a Needs item its caller may answer, by its id, with
 * one of its choices. In B9 that is a proposal, which only you answer (R3, checked as the call
 * arrives: rules.ts), choosing Allow or Refuse; a hold of the run and a session's prompt are
 * answered in corrallm's window until B11 moves them into the core, and file reviews come with B9's
 * task 12. Refuse settles the proposal. Allow runs its op again, as you, recording who proposed it,
 * in this call's turn (ctx.call), draining its lanes: its change, the settlement and the proposer's
 * record in one write, only if neither its original touched entities nor anything its replay now
 * changes has another revision than the canvas had when it was proposed; if one has, or the op no
 * longer applies (what it named is gone, or it would change nothing), it is settled stale, changing
 * nothing. A proposal of a close, a replace or a save (R4's argument half) touched a canvas's
 * document and file, not its entities: it goes stale if either changed since (its document's
 * fingerprint covers work added since); Allow of one, a command with no change of a document's to
 * carry its settlement, settles it in a write of its own once it applied. Either way the proposer
 * gets a record, whose id this returns.
 */

/** The failures of Allow's run that mean the canvas moved on under the proposal: it went stale. */
const STALE = new Set(['conflict', 'not-found', 'invalid', 'refused']);
/** The keys of a document's entities, which Allow's change expects to be at their revisions still. */
const ENTITY = /^(?:(?:node|link|item)\/|meta$)/;

export function replyOps({
  proposals,
  needOf,
  lifecycle,
}: Pick<OpServices, 'proposals' | 'needOf'> & {
  lifecycle: Pick<Lifecycle, 'touched'>;
}): Pick<Implementations, 'reply'> {
  return {
    reply: async ({ canvas, to, answer }, ctx) => {
      const id = canvas as string | undefined as CanvasId | undefined;
      if (id === undefined) throw new OpFailure('invalid', 'Name the canvas the item is on.');
      const proposal = proposals.get(id, to);
      if (proposal === undefined) {
        const settled = proposals.settled(id, to);
        if (settled !== undefined) {
          throw new OpFailure(
            'conflict',
            `${to} is settled already: ${partyText([], settled.by)} ${settled.outcome === 'stale' ? 'allowed it, and it went stale' : settled.outcome} it.`,
          );
        }
        if (needOf(id, to) !== undefined) {
          throw new OpFailure(
            'unavailable',
            `corrallm answers only proposals with reply so far: answer ${to} in corrallm’s window.`,
          );
        }
        throw new OpFailure('not-found', `There is no Needs item ${to} on this canvas.`);
      }
      const item = itemOf(proposal);
      if (!item.by.includes(ctx.by)) {
        throw new OpFailure('refused', `Only the user may answer ${to}: ${item.title}.`);
      }
      if (!item.choices.some(({ value }) => value === answer.choice)) {
        throw new OpFailure(
          'invalid',
          `${to} takes ${item.choices.map(({ value }) => `"${value}"`).join(' or ')}, not "${answer.choice}".`,
        );
      }
      const settled = async (outcome: Outcome, why?: string) => {
        const record = await proposals.settle(proposal, outcome, ctx.by, why);
        return { id: record.id, outcome };
      };
      if (answer.choice === 'refuse') return settled('refused');
      // A command (R4's argument half: a close, a replace, a save) has no `before`: its guard is
      // what it touched, its canvas's document and file, checked here.
      const command = !isDocOp(proposal.op);
      // What it touched beyond the document's entities (a canvas's document, its file: R4's
      // argument half, canvas/lifecycle.ts) must be as it was, or it went stale.
      const expect: Record<string, number> = {};
      for (const [key, rev] of Object.entries(proposal.touched)) {
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
      const settlement = await proposals.settlement(proposal, 'allowed', ctx.by);
      const cleanups: (() => Promise<void>)[] = [];
      try {
        await ctx.call(proposal.op, proposal.args, {
          proposedBy: proposal.by,
          expect,
          ...(proposal.before === undefined ? {} : { unchanged: proposal.before }),
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
      return { id: record.id, outcome: 'allowed' as const };
    },
  };
}

/** A sentence as a clause, to follow "but": its first letter small, its stop gone. */
function clause(sentence: string): string {
  const trimmed = sentence.replace(/[.\s]+$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
