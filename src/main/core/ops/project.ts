import type { CanvasId } from '../../../shared/canvas';
import { MAX_FILE_MATCHES } from '../../../shared/session';
import { OpFailure } from '../call';
import { SetupError } from '../workspaces/setup';
import type { Implementations, OpServices } from '.';

/**
 * The chosen project folder only: reading its files never opens or journals a canvas's run. Its
 * repository's setup command (D1, trust-gate) and what runs always (D9, permissions) are yours
 * alone (core.call refuses every token before these run), kept by the worktrees' setup service
 * (workspaces/setup.ts).
 */
export function projectOps({
  directories,
  files,
  setups,
}: OpServices): Pick<
  Implementations,
  'project.files' | 'project.setSetupCommand' | 'project.clearSetupApproval'
> {
  /** The worktrees' setup service, or why there is none: worktrees aren't composed yet. */
  const service = () => {
    if (setups === undefined) {
      throw new OpFailure(
        'unavailable',
        'Agents don’t get worktrees of their own in this build yet, so there is no setup to set.',
      );
    }
    return setups;
  };
  const failure = (error: unknown): never => {
    if (error instanceof SetupError) throw new OpFailure(error.code, error.message);
    throw error;
  };
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
      return service()
        .setCommand(canvas as unknown as CanvasId, command)
        .catch(failure);
    },
    'project.clearSetupApproval': ({ canvas }) => {
      if (canvas === undefined) throw new OpFailure('invalid', 'Name the canvas it is for.');
      return service()
        .clearAlways(canvas as unknown as CanvasId)
        .catch(failure);
    },
  };
}
