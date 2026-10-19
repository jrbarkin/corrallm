import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageState } from '../shared/usage';
import { UsageReadings } from './usage';

/** Whether a file's permissions can keep its owner from reading it: not on Windows, nor as root. */
const CAN_DENY = process.platform !== 'win32' && process.getuid?.() !== 0;
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
  const store = new UsageReadings({
    file,
    backends: ['claude-code', 'codex'],
    now: () => now,
    writeDelay: 0,
  });
  await store.load();
  store.subscribe((state) => heard.push(state));
  return store;
}

/** What the one file set aside beside usage.json holds. */
async function setAside(): Promise<string> {
  const rejected = (await readdir(dir)).filter((name) => name !== 'usage.json');
  expect(rejected).toEqual([expect.stringMatching(/^usage\.rejected-.+\.json$/)]);
  return readFile(path.join(dir, String(rejected[0])), 'utf8');
}

const fiveHour = (usedPercent: number, resetsAt: number | null = START + 2 * HOUR) => ({
  fiveHour: { usedPercent, resetsAt },
});

describe('UsageReadings', () => {
  it('can exit immediately after an exhaustion notification without losing its hold', async () => {
    await writeFile(file, JSON.stringify({ version: 2, readings: [], rules: {} }));
    let atExit: unknown;
    readings.subscribe(() => {
      // The disk image at notification is all a restarted process would have after this exit.
      atExit = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    });
    await readings.exhaust('codex', START + HOUR);
    expect(atExit).toMatchObject({ exhausted: { codex: { resetsAt: START + HOUR } } });
    const restarted = await open();
    expect(restarted.exhausted('codex')).toBe(START + HOUR);
  });

  it('remembers a backend’s exhausted limit across restarts, independently of its rule', async () => {
    await readings.exhaust('codex', START + HOUR);
    expect(readings.exhausted('codex')).toBe(START + HOUR);
    expect(readings.exhausted('claude-code')).toBeUndefined();
    await readings.flush();
    const again = await open();
    expect(again.exhausted('codex')).toBe(START + HOUR);
    now += HOUR;
    expect(again.exhausted('codex')).toBeUndefined();
    expect(readings.state().rules).toEqual({});
  });

  it('releases on a fresh real reading below the exhausted window, even if the reading is unchanged', async () => {
    readings.take('codex', fiveHour(10));
    await readings.exhaust('codex', START + 2 * HOUR);
    heard.length = 0;
    readings.take('codex', fiveHour(10));
    expect(readings.exhausted('codex')).toBeUndefined();
    expect(heard).toHaveLength(1);
  });

  it('keeps a hard limit when a reading omits its window or still shows it exhausted', async () => {
    readings.take('codex', fiveHour(100));
    await readings.exhaust('codex', START + 2 * HOUR);
    readings.take('codex', { weekly: { usedPercent: 10, resetsAt: START + 7 * 24 * HOUR } });
    expect(readings.exhausted('codex')).toBe(START + 2 * HOUR);
    readings.take('codex', fiveHour(100));
    expect(readings.exhausted('codex')).toBe(START + 2 * HOUR);
    readings.simulate('codex', fiveHour(10));
    expect(readings.exhausted('codex')).toBeUndefined();
  });

  it('does not turn a missing reading or rule removal into room to spend', async () => {
    await readings.exhaust('codex', START + HOUR);
    readings.simulate('codex', null);
    readings.setRule('codex', null);
    expect(readings.exhausted('codex')).toBe(START + HOUR);
  });

  it('does not mistake another window’s partial reading for a reset, before the exhausted window is known', async () => {
    await readings.exhaust('codex', START + 2 * HOUR);
    readings.take('codex', { weekly: { usedPercent: 10, resetsAt: START + 7 * 24 * HOUR } });
    expect(readings.exhausted('codex')).toBe(START + 2 * HOUR);
    readings.take('codex', fiveHour(100));
    readings.take('codex', { weekly: { usedPercent: 5, resetsAt: START + 7 * 24 * HOUR } });
    expect(readings.exhausted('codex')).toBe(START + 2 * HOUR);
    readings.take('codex', fiveHour(1));
    expect(readings.exhausted('codex')).toBeUndefined();
  });

  it('ignores an unknown backend, an invalid reset and a reset already past', async () => {
    for (const reset of [START, START - 1, NaN, Infinity]) await readings.exhaust('codex', reset);
    await readings.exhaust('unknown', START + HOUR);
    expect(readings.exhausted('codex')).toBeUndefined();
    expect(readings.exhausted('unknown')).toBeUndefined();
  });

  it('keeps one reading per backend, with when it was read, and tells listeners', () => {
    readings.take('claude-code', fiveHour(42));
    expect(readings.state().readings).toEqual([
      { backend: 'claude-code', windows: fiveHour(42), at: START },
    ]);
    expect(heard).toHaveLength(1);

    now += MINUTE;
    readings.take('claude-code', fiveHour(43));
    readings.take('codex', { weekly: { usedPercent: 7, resetsAt: null } });
    expect(readings.state().readings).toEqual([
      { backend: 'claude-code', windows: fiveHour(43), at: START + MINUTE },
      { backend: 'codex', windows: { weekly: { usedPercent: 7, resetsAt: null } }, at: now },
    ]);
    expect(heard).toHaveLength(3);
  });

  it('keeps a window the newest reading leaves out', () => {
    readings.take('claude-code', { ...fiveHour(10), weekly: { usedPercent: 30, resetsAt: null } });
    readings.take('claude-code', fiveHour(12));
    expect(readings.state().readings[0]?.windows).toEqual({
      ...fiveHour(12),
      weekly: { usedPercent: 30, resetsAt: null },
    });
  });

  it('tells listeners of the same reading again only once a minute (to say how old it is)', () => {
    readings.take('claude-code', fiveHour(42));
    now += 10_000;
    readings.take('claude-code', fiveHour(42));
    expect(heard).toHaveLength(1);
    expect(readings.state().readings[0]?.at).toBe(START + 10_000);
    now += MINUTE;
    readings.take('claude-code', fiveHour(42));
    expect(heard).toHaveLength(2);
  });

  it('simulates a reading, which a real one replaces, and forgets it', () => {
    readings.simulate('claude-code', fiveHour(90));
    expect(readings.state().readings).toEqual([
      { backend: 'claude-code', windows: fiveHour(90), at: START, simulated: true },
    ]);
    readings.take('claude-code', fiveHour(20));
    expect(readings.state().readings).toEqual([
      { backend: 'claude-code', windows: fiveHour(20), at: START },
    ]);
    readings.simulate('claude-code', fiveHour(95));
    readings.simulate('claude-code', null);
    expect(readings.state().readings).toEqual([]);
  });

  it('a real reading does not keep windows only a simulated one had', () => {
    readings.simulate('claude-code', { weekly: { usedPercent: 99, resetsAt: null } });
    readings.take('claude-code', fiveHour(20));
    expect(readings.state().readings[0]?.windows).toEqual(fiveHour(20));
  });

  it('keeps a rule per backend, and takes it off', () => {
    readings.setRule('claude-code', { window: 'fiveHour', percent: 80, action: 'ask' });
    expect(readings.state().rules).toEqual({
      'claude-code': { window: 'fiveHour', percent: 80, action: 'ask' },
    });
    readings.setRule('claude-code', null);
    expect(readings.state().rules).toEqual({});
    expect(heard).toHaveLength(2);
  });

  it('remembers readings and rules across restarts, with when they were read', async () => {
    readings.take('claude-code', fiveHour(42));
    readings.setRule('claude-code', { window: 'weekly', percent: 90, action: 'waitForReset' });
    await readings.flush();
    now += 3 * HOUR;
    const again = await open();
    expect(again.state()).toEqual({
      readings: [{ backend: 'claude-code', windows: fiveHour(42), at: START }],
      rules: { 'claude-code': { window: 'weekly', percent: 90, action: 'waitForReset' } },
    });
  });

  it('starts empty from a missing or broken file, and skips what is not right in it', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(file, 'not json');
    expect((await open()).state()).toEqual({ readings: [], rules: {} });
    // Set aside, as it was, and said: never written over.
    expect(await setAside()).toBe('not json');
    expect(said).toHaveBeenCalledOnce();
    said.mockRestore();
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        readings: [
          { backend: 'claude-code', windows: fiveHour(5), at: START },
          { backend: 'gemini', windows: fiveHour(5), at: START },
          { backend: 'codex', windows: fiveHour(500), at: START },
          { backend: 'codex', windows: fiveHour(5), at: 'yesterday' },
        ],
        rules: { 'claude-code': { window: 'weekly', percent: 0, action: 'ask' }, codex: 'warn' },
      }),
    );
    expect((await open()).state()).toEqual({
      readings: [{ backend: 'claude-code', windows: fiveHour(5), at: START }],
      rules: {},
    });
  });

  it('reads a file of another version as nothing read and no rules, setting it aside', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const old = JSON.stringify({
      version: 1,
      readings: [{ backend: 'Claude', windows: fiveHour(5), at: START }],
      rules: { Claude: { window: 'weekly', percent: 80, action: 'ask' } },
    });
    await writeFile(file, old);
    expect((await open()).state()).toEqual({ readings: [], rules: {} });
    expect(await setAside()).toBe(old);
    expect(said).toHaveBeenCalledOnce();
    said.mockRestore();
  });

  it.skipIf(!CAN_DENY)('never writes over a file it can’t read: it refuses to load', async () => {
    readings.setRule('codex', { window: 'weekly', percent: 90, action: 'ask' });
    await readings.flush();
    const kept = await readFile(file, 'utf8');
    await chmod(file, 0);
    await expect(open()).rejects.toThrow(/EACCES/);
    await chmod(file, 0o600);
    expect(await readFile(file, 'utf8')).toBe(kept);
    expect((await open()).state().rules).toEqual({
      codex: { window: 'weekly', percent: 90, action: 'ask' },
    });
  });

  it('writes back what a newer corrallm keeps in it that it doesn’t know, as it was', async () => {
    const later = {
      version: 2,
      readings: [
        { backend: 'codex', windows: fiveHour(5), at: START, credits: 12 },
        { backend: 'claude-code', windows: fiveHour(6), at: START, plan: 'max' },
        { backend: 'gemini', windows: fiveHour(7), at: START },
      ],
      rules: {
        codex: { window: 'weekly', percent: 80, action: 'ask', then: 'gemini' },
        gemini: { window: 'weekly', percent: 70, action: 'warn' },
      },
      exhausted: {
        codex: { resetsAt: START + HOUR, window: 'fiveHour', source: 'cli' },
        gemini: { resetsAt: START + HOUR },
      },
      fallback: ['codex', 'gemini'],
    };
    await writeFile(file, JSON.stringify(later));
    const again = await open();
    expect(again.state()).toEqual({
      readings: [
        { backend: 'claude-code', windows: fiveHour(6), at: START },
        { backend: 'codex', windows: fiveHour(5), at: START },
      ],
      rules: { codex: { window: 'weekly', percent: 80, action: 'ask' } },
    });
    // A new reading is this one's own: what the one it replaces had goes with it.
    now += MINUTE;
    again.take('claude-code', fiveHour(8));
    await again.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      ...later,
      readings: [
        { backend: 'claude-code', windows: fiveHour(8), at: now },
        later.readings[0],
        later.readings[2],
      ],
    });
  });

  it('keeps no reading of a backend the catalog does not list', () => {
    readings.take('gemini', fiveHour(5));
    expect(readings.state()).toEqual({ readings: [], rules: {} });
    expect(heard).toEqual([]);
  });

  it('writes nothing but shares, times, rules and hard limits', async () => {
    readings.take('claude-code', fiveHour(42));
    await readings.flush();
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text)).toEqual({
      version: 2,
      readings: [{ backend: 'claude-code', windows: fiveHour(42), at: START }],
      rules: {},
      exhausted: {},
    });
  });
});
