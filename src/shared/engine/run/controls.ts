import type { NodeLike } from '../../model/canvas';
import { groupMembers } from '../../model/queries';
import type { Run } from './runner';

/*
 * Where an agent's or a group's own controls (Pause, Kill, Resume) leave it in a run: the pause
 * causes the run holds (Run.individualPauses, Run.groupPauses), and whether a pause has taken full
 * effect yet or still lets an active task finish.
 */

/** An explicit individual cause is separate from the queue's combined pause state. */
export function individualPaused(run: Run, agent: string): boolean {
  return run.individualPauses?.some(({ id }) => id === agent) === true;
}

export function groupPaused(run: Run, group: string): boolean {
  return run.groupPauses?.some(({ id }) => id === group) === true;
}

/** A group finishes its active member turns before its pause takes full effect. */
export function groupControlText(
  nodes: readonly NodeLike[],
  run: Run,
  group: string,
): 'Pausing' | 'Paused' | undefined {
  if (!groupPaused(run, group)) return undefined;
  return groupMembers(nodes, group).some((agent) => queueControlText(run, agent) === 'Pausing')
    ? 'Pausing'
    : 'Paused';
}

/** A pause is requested immediately; an active task is allowed to finish first. */
export function queueControlText(run: Run, agent: string): 'Pausing' | 'Paused' | undefined {
  const at = run.agents[agent];
  if (!at?.paused) return undefined;
  return at.status === 'running' &&
    at.current !== undefined &&
    at.outcomes[at.current] === undefined
    ? 'Pausing'
    : 'Paused';
}
