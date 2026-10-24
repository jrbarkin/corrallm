import type { CanvasId } from '../../../shared/canvas';
import { MAX_FILE_MATCHES } from '../../../shared/session';
import { OpFailure } from '../call';
import { SetupError } from '../workspaces/setup';
import type { Implementations, OpServices } from '.';

/**
 * The chosen project folder only: reading its files never opens or journals a canvas's run. Its
 * repository's setup command is yours alone (D1, trust-gate: core.call refuses every token before
 * this runs), kept by the worktrees' setup service (workspaces/setup.ts).
 */
export function projectOps({
  directories,
  files,
  setups,
}: OpServices): Pick<Implementations, 'project.files' | 'project.setSetupCommand'> {
  return {
    'project.files': async ({ canvas, query }) => {
      // This canvas-wide picker names no agent, so it searches the picked project root.
      const folder =
        canvas === undefined ? undefined : directories.projectRoot(canvas as unknown as CanvasId);
      return {
        items: folder === undefined ? [] : await files.find(folder, query, MAX_FILE_MATCHES),
      };
    },
    'project.setSetupCommand': async ({ canvas, command }) => {
      if (canvas === undefined) throw new OpFailure('invalid', 'Name the canvas it is for.');
      if (setups === undefined) {
        throw new OpFailure(
          'unavailable',
          'Agents don’t get worktrees of their own in this build yet, so there is no setup to set.',
        );
      }
      try {
        return await setups.setCommand(canvas as unknown as CanvasId, command);
      } catch (error) {
        if (error instanceof SetupError) throw new OpFailure(error.code, error.message);
        throw error;
      }
    },
  };
}
