import { z } from 'zod';

import { MAX_FILE_MATCHES, MAX_FILE_QUERY_LENGTH } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import { OpCanvas } from '../ids';
import type { OpName } from '../surface';

/** Project files (Core Server §4 B, §7.3), relative to the canvas's chosen folder. */
export const projectOps = {
  'project.files': define('project.files', {
    summary:
      'Files and folders in the canvas’s project folder that best match query, at most 50. ' +
      'Paths are relative to that folder; folders end in a slash. Without a project folder, ' +
      'returns an empty list. Ignores files git ignores, or dependency and build folders outside git.',
    input: z.strictObject({ canvas: OpCanvas, query: z.string().max(MAX_FILE_QUERY_LENGTH) }),
    output: z.strictObject({ items: z.array(z.string()).max(MAX_FILE_MATCHES) }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
