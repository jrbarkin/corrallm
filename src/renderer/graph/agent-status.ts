import type { CanvasNode } from '../../shared/model/canvas';
import type { Session } from '../../shared/model/session';
import { findItem, isBlank } from '../../shared/model/queue';
import { taskLabel } from '../../shared/model/words';
import type { EngineCatalog } from '../../shared/engine/catalog';
import type { Run } from '../../shared/engine/run/runner';
import { queueControlText } from '../../shared/engine/run/controls';

/** The most immediate work first: a live session, then its queue's state. Shared by dock and card. */
export function agentStatus(
  id: string,
  sessions: Readonly<Record<string, Session>>,
  run: Run,
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
  sessions: Readonly<Record<string, Session>>,
  run: Run,
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
