import { z } from 'zod';

import { MAX_LINK_LENGTH } from '../limits';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** Links clicked in a window (Core Server §4 L, D2). */
const Link = z.strictObject({ url: z.string().max(MAX_LINK_LENGTH) });

export const linkOps = {
  'link.open': define('link.open', {
    summary:
      'Opens a clicked web link in the browser, asking first unless its site is allowed. Returns whether it opened.',
    input: Link,
    output: z.strictObject({ opened: z.boolean() }),
  }),
  'link.reveal': define('link.reveal', {
    summary:
      'Shows a clicked file link in the file manager, only within this window’s project folder, with symlinks resolved. Returns whether it was shown.',
    input: Link,
    output: z.strictObject({ revealed: z.boolean() }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
