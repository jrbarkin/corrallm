import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** The app itself (Core Server §4 A). */
export const appOps = {
  'app.info': define('app.info', {
    summary: 'Says which corrallm this is: its name and its version.',
    input: z.strictObject({}),
    output: z.strictObject({ name: z.string(), version: z.string() }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
