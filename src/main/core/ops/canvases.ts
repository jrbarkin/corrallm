import type { ResultOf } from '../../../shared/api/registry';
import { canvasStateOf } from '../../../shared/model/state';
import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { canvasesOf } from '../caller';
import { viewOf } from '../canvas/view';
import { reachFor } from './open';
import type { Implementations, OpServices } from '.';

/**
 * The canvases the core keeps, and each one's state (B9 Design §7, §8): what the `canvases` and
 * `canvas:<c>` topics carry, read once. A token lists only its own canvases; a lead's canvas holds
 * only what it reaches (canvas/view.ts), as its topic would.
 */
export function canvasesOps({
  states,
  isLead,
}: Pick<OpServices, 'states' | 'isLead'>): Pick<Implementations, 'canvas.list' | 'canvas.get'> {
  return {
    'canvas.list': async (_args, { caller }) => {
      const items = await states.list();
      if (caller.kind === 'human') return { items };
      const theirs: readonly string[] = canvasesOf(caller);
      return { items: items.filter((item) => theirs.includes(item.canvas)) };
    },
    'canvas.get': async (args, ctx) => {
      if (args.canvas === undefined) {
        throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
      }
      const canvas = args.canvas as string as CanvasId;
      const { rev, entities, document } = await states.read(canvas);
      const state = canvasStateOf(
        canvas,
        rev,
        viewOf(document, entities, ctx.caller, reachFor('canvas.get', ctx), lead(canvas, ctx)),
      );
      // Its schema describes nodes and queue items loosely (their data is the document's own);
      // core.call checks the result against it where it checks results.
      return state as ResultOf<'canvas.get'>;
    },
  };

  function lead(canvas: CanvasId, { caller }: OpContext): boolean {
    return caller.kind === 'agent' && isLead(canvas, caller.agent);
  }
}
