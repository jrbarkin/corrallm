import type { z } from 'zod';

import type { OpDef } from '../../../shared/api/define';
import { b11ConversationOps } from '../../../shared/api/ops/conversation';
import { b9aWorktreeOps } from '../../../shared/api/ops/project';
import { b11SessionOps } from '../../../shared/api/ops/session';
import { PREPARED_SURFACE } from '../../../shared/api/prepared';
import type { PreparedName } from '../../../shared/api/prepared';
import { OpFailure, ProposedInstead } from '../call';
import type { Implementation, OpContext, Registry, RuleCheck } from '../call';
import type { CanvasId } from '../../../shared/canvas';
import type { Proposals } from '../canvas/proposals';
import { keptWords } from '../canvas/proposals';
import type { WorkspaceCleanup } from '../workspaces/cleanup';
import type { WorkspaceStore } from '../workspaces/store';
import type { TokenCaller } from '../caller';
import type { SessionControl } from '../session-control';

/*
 * B11 C6's and C7's operations as the core implements them, prepared for X9 to register: their
 * schemas are `b11SessionOps` and `b11ConversationOps.reply` (its typed answers), their surfaces
 * PREPARED_SURFACE, and R5's check on a token's session.rewind is `restore-code`'s. `reply`'s
 * implementation is the live one (ops/reply.ts, over the reply router), given the runtime's
 * handlers (OpServices.replies) where these are registered. Nothing composes these into the live
 * registry until then; the core's tests do (CoreConfig.preparedOps).
 */

/** The prepared session ops: those SessionControl implements. */
type SessionName = Exclude<PreparedName, 'reply' | 'worktree.remove'>;

type ArgsOf<N extends SessionName> = z.infer<(typeof b11SessionOps)[N]['input']>;

type Prepared = {
  [N in SessionName]: (args: ArgsOf<N>, ctx: OpContext) => unknown;
};

/** Their schemas, by name. */
export const PREPARED_OPS: Readonly<Record<PreparedName, OpDef>> = Object.fromEntries(
  (Object.keys(PREPARED_SURFACE) as PreparedName[]).map((name) => [
    name,
    name === 'reply'
      ? b11ConversationOps.reply
      : name === 'worktree.remove'
        ? b9aWorktreeOps['worktree.remove']
        : b11SessionOps[name],
  ]),
) as unknown as Record<PreparedName, OpDef>;

/** The session ops' implementations, by name (reply's is the live one), and worktree.remove's. */
export function preparedOps(
  control: SessionControl,
  worktrees: {
    cleanup?: Pick<WorkspaceCleanup, 'removeKept'>;
    proposals: Pick<Proposals, 'raise'>;
    /** The name of the agent or group whose a tree was, for its confirmation's words. */
    nameOf: (canvas: CanvasId, owner: string) => string | undefined;
    workspaces: Pick<WorkspaceStore, 'worktree'>;
  },
): Readonly<Record<string, Implementation>> {
  const remove = async (
    { canvas, worktree }: z.infer<(typeof b9aWorktreeOps)['worktree.remove']['input']>,
    ctx: OpContext,
  ) => {
    const { cleanup, proposals } = worktrees;
    if (cleanup === undefined || canvas === undefined) {
      throw new OpFailure('unavailable', 'This corrallm keeps no worktrees yet.');
    }
    const id = canvas as string as CanvasId;
    const outcome = await cleanup.removeKept(id, worktree, ctx.cleanup);
    if ('removed' in outcome) return { removed: true };
    if ('retained' in outcome) return { removed: false, retained: true };
    // What it holds is yours to confirm discarding: the same proposals as a deletion's.
    const tree = worktrees.workspaces.worktree(worktree);
    const name = tree === undefined ? undefined : worktrees.nameOf(id, tree.owner);
    const of = name === undefined ? 'a kept worktree' : `${name}’s kept worktree`;
    const need = await proposals.raise(id, {
      op: 'worktree.remove',
      args: { canvas, worktree },
      by: ctx.by,
      touched: {},
      lost: {
        what: `remove ${of} and its branch`,
        title: `Remove ${of}? It holds work.`,
        detail: keptWords(outcome.asks),
      },
      trees: [outcome.asks],
    });
    throw new ProposedInstead(need);
  };
  const ops: Prepared & { 'worktree.remove': typeof remove } = {
    'worktree.remove': remove,
    'session.open': (args) => control.open(args),
    'session.setMode': (args, ctx) => control.setMode(args, ctx),
    'session.setModel': (args, ctx) => control.setModel(args, ctx),
    'session.setEffort': (args, ctx) => control.setEffort(args, ctx),
    'session.stopTask': (args, ctx) => control.stopTask(args, ctx),
    'session.restart': (args, ctx) => control.restart(args, ctx),
    'session.newConversation': (args, ctx) => control.newConversation(args, ctx),
    'session.rewindPreview': (args) => control.rewindPreview(args),
    'session.rewind': (args, ctx) => control.rewind(args, ctx),
    'session.continueIn': (args, ctx) => control.continueIn(args, ctx),
  };
  return ops;
}

/** R5's argument check, `restore-code` on session.rewind: a token's code restore proposes. */
export function preparedRules(control: SessionControl): Registry['rules'] {
  const restoreCode = ((args: ArgsOf<'session.rewind'>, call: { caller: TokenCaller }) =>
    control.restoreCode(args, call)) as RuleCheck;
  return { 'restore-code': { 'session.rewind': restoreCode } };
}
