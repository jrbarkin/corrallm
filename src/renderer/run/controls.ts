import type { Run } from './runner';

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
