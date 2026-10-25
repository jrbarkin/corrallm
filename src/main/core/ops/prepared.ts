import type { z } from 'zod';

import type { OpDef } from '../../../shared/api/define';
import { b9aWorktreeOps } from '../../../shared/api/ops/project';
import { PREPARED_SURFACE } from '../../../shared/api/prepared';
import type { PreparedName } from '../../../shared/api/prepared';
import { OpFailure, ProposedInstead } from '../call';
import type { Implementation, OpContext } from '../call';
import type { CanvasId } from '../../../shared/canvas';
import type { Proposals } from '../canvas/proposals';
import { keptWords } from '../canvas/proposals';
import type { WorkspaceCleanup } from '../workspaces/cleanup';
import type { WorkspaceStore } from '../workspaces/store';

/** B9a C7's kept-worktree removal, prepared until X12 registers it. */

/** Their schemas, by name. */
export const PREPARED_OPS: Readonly<Record<PreparedName, OpDef>> = Object.fromEntries(
  (Object.keys(PREPARED_SURFACE) as PreparedName[]).map((name) => [name, b9aWorktreeOps[name]]),
) as unknown as Record<PreparedName, OpDef>;

/** The kept-worktree removal implementation. */
export function preparedOps(worktrees: {
  cleanup?: Pick<WorkspaceCleanup, 'removeKept'>;
  proposals: Pick<Proposals, 'raise'>;
  /** The name of the agent or group whose a tree was, for its confirmation's words. */
  nameOf: (canvas: CanvasId, owner: string) => string | undefined;
  workspaces: Pick<WorkspaceStore, 'worktree'>;
}): Readonly<Record<string, Implementation>> {
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
  return { 'worktree.remove': remove };
}
