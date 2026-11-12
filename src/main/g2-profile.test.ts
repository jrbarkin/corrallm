import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { busyStretches, captureFile, formatEvidence } from '../../e2e/g2-profile.ts';
import type { Activity, CpuProfile } from '../../e2e/g2-profile.ts';

// A sanitized interval from the task-207 Linux capture, with its real sample deltas and stacks.
const saved = JSON.parse(
  await readFile(new URL('./fixtures/g2-busy.cpuprofile.json', import.meta.url), 'utf8'),
) as CpuProfile;

it('captures every CI run in its own output folder and keeps local capture opt-in', () => {
  expect(captureFile({ CI: '1' }, '/result/core.cpuprofile')).toBe('/result/core.cpuprofile');
  expect(
    captureFile({ CI: '1', CORRALLM_LOAD_CPU_PROFILE: '/shared' }, '/repeat-2/core.cpuprofile'),
  ).toBe('/repeat-2/core.cpuprofile');
  expect(captureFile({}, '/result/core.cpuprofile')).toBeUndefined();
  expect(captureFile({ CORRALLM_LOAD_CPU_PROFILE: '' }, '/result/core.cpuprofile')).toBeUndefined();
  expect(
    captureFile({ CORRALLM_LOAD_CPU_PROFILE: '/private/cpu' }, '/result/core.cpuprofile'),
  ).toBe('/private/cpu');
});

it('reports the required production writer and distinguishes missing or legacy observations', () => {
  const activity = {
    marks: [saved.startTime, saved.startTime + 1, saved.startTime + 2, saved.endTime],
    dropped: 0,
    events: [],
  };
  expect(formatEvidence('missing', saved, { ...activity, writerThreadsStarted: 0 })).toContain(
    'G2-ACTIVITY writer: not observed (production requires a writer thread)',
  );
  expect(formatEvidence('thread', saved, { ...activity, writerThreadsStarted: 1 })).toContain(
    'G2-ACTIVITY writer: on (1 thread started; the only production executor)',
  );
  expect(formatEvidence('legacy', saved, activity)).toContain(
    'G2-ACTIVITY writer: unknown (capture has no mode metadata)',
  );
  expect(formatEvidence('missing', saved, { ...activity, writerThreadsStarted: 0 })).toMatch(
    /G2-GAP \d+ sample gaps over 50 ms/,
  );
});

it('reports a saved busy stretch with the self time and its calling frames', () => {
  const runs = busyStretches(saved, saved.startTime, saved.endTime);
  expect(runs).toHaveLength(1);
  const [run] = runs;
  if (!run) throw new Error('Saved profile has no busy stretch');
  expect((run.end - run.start) / 1000).toBeCloseTo(374.464, 3);
  expect(run.self[0]?.frame).toContain('forget');
  expect(run.inclusive.some(({ frame }) => frame.includes('#pump'))).toBe(true);
  expect(run.self.reduce((sum, frame) => sum + frame.us, 0)).toBe(374464);
});

it('clips to the measured window and reports overlapping worker work and large sample gaps', () => {
  const activity: Activity = {
    marks: [
      saved.startTime + 10000,
      saved.startTime + 100000,
      saved.startTime + 300000,
      saved.endTime - 10000,
    ],
    dropped: 0,
    events: [
      { lane: 'writer', op: 'savepoint INSERT message', start: 1050000, end: 1140000 },
      { lane: 'fsync', op: 'flush', start: 1060000, end: 1200000 },
      { lane: 'checkpointer', op: 'checkpoint', start: 1, end: 100 },
    ],
  };
  const text = formatEvidence('repeat-2', saved, activity);
  expect(text).toContain('G2-DIAG repeat-2');
  expect(text).toContain('writer savepoint INSERT message');
  expect(text).toContain('fsync flush');
  expect(text).not.toContain('checkpointer checkpoint');
  expect(text).toContain('sample gap');
  const extracted = text
    .split('\n')
    .filter((line) => line.startsWith('G2-'))
    .join('\n');
  expect(extracted).toContain('G2-SELF #1');
  expect(extracted).toContain('G2-INCLUSIVE #1');
  expect(extracted).toContain('G2-OVERLAP #1 writer savepoint INSERT message');
  expect(busyStretches(saved, saved.endTime, saved.endTime + 100000)).toEqual([]);
});
