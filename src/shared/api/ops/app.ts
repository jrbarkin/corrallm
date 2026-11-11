import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** A path as Settings shows it: `~/…` under your home, else absolute. Text, never a link. */
const ShownPath = z.string().min(1).max(1024);
const Sentence = z.string().min(1).max(1000);

/**
 * The `corrallm` command (B30 C2). Yours alone.
 *
 * `unavailable`: no command to link from this build (unpackaged or an e2e build, Windows, or an app
 * macOS runs from a translocated copy). `ready`: where Install links it (`link.at`), what is there
 * now, and whether its folder is on your shell's PATH. `stale` is corrallm's own link, to a moved or
 * other copy; `taken` is anything else (a file, a folder, another program's link), which corrallm
 * leaves alone. `runs` is what `corrallm` runs in your shell now (the first on its PATH), and
 * whether that is this app's command; null: none.
 */
export const CommandStatus = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unavailable'), sentence: Sentence }),
  z.strictObject({
    state: z.literal('ready'),
    link: z.strictObject({
      at: ShownPath,
      is: z.enum(['absent', 'current', 'stale', 'taken']),
      onPath: z.boolean(),
    }),
    runs: z.strictObject({ at: ShownPath, current: z.boolean() }).nullable(),
  }),
]);
export type CommandStatus = z.infer<typeof CommandStatus>;

/** The app itself (Core Server §4 A). */
export const appOps = {
  'app.info': define('app.info', {
    summary: 'Says which corrallm this is: its name and its version.',
    input: z.strictObject({}),
    output: z.strictObject({ name: z.string(), version: z.string() }),
  }),
  'app.command': define('app.command', {
    summary:
      'Links the corrallm command onto your PATH, or removes the link corrallm made there. Yours alone.',
    input: z.strictObject({ action: z.enum(['install', 'remove']) }),
    output: z.strictObject({ changed: z.boolean(), command: CommandStatus }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
