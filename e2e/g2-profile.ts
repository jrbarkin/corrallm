import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export interface CpuProfile {
  startTime: number;
  endTime: number;
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
}

export interface Activity {
  marks: number[];
  clockUncertaintyUs?: number;
  writerThreadsStarted?: number;
  dropped: number;
  events: { lane: string; op: string; start: number; end: number; pending?: boolean }[];
}

/** CI captures are separate for every test attempt/repeat; local capture remains opt-in. */
export function captureFile(env: NodeJS.ProcessEnv, automatic: string): string | undefined {
  if (env.CI) return automatic;
  const requested = env.CORRALLM_LOAD_CPU_PROFILE;
  return requested === '' ? undefined : requested;
}

interface FrameTime {
  frame: string;
  us: number;
}
interface Stretch {
  start: number;
  end: number;
  self: FrameTime[];
  inclusive: FrameTime[];
}

const ranked = (counts: Map<string, number>): FrameTime[] =>
  [...counts].map(([frame, us]) => ({ frame, us })).sort((a, b) => b.us - a.us);

/** Sampled non-idle intervals, clipped to G2's signal boundaries, in monotonic microseconds. */
export function busyStretches(profile: CpuProfile, from: number, to: number): Stretch[] {
  if (profile.samples.length !== profile.timeDeltas.length)
    throw new Error('CPU profile samples and deltas have different lengths');
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map(
    profile.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id] as const)),
  );
  const frames = (id: number): string[] => {
    const stack: string[] = [];
    const seen = new Set<number>();
    for (let at: number | undefined = id; at !== undefined && !seen.has(at); at = parents.get(at)) {
      seen.add(at);
      const node = nodes.get(at);
      if (!node) break;
      const frame = node.callFrame;
      const file = frame.url.split('/').at(-1) ?? '';
      stack.push(`${frame.functionName || '(anonymous)'} ${file}:${String(frame.lineNumber + 1)}`);
    }
    return stack;
  };
  const runs: Stretch[] = [];
  let current:
    | { start: number; end: number; self: Map<string, number>; inclusive: Map<string, number> }
    | undefined;
  const finish = () => {
    if (current && current.end - current.start > 50000)
      runs.push({
        start: current.start,
        end: current.end,
        self: ranked(current.self),
        inclusive: ranked(current.inclusive),
      });
    current = undefined;
  };
  let time = profile.startTime;
  for (const [index, id] of profile.samples.entries()) {
    const next = time + (profile.timeDeltas[index] ?? 0);
    const start = Math.max(time, from);
    const end = Math.min(next, to);
    const name = nodes.get(id)?.callFrame.functionName;
    if (end > start && name !== '(idle)') {
      current ??= { start, end, self: new Map(), inclusive: new Map() };
      current.end = end;
      const stack = frames(id);
      const leaf = stack[0] ?? `(unknown node ${String(id)})`;
      const us = end - start;
      current.self.set(leaf, (current.self.get(leaf) ?? 0) + us);
      for (const frame of new Set(stack))
        current.inclusive.set(frame, (current.inclusive.get(frame) ?? 0) + us);
    } else finish();
    time = next;
  }
  finish();
  return runs.sort((a, b) => b.end - b.start - (a.end - a.start));
}

