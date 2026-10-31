import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import { canvasesOf } from '../caller';
import { agentsReached } from '../reach';
import { mergeCallerOf } from '../workspaces/merge';
import { openCanvas, reachFor } from './open';
import type { Implementations, OpServices } from '.';

/** Review and merge through the core's services; callers supply observations, never Git paths. */
export function branchOps({
  worktrees,
  engines,
  isLead,
}: Pick<OpServices, 'worktrees' | 'engines' | 'isLead'>): Pick<
  Implementations,
  'branch.diff' | 'branch.merge'
> {
  return {
    'branch.diff': async ({ canvas, agent, after, limit }, ctx) => {
      if (canvas === undefined || worktrees?.diff === undefined)
        throw new OpFailure('unavailable', 'This corrallm can’t review worktree branches.');
      const id = canvas as string as CanvasId;
      const { caller } = ctx;
      const view = () => {
        if (caller.kind === 'human') return { viewer: { kind: 'you' as const } };
        const { document } = openCanvas(engines, canvas);
        const lead = caller.kind === 'agent' && isLead(id, caller.agent);
        return {
          document,
          viewer: {
            kind: 'token' as const,
            reached: new Set(agentsReached(document, caller, reachFor('worktree.list', ctx), lead)),
          },
        };
      };
      const result = await worktrees.diff({
        canvas: id,
        agent,
        ...(after === undefined ? {} : { after }),
        limit,
        ...view(),
      });
      if (!result.ok) throw new OpFailure(result.error.code, result.error.sentence);
      return result.value;
    },
    'branch.merge': async ({ canvas, agent, source, into, uncommitted, request }, ctx) => {
      if (canvas === undefined || worktrees?.merge === undefined)
        throw new OpFailure('unavailable', 'This corrallm can’t merge worktree branches.');
      const id = canvas as string as CanvasId;
      const { caller } = ctx;
      const result = await worktrees.merge({
        canvas: id,
        agent,
        source,
        into,
        uncommitted,
        request,
        caller: mergeCallerOf(caller),
        authorized: () => {
          if (caller.kind === 'human') return true;
          if (!canvasesOf(caller).includes(id)) return false;
          const open = engines.canvas(id);
          if (open === undefined) return false;
          const lead = caller.kind === 'agent' && isLead(id, caller.agent);
          return agentsReached(open.document, caller, reachFor('branch.merge', ctx), lead).includes(
            agent,
          );
        },
        signal: ctx.signal,
      });
      ctx.published(`worktrees:${id}`);
      if (!result.ok) throw new OpFailure(result.error.code, result.error.sentence);
      if (result.value.outcome === 'already-merged') return result.value;
      const { recorded, ...merged } = result.value;
      return { ...merged, ...(recorded === false ? { checkpointRecorded: false as const } : {}) };
    },
  };
}
