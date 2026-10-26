import { isApproval, isMessage, isRepeat, isRepeatEnds, isWait } from './queue';
import type { QueueItem, QueueRepeat } from './queue';
import type { EngineCatalog } from './catalog';
import { taskState } from './run-display';
import type { RunSnapshot } from './views';
import { holdText } from './words';

export type RowMarks = Readonly<Record<`data-${string}`, string | undefined>>;
/** Only the data marks need; no renderer or layout implementation enters shared. */
export interface MarkLanes {
  lanes: readonly {
    agent: { id: string };
    cells: readonly { item: QueueItem; inner?: readonly { item: QueueItem }[] }[];
  }[];
  links: readonly { kind: 'wait' | 'handoff'; from: { lane: string; item: string | null } }[];
  isStuck: (agent: string, item: string) => boolean;
}

/** A task's key, by its agent's id and its own (null: the end of the agent's queue). */
export function taskKey(lane: string, item: string | null): string {
  return JSON.stringify([lane, item]);
}

/**
 * Every task's marks, by lane and id (null: the lane's end): `data-at` (where it is measured),
 * `data-mark` (a wait, stuck, work handed on, or an OK), `data-waited-for`, `data-active` (a link
 * of what the pointer is on ends there), `data-run` (the run is on it, held at it, waits on the
 * user for it as its agent (in `asking`) asks permission, or how it went), `data-expected` (a
 * step expected to fail, once judged: `met`, it failed, as expected; `unmet`, it passed),
 * `data-until` (while the run holds the agent at it, a delay or a wait with a time limit: when its
 * time comes, in epoch ms), `data-decide` (the run holds the agent there for the user to decide: its decision bar
 * shows; not for a session that would not start), at an OK, `data-asked` (the last changes asked for there, this run) with
 * `data-asked-times` (how many times, when more than once), and at a repeat, `data-round` (the
 * round it is on, "Round 2 of 3", while the run is in it; once over, how many it took, "2 rounds").
 * Where a usage rule holds the agent before a task: `data-usage` (why, the backend named by
 * `catalog`), `data-usage-backend` (whose usage) and `data-usage-reset` (when its window resets, in
 * epoch ms, if known).
 */
export function queueMarks(
  { lanes, links, isStuck }: MarkLanes,
  run: RunSnapshot,
  asking: ReadonlySet<string>,
  catalog: EngineCatalog,
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
  const submissions = new Map(
    lanes.flatMap((lane) =>
      lane.cells.flatMap(({ item }) =>
        isMessage(item) && item.submission
          ? [[taskKey(lane.agent.id, item.id), item.submission] as const]
          : [],
      ),
    ),
  );
  const repeats = new Map(
    lanes.flatMap((lane) =>
      lane.cells.flatMap(({ item }) =>
        isRepeat(item) ? [[taskKey(lane.agent.id, item.id), item] as const] : [],
      ),
    ),
  );
  return (lane, item) => {
    const key = taskKey(lane, item);
    const submission = submissions.get(key);
    if (submission) return { 'data-at': key, 'data-run': submission.status };
    const state = taskState(run, lane, item);
    const repeat = repeats.get(key);
    const mark =
      item !== null && (waits.has(key) || repeat) && isStuck(lane, item)
        ? 'stuck'
        : waits.has(key)
          ? 'wait'
          : oks.has(key)
            ? 'ok'
            : handed.has(key)
              ? 'handoff'
              : undefined;
    const at = run.agents[lane];
    const held = run.running && !at?.paused && at?.current === item;
    const problem = at?.current === item ? at.problem : undefined;
    const attempts = item === null ? undefined : at?.attempts?.[item];
    const until = held ? at.until : undefined;
    const asked = item === null ? undefined : at?.changes?.[item];
    const usage = held ? at.usage : undefined;
    const expected = item === null ? undefined : at?.asExpected?.[item];
    return {
      'data-at': key,
      'data-mark': mark,
      'data-waited-for': waitedFor.has(key) ? '' : undefined,
      'data-active': activeEnds.has(key) ? '' : undefined,
      // A permission prompt in the task asks the user too; but only the run's own hold decides.
      'data-run': state === 'running' && asking.has(lane) ? 'asking' : state,
      'data-expected': expected === undefined ? undefined : expected ? 'met' : 'unmet',
      'data-until': until === undefined ? undefined : String(until),
      // A session that would not start is decided where it says why (src/shared/model/run-words.ts), not on the row.
      'data-decide': held && at.status === 'asking' && !at.refused ? '' : undefined,
      'data-problem': problem?.kind,
      'data-problem-text': problem?.text,
      'data-problem-reason': problem?.reason,
      'data-problem-agent': problem?.agent,
      'data-problem-condition': problem?.conditionKey,
      'data-refused': at?.current === item && at.refused ? '' : undefined,
      'data-attempts': attempts?.length ? JSON.stringify(attempts) : undefined,
      'data-asked': asked?.at(-1),
      'data-asked-times': asked && asked.length > 1 ? String(asked.length) : undefined,
      'data-usage':
        usage &&
        `${holdText(usage, catalog)}${at?.status === 'waiting' ? ': waiting for it to reset' : ''}`,
      'data-usage-backend': usage?.backend,
      'data-usage-reset':
        usage?.resetsAt === null || usage === undefined ? undefined : String(usage.resetsAt),
      'data-round':
        repeat && roundText(repeat, run, lane, (agent, id) => repeats.get(taskKey(agent, id))),
    };
  };
}

/**
 * Where a run is with a repeat (in `lane`), as its pill reads: the round it is on, of how many it
 * runs at most (its rounds, and those the user added; for one that follows another, found by
 * `repeatOf`, that one's), while the run is in it; once over, how many it took.
 */
function roundText(
  repeat: QueueRepeat,
  run: RunSnapshot,
  lane: string,
  repeatOf: (agent: string, id: string) => QueueRepeat | undefined,
): string | undefined {
  const at = run.agents[lane];
  const state = at?.rounds?.[repeat.id];
  if (!at || !state) return undefined;
  const { round } = state;
  if (at.outcomes[repeat.id] !== undefined)
    return `${String(round)} round${round === 1 ? '' : 's'}`;
  const inside =
    at.status !== 'done' &&
    (at.current === repeat.id || repeat.repeat.some((item) => item.id === at.current));
  if (!inside) return undefined;
  const { until } = repeat;
  const [owner, counted] = isRepeatEnds(until)
    ? [until.agent, repeatOf(until.agent, until.item)]
    : [lane, repeat];
  if (!counted) return `Round ${String(round)}`;
  const more = run.agents[owner]?.rounds?.[counted.id]?.more ?? 0;
  return `Round ${String(round)} of ${String(counted.rounds + more)}`;
}
