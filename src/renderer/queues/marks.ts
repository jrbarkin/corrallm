import type { RowMarks } from '../graph/QueueEditor';
import { isWait } from '../graph/queue';
import { taskState } from '../run/runner';
import type { Run } from '../run/runner';
import type { Lanes } from './lanes';

/** A task's key, by its agent's id and its own (null: the end of the agent's queue). */
export function taskKey(lane: string, item: string | null): string {
  return JSON.stringify([lane, item]);
}

/**
 * Every task's marks, by lane and id (null: the lane's end): `data-at` (where it is measured),
 * `data-mark` (a wait, stuck, or work handed on), `data-waited-for`, `data-active` (a link of what
 * the pointer is on ends there), and `data-run` (the run is on it, held at it, waits on the user
 * for it as its agent (in `asking`) asks permission, or how it went).
 */
export function queueMarks(
  { lanes, links, isStuck }: Lanes,
  run: Run,
  asking: ReadonlySet<string>,
  activeEnds: ReadonlySet<string> = new Set(),
): (lane: string, item: string | null) => RowMarks {
  const handed = new Set(
    links.flatMap((l) => (l.kind === 'handoff' ? [taskKey(l.from.lane, l.from.item)] : [])),
  );
  const waitedFor = new Set(
    links.flatMap((l) => (l.kind === 'wait' ? [taskKey(l.from.lane, l.from.item)] : [])),
  );
  const waits = new Set(
    lanes.flatMap((lane) =>
      lane.cells.flatMap(({ item }) => (isWait(item) ? [taskKey(lane.agent.id, item.id)] : [])),
    ),
  );
  return (lane, item) => {
    const key = taskKey(lane, item);
    const state = taskState(run, lane, item);
    const mark =
      item !== null && waits.has(key)
        ? isStuck(lane, item)
          ? 'stuck'
          : 'wait'
        : handed.has(key)
          ? 'handoff'
          : undefined;
    return {
      'data-at': key,
      'data-mark': mark,
      'data-waited-for': waitedFor.has(key) ? '' : undefined,
      'data-active': activeEnds.has(key) ? '' : undefined,
      'data-run': state === 'running' && asking.has(lane) ? 'asking' : state,
    };
  };
}
