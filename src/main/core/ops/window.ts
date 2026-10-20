import { OpFailure } from '../call';
import type { OpContext } from '../call';
import type { WindowId } from '../host';
import type { CanvasId } from '../../../shared/canvas';
import type { Implementations, OpServices } from '.';

/** The canvas of the caller's window, never a window named by the page (Core Server §4 M). */
export function windowOps({
  windows,
  states,
  lifecycle,
}: OpServices): Pick<Implementations, 'window.get' | 'window.show'> {
  return {
    'window.get': async (_args, ctx) => ({ canvas: await windows.canvasOf(windowOf(ctx)) }),
    'window.show': async ({ canvas }, ctx) => {
      const id = canvas as string as CanvasId;
      // A canvas the core keeps, else not-found.
      await states.read(id);
      await lifecycle.show(windowOf(ctx), id);
      return {};
    },
  };
}

/** The window a GUI operation came from; main's native UI has no window of its own. */
export function windowOf({ caller }: OpContext): WindowId {
  if (caller.kind !== 'human' || caller.window === 'host') {
    throw new OpFailure('refused', 'This operation needs an app window.');
  }
  return caller.window;
}
