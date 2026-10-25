import type { Reason } from './deviations';
import { Y } from './surface';
import type { Surface } from './surface';

/** B9a C7's kept-worktree removal awaits X12's registration with worktree.list. */

export const PREPARED_SURFACE = {
  // B9a C7: a kept tree removed, yours alone; one holding work asks you to confirm (`discard`'s
  // proposal envelope, for you).
  'worktree.remove': {
    access: Y,
    kind: 'command',
    scope: 'canvas',
    rules: ['discard'],
    destructive: true,
  },
} as const satisfies Record<string, Surface>;

export type PreparedName = keyof typeof PREPARED_SURFACE;

/** Their deviations: on the GUI alone, and why. */
export const PREPARED_DEVIATIONS = {
  'worktree.remove': 'trust-gate',
} as const satisfies Partial<Record<PreparedName, Reason>>;
