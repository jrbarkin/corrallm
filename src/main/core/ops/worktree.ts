import { OpFailure, ProposedInstead } from '../call';
import type { BranchDiffOutput } from '../../../shared/api/branch';
import type { OpResult } from '../../../shared/api/errors';
import type { AgentId } from '../../../shared/api/ids';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { Proposals } from '../canvas/proposals';
import { keptWords } from '../canvas/proposals';
import { agentsReached } from '../reach';
import type { WorkspaceCleanup } from '../workspaces/cleanup';
import type { BranchDiffRequest } from '../workspaces/diff';
import type { Viewer, WorktreeListing } from '../workspaces/list';
import type { MergeRequest, MergeResult } from '../workspaces/merge';
import { ProvisionError } from '../workspaces/provision';
import type { WorkspaceStore } from '../workspaces/store';
import { openCanvas, reachFor } from './open';
import type { Implementations, OpServices } from '.';

/** The worktrees' services (B9a C7, X12's C), composed by the core, never selected by the caller. */
export interface WorktreeServices {
  cleanup?: Pick<WorkspaceCleanup, 'removeKept'>;
  proposals: Pick<Proposals, 'raise'>;
  /** The name of the agent or group whose a tree was, for its confirmation's words. */
  nameOf: (canvas: CanvasId, owner: string) => string | undefined;
  workspaces: Pick<WorkspaceStore, 'worktree'>;
  /**
   * The authorized selector (workspaces/list.ts): the canvas's worktrees as `viewer` sees them, of
   * `document` (the canvas's document now, if not given). Not-found for a canvas the core doesn't
   * keep.
   */
  list?: (
    canvas: CanvasId,
    viewer: Viewer,
    agent?: string,
    document?: CanvasDocument,
  ) => Promise<WorktreeListing>;
  /** An agent's worktree tried again (workspaces/directories.ts' `retry`), and its document now. */
  retry?: (canvas: CanvasId, agent: AgentId) => Promise<void>;
  document?: (canvas: CanvasId) => Promise<CanvasDocument | undefined>;
  /**
   * B9b C4's diff service (workspaces/diff.ts' `readBranchDiff`), composed by createCore for
   * `branch.diff` (X2): one page of an agent's branch for review, `shared` naming only the members
   * `request.viewer` reaches (built as worktree.list builds its viewer). Its error is the op's.
   */
  diff?: (request: BranchDiffRequest) => Promise<OpResult<BranchDiffOutput>>;
  /**
   * B9b C5's merge service (workspaces/merge.ts' `MergeService.merge`), composed by createCore for
   * `branch.merge` (X2): the agent's branch merged into your picked checkout's branch, answered
   * once it settled. Its caller is `mergeCallerOf(ctx.caller)`; its error is the op's.
   */
  merge?: (request: MergeRequest) => Promise<OpResult<MergeResult>>;
}

const NONE = 'This corrallm keeps no worktrees yet.';

/**
 * The worktree operations: who works where (yours whole, a token's as far as it reaches), an
 * agent's worktree tried again (yours alone), and a kept tree's removal, every cleanup decision
 * C7's.
 */
export function worktreeOps({
  worktrees,
  engines,
  isLead,
}: OpServices): Pick<Implementations, 'worktree.list' | 'worktree.retry' | 'worktree.remove'> {
  return {
    'worktree.list': async ({ canvas, agent }, ctx) => {
      const list = worktrees?.list;
      if (list === undefined || canvas === undefined) throw new OpFailure('unavailable', NONE);
      const id = canvas as string as CanvasId;
      const { caller } = ctx;
      if (caller.kind === 'human') return list(id, { kind: 'you' }, agent);
      // A token: the agents it reaches now, on the document reach was checked on.
      const { document } = openCanvas(engines, canvas);
      const lead = caller.kind === 'agent' && isLead(id, caller.agent);
      const reached = agentsReached(document, caller, reachFor('worktree.list', ctx), lead);
      return list(id, { kind: 'token', reached: new Set(reached) }, agent, document);
    },
    'worktree.retry': async ({ canvas, agent }, ctx) => {
      const { list, retry, document } = worktrees ?? {};
      if (list === undefined || retry === undefined || document === undefined)
        throw new OpFailure('unavailable', NONE);
      if (canvas === undefined) throw new OpFailure('unavailable', NONE);
      const id = canvas as string as CanvasId;
      const nodes = (await document(id))?.nodes ?? [];
      if (!nodes.some((node) => node.id === agent && node.type === 'agent'))
        throw new OpFailure('not-found', `There is no agent ${agent}.`);
      ctx.published(`worktrees:${id}`);
      ctx.published(`needs:${id}`);
      try {
        await retry(id, agent);
      } catch (error) {
        if (error instanceof ProvisionError) {
          throw new OpFailure(
            error.code === 'not-found' ? 'not-found' : 'unavailable',
            error.message,
          );
        }
        if (error instanceof Error && error.message.includes('closing'))
          throw new OpFailure('unavailable', error.message);
        throw error;
      }
      const [item] = (await list(id, { kind: 'you' }, agent)).items;
      if (item === undefined) throw new OpFailure('not-found', `There is no agent ${agent}.`);
      return { state: item.state, ...(item.need === undefined ? {} : { need: item.need }) };
    },
    'worktree.remove': async ({ canvas, worktree }, ctx) => {
      if (worktrees === undefined) throw new OpFailure('unavailable', NONE);
      const { cleanup, proposals } = worktrees;
      if (cleanup === undefined || canvas === undefined) {
        throw new OpFailure('unavailable', NONE);
      }
      const id = canvas as string as CanvasId;
      ctx.published(`needs:${id}`);
      ctx.published(`worktrees:${id}`);
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
