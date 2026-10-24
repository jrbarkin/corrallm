import type { CanvasId } from '../../../shared/canvas';
import { MAX_FILE_MATCHES } from '../../../shared/session';
import type { Implementations, OpServices } from '.';

/** The chosen project folder only: reading its files never opens or journals a canvas's run. */
export function projectOps({
  directories,
  files,
}: OpServices): Pick<Implementations, 'project.files'> {
  return {
    'project.files': async ({ canvas, query }) => {
      // This canvas-wide picker names no agent, so it searches the picked project root.
      const folder =
        canvas === undefined ? undefined : directories.projectRoot(canvas as unknown as CanvasId);
      return {
        items: folder === undefined ? [] : await files.find(folder, query, MAX_FILE_MATCHES),
      };
    },
  };
}
