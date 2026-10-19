import type { Answer, CoreLink } from '../../../shared/link';
import { mintTrustedPath } from '../host';
import type { HostServices, TrustedPath } from '../host';
import type { CoreSide, HostSide } from '../protocol';

/*
 * The core's host in the app (Core Server §7.2), as node.ts is under plain Node: main, asked over
 * the core process's link whatever needs the desktop, which it answers with its own dialogs
 * (host/services.ts), each parented to the window named. A path a dialog picked crosses as a plain
 * string, and is branded here, on the core's side of the port: one of TrustedPath's mint sites.
 */

export function appHost(link: Pick<CoreLink<CoreSide, HostSide>, 'request'>): HostServices {
  return {
    pickCanvasToOpen: (window) => picked(link.request('pickCanvasToOpen', window)),
    pickCanvasToSave: (window, defaultPath) =>
      picked(link.request('pickCanvasToSave', window, defaultPath)),
    pickFolder: (window, current) =>
      picked(
        current === undefined
          ? link.request('pickFolder', window)
          : link.request('pickFolder', window, current),
      ),
  };
}

/** What the user picked in main's dialog, or null if they cancelled; rejects if it failed. */
async function picked(asked: Promise<Answer<string | null>>): Promise<TrustedPath | null> {
  const answer = await asked;
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value === null ? null : mintTrustedPath(answer.value);
}
