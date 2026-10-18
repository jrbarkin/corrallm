import type { GraphNode } from '../graph/graph';
import {
  isApproval,
  isDelay,
  isIf,
  isRepeat,
  isRepeatEnds,
  isWait,
  withRepeated,
} from '../graph/queue';
import type { QueueItem, RepeatedItem, WaitTarget } from '../graph/queue';

/**
 * An item of a lane, in its row, taking `span` rows: one, but for a repeat, from its own row to
 * that of the last item it holds (`inner`, each in its row).
 */
export interface Cell {
  item: QueueItem;
  row: number;
  span: number;
  inner?: { item: RepeatedItem; row: number }[];
}

/** An agent's queue, as a lane: its items in their rows, and the row its end marker is in. */
export interface Lane {
  agent: GraphNode;
  cells: Cell[];
  end: number;
}

/**
 * One end of a link: an item in an agent's lane (or a step of an if-then, or an item in a repeat),
 * or (null) its end.
 */
export interface LinkEnd {
  lane: string;
  item: string | null;
}

/**
 * A wait, from what it waits for (`timed`: the wait has a time limit, so it may go on without it);
 * or a step one agent hands another, to that agent's lane.
 */
export type Link =
  | {
      key: string;
      kind: 'wait';
      from: LinkEnd;
      to: { lane: string; item: string };
      timed: boolean;
    }
  | { key: string; kind: 'handoff'; from: LinkEnd; to: string };

export interface Lanes {
  lanes: Lane[];
  /** How many rows the lanes take, their ends included. */
  rows: number;
  /** The waits and work handed over between lanes. */
  links: Link[];
  /**
   * Whether an item is in a loop of waits (waits waiting on each other, or repeats going round with
   * each other) with no way out: it would never run, or never end. A loop that holds a wait with a
   * time limit is not stuck: the limit breaks it.
   */
  isStuck: (agent: string, item: string) => boolean;
}

/** What an item must come after: another (by key), and whether that is what it waits for. */
interface Dependency {
  key: string;
  wait: boolean;
  /** Rows between them: 1, or 0 for a repeat's end, in the row of the last item it holds. */
  gap: number;
}

/**
 * Every agent's queue as a lane, side by side, in rows aligned so that order reads downwards: an
 * item comes after the one before it in its lane, and a wait after what it waits for (a step, or
 * the end of an agent's lane for all of its work). A repeat takes the rows of what it holds, in
 * order below its own; the item after it comes after the last of them. A wait for a step in a
 * repeat comes after that step if the wait is in a repeat too (it waits for it round by round),
 * and after the whole repeat if not. A repeat that goes round with another ends after it. Waits in
 * a loop of waits are laid out as if they did not wait; the loop is stuck unless a time limit
 * breaks it.
 */
