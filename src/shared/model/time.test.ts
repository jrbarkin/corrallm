import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { deadline, parseTime, sameTime, TIME_PRESETS } from './time';
import { leftText, limitText, timeText } from './words';
import { TEST_ENGINE } from '../engine/test-engine';

/** What names a usage backend: the catalog main declares, as the run reads it. */
const engine = TEST_ENGINE;

const minutes = (n: number) => ({ seconds: n * 60 });
const hours = (n: number) => ({ seconds: n * 3600 });

describe('parseTime', () => {
  it('reads a bare number as minutes, hours, seconds, then a time of day', () => {
    expect(parseTime('10')).toEqual([minutes(10), hours(10), { seconds: 10 }, { at: '10:00' }]);
    expect(parseTime('15')).toEqual([minutes(15), hours(15), { seconds: 15 }, { at: '15:00' }]);
    // What is out of range is not offered.
    expect(parseTime('200')).toEqual([minutes(200), { seconds: 200 }]);
  });

  it.each([
    ['10m', 600],
    ['10 min', 600],
    ['10 minutes', 600],
    ['wait 10 minutes', 600],
    ['for 10 min', 600],
    ['in 10m', 600],
    ['1h30', 5400],
    ['1h 30m', 5400],
    ['1 hour 30 minutes', 5400],
    ['1.5 hours', 5400],
    ['90s', 90],
    ['1 minute 30 seconds', 90],
    ['2 days', 172800],
    ['1 week', 604800],
  ])('reads %s as a length', (text, seconds) => {
    expect(parseTime(text)).toEqual([{ seconds }]);
  });

  it.each([
    ['until 9', '09:00'],
    ['9am', '09:00'],
    ['9 AM', '09:00'],
    ['9:30', '09:30'],
    ['9:30pm', '21:30'],
    ['at 21:00', '21:00'],
    ['until 6:00 PM', '18:00'],
    ['12am', '00:00'],
    ['noon', '12:00'],
    ['until midnight', '00:00'],
  ])('reads %s as a time of day', (text, at) => {
    expect(parseTime(text)).toEqual([{ at }]);
  });

  it.each(['', '  ', '0 minutes', '8 days', '25:00', '9:60', '13pm', 'soon', '10 parsecs', '0.1s'])(
    'reads nothing in %j',
    (text) => {
      expect(parseTime(text)).toEqual([]);
    },
  );
});

describe('the wording of times', () => {
  it('says how long, or until when, in the locale given', () => {
    expect(timeText({ seconds: 600 }, engine)).toBe('10 minutes');
    expect(timeText({ seconds: 60 }, engine)).toBe('1 minute');
    expect(timeText({ seconds: 5400 }, engine)).toBe('1 hour 30 minutes');
    expect(timeText({ seconds: 90 }, engine)).toBe('1 minute 30 seconds');
    expect(timeText({ seconds: 2 * 86400 + 3600 }, engine)).toBe('2 days 1 hour');
    expect(timeText({ at: '09:00' }, engine, 'en-US')).toBe('until 9:00 AM');
    expect(timeText({ at: '18:05' }, engine, 'en-GB')).toBe('until 18:05');
  });

  it('words a time limit', () => {
    expect(limitText({ seconds: 1800 }, engine)).toBe('at most 30 minutes');
    expect(limitText({ at: '18:00' }, engine, 'en-US')).toBe('no later than 6:00 PM');
  });

  it('says when a backend’s usage window resets', () => {
    expect(timeText({ resets: 'fiveHour', backend: 'claude-code' }, engine)).toBe(
      'until Claude’s usage resets (5-hour)',
    );
    expect(timeText({ resets: 'weekly', backend: 'codex' }, engine)).toBe(
      'until Codex’s usage resets (weekly)',
    );
    expect(limitText({ resets: 'weekly', backend: 'claude-code' }, engine)).toBe(
      'no later than Claude’s usage resets (weekly)',
    );
    expect(
      sameTime(
        { resets: 'weekly', backend: 'claude-code' },
        { resets: 'weekly', backend: 'claude-code' },
      ),
    ).toBe(true);
    expect(
      sameTime(
        { resets: 'weekly', backend: 'claude-code' },
        { resets: 'fiveHour', backend: 'claude-code' },
      ),
    ).toBe(false);
    expect(sameTime({ resets: 'weekly', backend: 'claude-code' }, { seconds: 60 })).toBe(false);
  });

  it('says how long is left: minutes and seconds, or hours and minutes from an hour on', () => {
    expect(leftText(245_000)).toBe('4:05 left');
    expect(leftText(59_001)).toBe('1:00 left');
    expect(leftText(59_000)).toBe('0:59 left');
    expect(leftText(-5)).toBe('0:00 left');
    expect(leftText(3_600_000)).toBe('1 h 0 min left');
    expect(leftText((8 * 60 + 12) * 60_000 + 30_000)).toBe('8 h 12 min left');
  });

  it('reads back each preset from its own wording', () => {
    for (const preset of TIME_PRESETS) {
      expect(parseTime(timeText(preset, engine, 'en-US'))[0]).toEqual(preset);
    }
  });
});

describe('deadline', () => {
  // A zone with daylight saving time, whatever zone the tests run in.
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/New_York');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  const local = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).getTime();

  it('counts a length from when the queue reached it', () => {
    expect(deadline({ seconds: 600 }, 1_000)).toBe(601_000);
  });

  it('takes a usage window’s reset from its reading, or now if it has reset or is not read', () => {
    const reset = { resets: 'fiveHour', backend: 'claude-code' } as const;
    expect(deadline(reset, 1_000, () => 90_000)).toBe(90_000);
    expect(deadline(reset, 1_000, () => 500)).toBe(1_000);
    expect(deadline(reset, 1_000, () => undefined)).toBe(1_000);
    expect(deadline(reset, 1_000)).toBe(1_000);
  });

  it('takes a time of day later today, or tomorrow once it has passed or is now', () => {
    const morning = local(2026, 5, 10, 8, 0);
    expect(deadline({ at: '09:00' }, morning)).toBe(local(2026, 5, 10, 9, 0));
    expect(deadline({ at: '07:30' }, morning)).toBe(local(2026, 5, 11, 7, 30));
    expect(deadline({ at: '08:00' }, morning)).toBe(local(2026, 5, 11, 8, 0));
  });

  it('keeps the time of day across a change to daylight saving time', () => {
    // Clocks went forward an hour at 2 AM on 8 March 2026 in New York: that night is 23 hours.
    const evening = local(2026, 2, 7, 21, 0);
    const next = deadline({ at: '09:00' }, evening);
    expect(new Date(next).getHours()).toBe(9);
    expect(next - evening).toBe(11 * 3_600_000);
    const back = local(2026, 10, 1, 0, 30); // 1 November: clocks went back at 2 AM
    expect(deadline({ at: '09:00' }, back) - back).toBe(9.5 * 3_600_000);
  });
});
