import path from 'node:path';

import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { windowOf } from './window';
import type { Implementations, OpServices } from '.';

/** Terminal views and the user's input, bound to their window's canvas (Core Server §4 K). */
export function terminalOps({
  sessions,
  windows,
}: OpServices): Pick<
  Implementations,
  'terminal.attach' | 'terminal.detach' | 'terminal.input' | 'terminal.resize' | 'terminal.drop'
> {
  const canvas = (ctx: OpContext) => windows.canvasOf(windowOf(ctx));
  return {
    'terminal.attach': async ({ agent }, ctx) => {
      sessions.attachTerminal(await canvas(ctx), agent);
      return {};
    },
    'terminal.detach': async ({ agent }, ctx) => {
      sessions.detachTerminal(await canvas(ctx), agent);
      return {};
    },
    'terminal.input': async ({ agent, data }, ctx) => {
      await sessions.inputTerminal(await canvas(ctx), agent, data);
      return {};
    },
    'terminal.resize': async ({ agent, cols, rows }, ctx) => {
      await sessions.resizeTerminal(await canvas(ctx), agent, cols, rows);
      return {};
    },
    'terminal.drop': async ({ agent, paths }, ctx) => {
      for (const file of paths) {
        // eslint-disable-next-line no-control-regex
        if (!path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) {
          throw new OpFailure('invalid', 'Expected the path of a file dropped');
        }
      }
      await sessions.dropOnTerminal(await canvas(ctx), agent, paths);
      return {};
    },
  };
}
