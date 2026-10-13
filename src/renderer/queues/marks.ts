import type { RowMarks } from '../graph/QueueEditor';
import { isApproval, isRepeat, isWait } from '../graph/queue';
import type { QueueItem, QueueRepeat } from '../graph/queue';
import { taskState } from '../run/runner';
import type { Run } from '../run/runner';
import type { Lanes } from './lanes';

/** A task's key, by its agent's id and its own (null: the end of the agent's queue). */
export function taskKey(lane: string, item: string | null): string {
  return JSON.stringify([lane, item]);
}

/**
 * Every task's marks, by lane and id (null: the lane's end): `data-at` (where it is measured),
 * `data-mark` (a wait, stuck, work handed on, or an OK), `data-waited-for`, `data-active` (a link
 * of what the pointer is on ends there), `data-run` (the run is on it, held at it, waits on the
 * user for it as its agent (in `asking`) asks permission, or how it went), `data-until` (while the
 * run holds the agent at it, a delay or a wait with a time limit: when its time comes, in epoch
 * ms), `data-decide` (the run holds the agent there for the user to decide: its decision bar
 * shows), at an OK, `data-asked` (the last changes asked for there, this run) with
 * `data-asked-times` (how many times, when more than once), and at a repeat, `data-round` (the
 * round it is on, "Round 2 of 3", while the run is in it; once over, how many it took, "2 rounds").
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
  /** The tasks of a kind, by key: in lanes, and in their repeats. */
  const kinds = (is: (item: QueueItem) => boolean) =>
    new Set(
      lanes.flatMap((lane) =>
        lane.cells
          .flatMap(({ item, inner }) => [item, ...(inner ?? []).map((cell) => cell.item)])
          .flatMap((item) => (is(item) ? [taskKey(lane.agent.id, item.id)] : [])),
      ),
    );
  const waits = kinds(isWait);
  const oks = kinds(isApproval);
  const repeats = new Map(
    lanes.flatMap((lane) =>
      lane.cells.flatMap(({ item }) =>
        isRepeat(item) ? [[taskKey(lane.agent.id, item.id), item] as const] : [],
      ),
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
        : oks.has(key)
          ? 'ok'
          : handed.has(key)
            ? 'handoff'
            : undefined;
    const at = run.agents[lane];
    const held = run.running && at?.current === item;
    const until = held ? at.until : undefined;
    const asked = item === null ? undefined : at?.changes?.[item];
    const repeat = repeats.get(key);
    return {
      'data-at': key,
      'data-mark': mark,
      'data-waited-for': waitedFor.has(key) ? '' : undefined,
      'data-active': activeEnds.has(key) ? '' : undefined,
      // A permission prompt in the task asks the user too; but only the run's own hold decides.
      'data-run': state === 'running' && asking.has(lane) ? 'asking' : state,
      'data-until': until === undefined ? undefined : String(until),
      'data-decide': held && at.status === 'asking' ? '' : undefined,
      'data-asked': asked?.at(-1),
      'data-asked-times': asked && asked.length > 1 ? String(asked.length) : undefined,
      'data-round': repeat && roundText(repeat, run.agents[lane]),
    };
  };
}

/**
 * Where a run is with a repeat, as its pill reads: the round it is on, of how many it runs at most
 * (its rounds, and those the user added), while the run is in it; once over, how many it took.
 */
function roundText(repeat: QueueRepeat, at: Run['agents'][string] | undefined): string | undefined {
  const state = at?.rounds?.[repeat.id];
  if (!at || !state) return undefined;
  const { round, more = 0 } = state;
  if (at.outcomes[repeat.id] !== undefined)
    return `${String(round)} round${round === 1 ? '' : 's'}`;
  const inside =
    at.status !== 'done' &&
    (at.current === repeat.id || repeat.repeat.some((item) => item.id === at.current));
  return inside ? `Round ${String(round)} of ${String(repeat.rounds + more)}` : undefined;
}
