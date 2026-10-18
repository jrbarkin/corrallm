/*
 * What the host does when the core process exits, as a pure policy: a crash restarts it, at most
 * RESTARTS times within WINDOW_MS, after which the host gives up and says so in a native dialog
 * ("corrallm's core keeps stopping"). A clean exit (code 0: the core was asked to stop) is no
 * crash: nothing to restart, and it does not count.
 */

/** How many restarts the host makes within WINDOW_MS before it gives up. */
export const RESTARTS = 3;
export const WINDOW_MS = 60_000;

/** What the policy remembers between exits: when it restarted the core, within the window. */
export interface Supervision {
  restarts: readonly number[];
}

export type SupervisionAction = 'none' | 'restart' | 'give-up';

/** Decides what to do about the core exiting with `code` at `now` (ms), and what to remember. */
export function supervise(
  state: Supervision,
  code: number,
  now: number,
): { action: SupervisionAction; next: Supervision } {
  if (code === 0) return { action: 'none', next: state };
  const recent = state.restarts.filter((at) => now - at < WINDOW_MS);
  if (recent.length >= RESTARTS) return { action: 'give-up', next: { restarts: recent } };
  return { action: 'restart', next: { restarts: [...recent, now] } };
}
