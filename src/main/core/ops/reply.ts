import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import { itemOf } from '../canvas/proposals';
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
 * changes has another revision; if one has, or the op no longer
 * applies (what it named is gone, or it would change nothing), it is settled stale, changing
 * nothing. Either way the proposer gets a record, whose id this returns.
 */

/** The failures of Allow's run that mean the canvas moved on under the proposal: it went stale. */
const STALE = new Set(['conflict', 'not-found', 'invalid', 'refused']);

export function replyOps({
  proposals,
  needOf,
}: Pick<OpServices, 'proposals' | 'needOf'>): Pick<Implementations, 'reply'> {
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
      // Older proposals recorded only their first write set, so cannot guard newly affected work.
      if (proposal.before === undefined)
        return settled('stale', 'its earlier canvas snapshot cannot be checked safely');
      const settlement = await proposals.settlement(proposal, 'allowed', ctx.by);
      try {
        await ctx.call(proposal.op, proposal.args, {
          proposedBy: proposal.by,
          expect: proposal.touched,
          unchanged: proposal.before,
          within: () => settlement.within(),
        });
      } catch (error) {
        if (!(error instanceof OpFailure) || !STALE.has(error.code)) throw error;
        return settled('stale', error.code === 'conflict' ? undefined : clause(error.message));
      }
      const { record } = settlement;
      // It committed nothing: what it would change is no longer there to change.
      if (record === undefined) return settled('stale', 'it would change nothing now');
      return { id: record.id, outcome: 'allowed' as const };
    },
  };
}

/** A sentence as a clause, to follow "but": its first letter small, its stop gone. */
function clause(sentence: string): string {
  const trimmed = sentence.replace(/[.\s]+$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
