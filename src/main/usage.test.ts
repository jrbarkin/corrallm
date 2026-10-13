import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UsageState } from '../shared/usage';
import { UsageReadings } from './usage';

const START = Date.UTC(2026, 9, 12, 12, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let dir: string;
let file: string;
let now: number;
let readings: UsageReadings;
let heard: UsageState[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-usage-'));
  file = path.join(dir, 'usage.json');
  now = START;
  heard = [];
  readings = await open();
});
afterEach(async () => {
  await readings.flush();
  await rm(dir, { recursive: true, force: true });
});

async function open(): Promise<UsageReadings> {
  const store = new UsageReadings({ file, now: () => now, writeDelay: 0 });
  await store.load();
  store.subscribe((state) => heard.push(state));
  return store;
}

const fiveHour = (usedPercent: number, resetsAt: number | null = START + 2 * HOUR) => ({
  fiveHour: { usedPercent, resetsAt },
});

describe('UsageReadings', () => {
  it('keeps one reading per backend, with when it was read, and tells listeners', () => {
    readings.take('Claude', fiveHour(42));
    expect(readings.state().readings).toEqual([
      { backend: 'Claude', windows: fiveHour(42), at: START },
    ]);
    expect(heard).toHaveLength(1);

    now += MINUTE;
    readings.take('Claude', fiveHour(43));
    readings.take('Codex', { weekly: { usedPercent: 7, resetsAt: null } });
    expect(readings.state().readings).toEqual([
      { backend: 'Claude', windows: fiveHour(43), at: START + MINUTE },
      { backend: 'Codex', windows: { weekly: { usedPercent: 7, resetsAt: null } }, at: now },
    ]);
    expect(heard).toHaveLength(3);
  });

  it('keeps a window the newest reading leaves out', () => {
    readings.take('Claude', { ...fiveHour(10), weekly: { usedPercent: 30, resetsAt: null } });
    readings.take('Claude', fiveHour(12));
    expect(readings.state().readings[0]?.windows).toEqual({
      ...fiveHour(12),
      weekly: { usedPercent: 30, resetsAt: null },
    });
  });

  it('tells listeners of the same reading again only once a minute (to say how old it is)', () => {
    readings.take('Claude', fiveHour(42));
    now += 10_000;
    readings.take('Claude', fiveHour(42));
    expect(heard).toHaveLength(1);
    expect(readings.state().readings[0]?.at).toBe(START + 10_000);
    now += MINUTE;
    readings.take('Claude', fiveHour(42));
    expect(heard).toHaveLength(2);
  });

  it('simulates a reading, which a real one replaces, and forgets it', () => {
    readings.simulate('Claude', fiveHour(90));
    expect(readings.state().readings).toEqual([
      { backend: 'Claude', windows: fiveHour(90), at: START, simulated: true },
    ]);
    readings.take('Claude', fiveHour(20));
    expect(readings.state().readings).toEqual([
      { backend: 'Claude', windows: fiveHour(20), at: START },
    ]);
    readings.simulate('Claude', fiveHour(95));
    readings.simulate('Claude', null);
    expect(readings.state().readings).toEqual([]);
  });

  it('a real reading does not keep windows only a simulated one had', () => {
    readings.simulate('Claude', { weekly: { usedPercent: 99, resetsAt: null } });
    readings.take('Claude', fiveHour(20));
    expect(readings.state().readings[0]?.windows).toEqual(fiveHour(20));
  });

  it('keeps a rule per backend, and takes it off', () => {
    readings.setRule('Claude', { window: 'fiveHour', percent: 80, action: 'ask' });
    expect(readings.state().rules).toEqual({
      Claude: { window: 'fiveHour', percent: 80, action: 'ask' },
    });
    readings.setRule('Claude', null);
    expect(readings.state().rules).toEqual({});
    expect(heard).toHaveLength(2);
  });

  it('remembers readings and rules across restarts, with when they were read', async () => {
    readings.take('Claude', fiveHour(42));
    readings.setRule('Claude', { window: 'weekly', percent: 90, action: 'waitForReset' });
    await readings.flush();
    now += 3 * HOUR;
    const again = await open();
    expect(again.state()).toEqual({
      readings: [{ backend: 'Claude', windows: fiveHour(42), at: START }],
      rules: { Claude: { window: 'weekly', percent: 90, action: 'waitForReset' } },
    });
  });

  it('starts empty from a missing or broken file, and skips what is not right in it', async () => {
    await writeFile(file, 'not json');
    expect((await open()).state()).toEqual({ readings: [], rules: {} });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        readings: [
          { backend: 'Claude', windows: fiveHour(5), at: START },
          { backend: 'Gemini', windows: fiveHour(5), at: START },
          { backend: 'Codex', windows: fiveHour(500), at: START },
          { backend: 'Codex', windows: fiveHour(5), at: 'yesterday' },
        ],
        rules: { Claude: { window: 'weekly', percent: 0, action: 'ask' }, Codex: 'warn' },
      }),
    );
    expect((await open()).state()).toEqual({
      readings: [{ backend: 'Claude', windows: fiveHour(5), at: START }],
      rules: {},
    });
  });

  it('writes nothing but shares, times and rules', async () => {
    readings.take('Claude', fiveHour(42));
    await readings.flush();
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text)).toEqual({
      version: 1,
      readings: [{ backend: 'Claude', windows: fiveHour(42), at: START }],
      rules: {},
    });
  });
});
