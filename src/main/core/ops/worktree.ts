import { OpFailure, ProposedInstead } from '../call';
import type { CanvasId } from '../../../shared/canvas';
import type { Proposals } from '../canvas/proposals';
import { keptWords } from '../canvas/proposals';
import type { WorkspaceCleanup } from '../workspaces/cleanup';
import type { WorkspaceStore } from '../workspaces/store';
import type { Implementations, OpServices } from '.';

/** C7's removal dependencies, composed by the core, never selected by the caller. */
export interface WorktreeServices {
  cleanup?: Pick<WorkspaceCleanup, 'removeKept'>;
  proposals: Pick<Proposals, 'raise'>;
  /** The name of the agent or group whose a tree was, for its confirmation's words. */
  nameOf: (canvas: CanvasId, owner: string) => string | undefined;
  workspaces: Pick<WorkspaceStore, 'worktree'>;
}

/** Kept-worktree removal delegates every cleanup decision to C7. */
export function worktreeOps({ worktrees }: OpServices): Pick<Implementations, 'worktree.remove'> {
  return {
    'worktree.remove': async ({ canvas, worktree }, ctx) => {
      if (worktrees === undefined)
        throw new OpFailure('unavailable', 'This corrallm keeps no worktrees yet.');
      const { cleanup, proposals } = worktrees;
      if (cleanup === undefined || canvas === undefined) {
        throw new OpFailure('unavailable', 'This corrallm keeps no worktrees yet.');
      }
      const id = canvas as string as CanvasId;
      ctx.published(`needs:${id}`);
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
    },
  };
}
