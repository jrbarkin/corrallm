import type { GraphNode } from '../graph/graph';
import { groupMembers } from '../graph/group-members';
import type { Run } from './runner';

/** An explicit individual cause is separate from the queue's combined pause state. */
export function individualPaused(run: Run, agent: string): boolean {
  return run.individualPauses?.includes(agent) === true;
}

export function groupPaused(run: Run, group: string): boolean {
  return run.groupPauses?.includes(group) === true;
}

/** A group finishes its active member turns before its pause takes full effect. */
export function groupControlText(
  nodes: readonly GraphNode[],
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