export function formatEvidence(label: string, profile: CpuProfile, activity: Activity): string {
  const from = activity.marks[0];
  const to = activity.marks.at(-1);
  if (from === undefined || to === undefined || activity.marks.length !== 4)
    throw new Error('G2 diagnosis requires four signal boundaries');
  const uncertainty = activity.clockUncertaintyUs ?? 0;
  if (from < profile.startTime - uncertainty - 10000 || to > profile.endTime + uncertainty + 10000)
    throw new Error('G2 signal boundaries and CPU profile use different clocks');
  const ms = (us: number) => (us / 1000).toFixed(2);
  const lines = [
    `G2-DIAG ${label}: window ${ms(to - from)} ms; ${String(activity.events.length)} activity events, ${String(activity.dropped)} dropped`,
    `G2-DIAG worker clock alignment uncertainty ±${ms(uncertainty)} ms`,
    'G2-DIAG times are elapsed sample weights, not proof of CPU usage; a descheduled process or syscall can enlarge a sample.',
    'G2-DIAG worker execution is timed inside its handler; wait/fsync durations include main-loop callback scheduling.',
    `G2-ACTIVITY writer: ${activity.writerThreadsStarted === undefined ? 'unknown (capture has no mode metadata)' : activity.writerThreadsStarted === 0 ? 'not observed (production requires a writer thread)' : `on (${String(activity.writerThreadsStarted)} thread started; the only production executor)`}`,
  ];
  const overlaps = (start: number, end: number) =>
    activity.events.filter((event) => event.start < end && event.end > start);
  const runs = busyStretches(profile, from, to);
  lines.push(`G2-BUSY ${String(runs.length)} non-idle stretches over 50 ms (longest first)`);
  for (const [index, run] of runs.entries()) {
    const phase =
      run.start < (activity.marks[1] ?? to)
        ? 'before docs'
        : run.start < (activity.marks[2] ?? to)
          ? 'during docs'
          : 'after docs';
    lines.push(
      `G2-BUSY #${String(index + 1)} +${ms(run.start - from)}..${ms(run.end - from)} ms (${ms(run.end - run.start)} ms, ${phase})`,
    );
    lines.push(
      `G2-SELF #${String(index + 1)} ${run.self
        .slice(0, 7)
        .map(({ frame, us }) => `${frame} ${ms(us)} ms`)
        .join('; ')}`,
    );
    lines.push(
      `G2-INCLUSIVE #${String(index + 1)} ${run.inclusive
        .filter(({ frame }) => !frame.startsWith('(root)'))
        .slice(0, 10)
        .map(({ frame, us }) => `${frame} ${ms(us)} ms`)
        .join('; ')}`,
    );
    const events = overlaps(run.start, run.end);
    const grouped = new Map<string, { count: number; us: number; max: number }>();
    for (const event of events) {
      const key = `${event.lane} ${event.op}${event.pending ? ' (pending)' : ''}`;
      const kept = grouped.get(key) ?? { count: 0, us: 0, max: 0 };
      kept.count++;
      kept.us += Math.min(run.end, event.end) - Math.max(run.start, event.start);
      kept.max = Math.max(kept.max, event.end - event.start);
      grouped.set(key, kept);
    }
    if (grouped.size === 0)
      lines.push(`G2-OVERLAP #${String(index + 1)} no writer/checkpoint/fsync operation overlaps`);
    for (const [key, count] of [...grouped].sort((a, b) => b[1].us - a[1].us).slice(0, 15))
      lines.push(
        `G2-OVERLAP #${String(index + 1)} ${key}: ${String(count.count)} calls, overlap ${ms(count.us)} ms, longest whole call ${ms(count.max)} ms`,
      );
  }
  // A large sample gap can be the only evidence of scheduler starvation, including while idle.
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  let time = profile.startTime;
  const gaps: string[] = [];
  for (const [index, id] of profile.samples.entries()) {
    const dt = profile.timeDeltas[index] ?? 0;
    if (dt > 50000 && time < to && time + dt > from)
      gaps.push(
        `G2-GAP sample gap ${ms(dt)} ms at +${ms(time - from)} ms; leaf ${names.get(id) ?? 'unknown'}`,
      );
    time += dt;
  }
  lines.push(`G2-GAP ${String(gaps.length)} sample gaps over 50 ms`, ...gaps);
  const inWindow = overlaps(from, to);
  for (const lane of [...new Set(inWindow.map((event) => event.lane))]) {
    const events = inWindow
      .filter((event) => event.lane === lane)
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    lines.push(
      `G2-ACTIVITY ${lane}: ${String(events.length)} calls; longest: ${events
        .slice(0, 5)
        .map(
          (event) =>
            `${event.op} ${ms(event.end - event.start)} ms at +${ms(event.start - from)} ms`,
        )
        .join('; ')}`,
    );
  }
  return lines.join('\n');
}

export async function printEvidence(file: string, label: string): Promise<void> {
  const profile = JSON.parse(await readFile(file, 'utf8')) as CpuProfile;
  const activity = JSON.parse(await readFile(`${file}.activity.json`, 'utf8')) as Activity;
  console.log(formatEvidence(label, profile, activity));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of process.argv.slice(2)) await printEvidence(file, file);
}
