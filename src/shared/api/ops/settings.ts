import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** The app's settings (Core Server §4 A). */
export const settingsOps = {
  'settings.get': define('settings.get', {
    summary:
      'The default adapter and the consents the user has given for good, by adapter and key.',
    input: z.strictObject({}),
    output: z.strictObject({
      defaultAdapter: z.string().regex(ID_PATTERN),
      consents: z.record(
        z.string().regex(ID_PATTERN),
        z.record(z.string().regex(ID_PATTERN), z.literal(true)),
      ),
    }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
