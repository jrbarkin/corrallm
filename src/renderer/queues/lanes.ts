import type { GraphNode } from '../graph/graph';
import { isIf, isWait } from '../graph/queue';
import type { QueueItem } from '../graph/queue';

/** An item of a lane, in its row. */
export interface Cell {
  item: QueueItem;
  row: number;
}

/** An agent's queue, as a lane: its items in their rows, and the row its end marker is in. */
export interface Lane {
  agent: GraphNode;
  cells: Cell[];
  end: number;
}

/** One end of a link: an item in an agent's lane (or a step of an if-then), or (null) its end. */
export interface LinkEnd {
  lane: string;
  item: string | null;
}

/** A wait, from what it waits for; or a step one agent hands another, to that agent's lane. */
export type Link =
  | { key: string; kind: 'wait'; from: LinkEnd; to: { lane: string; item: string } }
  | { key: string; kind: 'handoff'; from: LinkEnd; to: string };

export interface Lanes {
  lanes: Lane[];
  /** How many rows the lanes take, their ends included. */
  rows: number;
  /** The waits and work handed over between lanes. */
  links: Link[];
  /** Whether an item is in a loop of waits (waits waiting on each other): it would never run. */
  isStuck: (agent: string, item: string) => boolean;
}

/**
 * Every agent's queue as a lane, side by side, in rows aligned so that order reads downwards: an
 * item comes after the one before it in its lane, and a wait after what it waits for (a step, or
 * the end of an agent's lane for all of its work). Items in a loop of waits are stuck, the waits
 * laid out as if they did not wait.
 */
export function lanesOf(nodes: readonly GraphNode[]): Lanes {
  const agents = nodes.filter((n) => n.type === 'agent');
  const ids = new Set(agents.map((a) => a.id));
  const key = (agent: string, item: string | null) => JSON.stringify([agent, item]);

  // What each item, and each lane's end (item null), must come after.
  const after = new Map<string, { key: string; wait: boolean }[]>();
  for (const agent of agents) {
    const queue = agent.data.queue ?? [];
    let previous: string | undefined;
    for (const item of queue) {
      const deps = previous === undefined ? [] : [{ key: previous, wait: false }];
      if (isWait(item)) {
        for (const target of item.waitFor) {
          if (!ids.has(target.agent)) continue;
          const exists =
            target.item === undefined ||
            agents
              .find((a) => a.id === target.agent)
              ?.data.queue?.some((q) => q.id === target.item);
          if (exists) deps.push({ key: key(target.agent, target.item ?? null), wait: true });
        }
      }
      previous = key(agent.id, item.id);
      after.set(previous, deps);
    }
    after.set(key(agent.id, null), previous === undefined ? [] : [{ key: previous, wait: false }]);
  }

  const stuck = inLoops(after);
  const rows = new Map<string, number>();
  const rowOf = (at: string): number => {
    const known = rows.get(at);
    if (known !== undefined) return known;
    rows.set(at, 0); // Guards against loops the stuck waits did not break.
    const row = Math.max(
      0,
      ...(after.get(at) ?? [])
        .filter((dep) => !(dep.wait && stuck.has(at)))
        .map((dep) => rowOf(dep.key) + 1),
    );
    rows.set(at, row);
    return row;
  };

  const lanes = agents.map((agent): Lane => {
    const queue = agent.data.queue ?? [];
    return {
      agent,
      cells: queue.map((item) => ({ item, row: rowOf(key(agent.id, item.id)) })),
      end: rowOf(key(agent.id, null)),
    };
  });

  const links: Link[] = [];
  const seen = new Set<string>();
  const link = (next: Link) => {
    if (seen.has(next.key)) return;
    seen.add(next.key);
    links.push(next);
  };
  for (const agent of agents) {
    for (const item of agent.data.queue ?? []) {
      const handed = isWait(item) ? [] : isIf(item) ? item.then : [item];
      for (const step of handed) {
        if (step.target === undefined || step.target === agent.id || !ids.has(step.target))
          continue;
        link({
          key: `${agent.id}:${step.id}>${step.target}`,
          kind: 'handoff',
          from: { lane: agent.id, item: step.id },
          to: step.target,
        });
      }
      if (!isWait(item)) continue;
      for (const target of item.waitFor) {
        if (target.agent === agent.id || !ids.has(target.agent)) continue;
        link({
          key: `${agent.id}:${item.id}>${target.agent}${target.item === undefined ? '' : `:${target.item}`}`,
          kind: 'wait',
          from: { lane: target.agent, item: target.item ?? null },
          to: { lane: agent.id, item: item.id },
        });
      }
    }
  }

  return {
    lanes,
    rows: Math.max(0, ...lanes.map((lane) => lane.end + 1)),
    links,
    isStuck: (agent, item) => stuck.has(key(agent, item)),
  };
}

/** The nodes of a dependency graph that lie on a loop (Tarjan's strongly connected components). */
function inLoops(after: ReadonlyMap<string, readonly { key: string }[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const looped = new Set<string>();
  let next = 0;
  const visit = (at: string) => {
    index.set(at, next);
    low.set(at, next);
    next += 1;
    stack.push(at);
    onStack.add(at);
    for (const { key: dep } of after.get(at) ?? []) {
      if (!index.has(dep)) {
        visit(dep);
        low.set(at, Math.min(low.get(at) ?? 0, low.get(dep) ?? 0));
      } else if (onStack.has(dep)) {
        low.set(at, Math.min(low.get(at) ?? 0, index.get(dep) ?? 0));
      }
    }
    if (low.get(at) !== index.get(at)) return;
    const component: string[] = [];
    for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
      onStack.delete(top);
      component.push(top);
      if (top === at) break;
    }
    const selfLoop = (after.get(at) ?? []).some((dep) => dep.key === at);
    if (component.length > 1 || selfLoop) for (const member of component) looped.add(member);
  };
  for (const at of after.keys()) if (!index.has(at)) visit(at);
  return looped;
}
