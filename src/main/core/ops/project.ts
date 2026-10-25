import { nodeKey } from '../../../shared/model/rows';
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
  states,
  setups,
}: OpServices): Pick<
  Implementations,
  'project.files' | 'project.setSetupCommand' | 'project.clearSetupApproval'
> {
  /** The composed setup service; isolated operation fixtures may omit it. */
  const service = () => {
    if (setups === undefined) {
      throw new OpFailure('unavailable', 'The workspace setup service is unavailable.');
    }
    return setups;
  };
  const failure = (error: unknown): never => {
    if (error instanceof SetupError) throw new OpFailure(error.code, error.message);
    throw error;
  };
  return {
    'project.files': async ({ canvas, agent, query }) => {
      // This canvas-wide picker names no agent, so it searches the picked project root.
      let folder =
        canvas === undefined ? undefined : directories.projectRoot(canvas as unknown as CanvasId);
      if (canvas !== undefined && agent !== undefined) {
        const entity = (await states.read(canvas as unknown as CanvasId)).entities[nodeKey(agent)];
        if (entity === undefined || !('kind' in entity) || entity.kind !== 'agent')
          throw new OpFailure('not-found', `There is no agent ${agent}.`);
        const directory = await directories.workingDirectory(canvas as unknown as CanvasId, agent);
        folder = directory.state === 'ready' ? directory.cwd : undefined;
      }
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
