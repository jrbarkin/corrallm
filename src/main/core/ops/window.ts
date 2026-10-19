import { OpFailure } from '../call';
import type { OpContext } from '../call';
import type { WindowId } from '../host';
import type { Implementations, OpServices } from '.';

/** The canvas of the caller's window, never a window named by the page (Core Server §4 M). */
export function windowOps({ windows }: OpServices): Pick<Implementations, 'window.get'> {
  return {
    'window.get': async (_args, ctx) => ({ c: await windows.canvasOf(windowOf(ctx)) }),
  };
}

/** The window a GUI operation came from; main's native UI has no window of its own. */
export function windowOf({ caller }: OpContext): WindowId {
  if (caller.kind !== 'human' || caller.window === 'host') {
    throw new OpFailure('refused', 'This operation needs an app window.');
  }
  return caller.window;
}