export function lanesOf(nodes: readonly GraphNode[]): Lanes {
  const agents = nodes.filter((n) => n.type === 'agent');
  const byId = new Map(agents.map((a) => [a.id, a]));
  const key = (agent: string, item: string | null) => JSON.stringify([agent, item]);
  /** Where a repeat ends: after the last item it holds. */
  const endOf = (agent: string, repeat: string) => JSON.stringify([agent, repeat, 'end']);

  /** The key of what a wait (in a repeat, or not) waits for, if it is there to wait for. */
  const waited = ({ agent, item }: WaitTarget, inRepeat: boolean): string | undefined => {
    const queue = byId.get(agent)?.data.queue;
    if (!queue) return undefined;
    if (item === undefined) return key(agent, null);
    for (const q of queue) {
      if (q.id === item) return isRepeat(q) ? endOf(agent, q.id) : key(agent, item);
      if (isRepeat(q) && q.repeat.some((inner) => inner.id === item))
        return inRepeat ? key(agent, item) : endOf(agent, q.id);
    }
    return undefined;
  };
  const waitsOf = (item: QueueItem, inRepeat: boolean): Dependency[] =>
    isWait(item)
      ? item.waitFor.flatMap((target) => {
          const at = waited(target, inRepeat);
          return at === undefined ? [] : [{ key: at, wait: true, gap: 1 }];
        })
      : [];

  // What each item, each repeat's end, and each lane's end (item null), must come after.
  const after = new Map<string, Dependency[]>();
  for (const agent of agents) {
    let previous: string | undefined;
    const behind = (at: string | undefined, gap = 1): Dependency[] =>
      at === undefined ? [] : [{ key: at, wait: false, gap }];
    for (const item of agent.data.queue ?? []) {
      const at = key(agent.id, item.id);
      after.set(at, [...behind(previous), ...waitsOf(item, false)]);
      previous = at;
      if (!isRepeat(item)) continue;
      for (const inner of item.repeat) {
        const next = key(agent.id, inner.id);
        after.set(next, [...behind(previous), ...waitsOf(inner, true)]);
        previous = next;
      }
      // It ends with the last item it holds, and a repeat that follows another, after that one.
      const end = endOf(agent.id, item.id);
      const { until } = item;
      const leader =
        isRepeatEnds(until) && byId.get(until.agent)?.data.queue?.some((q) => q.id === until.item)
          ? [{ key: endOf(until.agent, until.item), wait: true, gap: 1 }]
          : [];
      after.set(end, [...behind(previous, 0), ...leader]);
      previous = end;
    }
    after.set(key(agent.id, null), behind(previous));
  }

  const loops = inLoops(after);
  const looped = new Set(loops.flat());
  const timed = new Set(
    agents.flatMap((agent) =>
      withRepeated(agent.data.queue ?? []).flatMap((item) =>
        isWait(item) && item.timeout !== undefined ? [key(agent.id, item.id)] : [],
      ),
    ),
  );
  const stuck = new Set(loops.filter((loop) => !loop.some((at) => timed.has(at))).flat());
  const rows = new Map<string, number>();
  const rowOf = (at: string): number => {
    const known = rows.get(at);
    if (known !== undefined) return known;
    rows.set(at, 0); // Guards against loops the stuck waits did not break.
    const row = Math.max(
      0,
      ...(after.get(at) ?? [])
        .filter((dep) => !(dep.wait && looped.has(at)))
        .map((dep) => rowOf(dep.key) + dep.gap),
    );
    rows.set(at, row);
    return row;
  };

  const lanes = agents.map((agent): Lane => {
    const queue = agent.data.queue ?? [];
    return {
      agent,
      cells: queue.map((item): Cell => {
        const row = rowOf(key(agent.id, item.id));
        if (!isRepeat(item)) return { item, row, span: 1 };
        return {
          item,
          row,
          span: rowOf(endOf(agent.id, item.id)) - row + 1,
          inner: item.repeat.map((inner) => ({ item: inner, row: rowOf(key(agent.id, inner.id)) })),
        };
      }),
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
    for (const item of withRepeated(agent.data.queue ?? [])) {
      const handed =
        isWait(item) || isDelay(item) || isApproval(item) || isRepeat(item)
          ? []
          : isIf(item)
            ? item.then
            : [item];
      for (const step of handed) {
        if (step.target === undefined || step.target === agent.id || !byId.has(step.target))
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
        if (target.agent === agent.id || !byId.has(target.agent)) continue;
        link({
          key: `${agent.id}:${item.id}>${target.agent}${target.item === undefined ? '' : `:${target.item}`}`,
          kind: 'wait',
          from: { lane: target.agent, item: target.item ?? null },
          to: { lane: agent.id, item: item.id },
          timed: item.timeout !== undefined,
        });
      }
    }
  }

  return {
    lanes,
    rows: Math.max(0, ...lanes.map((lane) => lane.end + 1)),
    links,
    isStuck: (agent, item) => stuck.has(key(agent, item)) || stuck.has(endOf(agent, item)),
  };
}

/** The loops of a dependency graph, each the nodes on it (Tarjan's strongly connected components). */
function inLoops(after: ReadonlyMap<string, readonly Dependency[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const loops: string[][] = [];
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
    if (component.length > 1 || selfLoop) loops.push(component);
  };
  for (const at of after.keys()) if (!index.has(at)) visit(at);
  return loops;
}
