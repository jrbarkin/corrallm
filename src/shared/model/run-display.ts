import type { AgentId } from '../api/ids';
import type { NodeLike } from './canvas';
import { groupMembers } from './queries';
import type { RunView, RunSnapshot } from './views';

/*
 * Where an agent's or a group's own controls (Pause, Kill, Resume) leave it in a run: the pause
 * causes the run holds (Run.individualPauses, Run.groupPauses), and whether a pause has taken full
 * effect yet or still lets an active task finish.
 */

/** An explicit individual cause is separate from the queue's combined pause state. */
export function individualPaused(run: RunSnapshot | RunView, agent: string): boolean {
  return 'groups' in run
    ? (run.agents[agent as AgentId]?.pauses?.length ?? 0) > 0
    : run.individualPauses?.some(({ id }) => id === agent) === true;
}

export function groupPaused(run: RunSnapshot | RunView, group: string): boolean {
  return 'groups' in run
    ? (run.groups[group]?.pauses.length ?? 0) > 0
    : run.groupPauses?.some(({ id }) => id === group) === true;
}

/** A group finishes its active member turns before its pause takes full effect. */
export function groupControlText(
  nodes: readonly NodeLike[],
  run: RunSnapshot,
  group: string,
): 'Pausing' | 'Paused' | undefined {
  if (!groupPaused(run, group)) return undefined;
  return groupMembers(nodes, group).some((agent) => queueControlText(run, agent) === 'Pausing')
    ? 'Pausing'
    : 'Paused';
}

/** A pause is requested immediately; an active task is allowed to finish first. */
export function queueControlText(
  run: RunSnapshot,
  agent: string,
): 'Pausing' | 'Paused' | undefined {
  const at = run.agents[agent];
  if (!at?.paused) return undefined;
  return at.status === 'running' &&
    at.current !== undefined &&
    at.outcomes[at.current] === undefined
    ? 'Pausing'
    : 'Paused';
}

/**
 * Where a run is with a task of an agent's (by id; null: the end of its queue), as views mark it:
 * running it, held at it (by the run, or for the user), stopped at it (or held there when the run
 * was stopped), how it went, or the end reached.
 */
export function taskState(
  run: RunSnapshot,
  agent: string,
  item: string | null,
): string | undefined {
  const at = run.agents[agent];
  if (!at) return undefined;
  if (item === null) return at.status === 'done' ? 'reached' : undefined;
  if (at.current === item && at.status !== 'done') return run.running ? at.status : 'stopped';
  return at.outcomes[item];
}

import type { CanvasNode } from './canvas';
import { findItem, isBlank } from './queue';
import { taskLabel } from './words';
import type { EngineCatalog } from './catalog';
import type { SessionSummary } from './views';

/** The most immediate work first: a live session, then its queue's state. Shared by dock and card. */
export function agentStatus(
  id: string,
  sessions: Readonly<Record<string, Pick<SessionSummary, 'status'>>>,
  run: RunSnapshot,
  needs: ReadonlySet<string>,
): string {
  if (needs.has(id)) return 'Needs you';
  const control = queueControlText(run, id);
  if (control) return control;
  const session = sessions[id]?.status;
  if (session === 'waiting') return 'Needs you';
  if (session === 'working') return 'Working';
  const queued = run.agents[id];
  if (!queued) return 'Idle';
  if (queued.status === 'done') return 'Done';
  if (queued.status === 'stopped') return 'Stopped';
  if (run.paused) return 'Paused';
  return {
    running: 'Working',
    waiting: 'Waiting',
    asking: 'Needs you',
    stopped: 'Stopped',
    done: 'Done',
  }[queued.status];
}
export interface AgentCard {
  status: string;
  line: string;
  completed: number;
  total: number;
}
/** Progress is finished authored top-level items, never a guessed percentage of a live turn. */
export function agentCard(
  id: string,
  nodes: readonly CanvasNode[],
  sessions: Readonly<Record<string, Pick<SessionSummary, 'status'>>>,
  run: RunSnapshot,
  needs: ReadonlySet<string>,
  catalog: EngineCatalog,
): AgentCard {
  const node = nodes.find((node) => node.id === id);
  const queue = node?.type === 'agent' ? (node.data.queue ?? []) : [];
  const items = queue.filter((item) => !isBlank(item));
  const at = run.agents[id];
  const current = at?.current === undefined ? undefined : findItem(queue, at.current)?.item;
  const status = agentStatus(id, sessions, run, needs);
  const detail =
    at?.problem?.text ??
    at?.refused?.text ??
    (current && at?.status !== 'done' ? taskLabel(nodes, current, catalog) : undefined);
  return {
    status,
    line: detail ? `${status} · ${detail}` : status,
    total: items.length,
    completed: items.filter((item) => at?.outcomes[item.id] !== undefined).length,
  };
}
