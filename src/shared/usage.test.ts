import { describe, expect, it } from 'vitest';

import { parseBackend, parseRule, parseWindows, usageOver, usedUpUntil, windowNow } from './usage';
import type { UsageReading } from './usage';

const NOW = Date.UTC(2026, 9, 12, 12, 0);
const HOUR = 60 * 60 * 1000;

describe('parseWindows', () => {
  it('keeps each known window: the share used and when it resets', () => {
    expect(
      parseWindows(
        {
          fiveHour: { usedPercent: 42.5, resetsAt: NOW + HOUR },
          weekly: { usedPercent: 0, resetsAt: null },
          monthly: { usedPercent: 3, resetsAt: NOW },
        },
        NOW,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 42.5, resetsAt: NOW + HOUR },
      weekly: { usedPercent: 0, resetsAt: null },
    });
  });

  it('drops what a window holds besides its share and reset', () => {
    expect(
      parseWindows({ fiveHour: { usedPercent: 1, resetsAt: null, cwd: '/secret' } }, NOW),
    ).toEqual({ fiveHour: { usedPercent: 1, resetsAt: null } });
  });

  it.each([
    [null],
    [[]],
    [{ fiveHour: 'full' }],
    [{ fiveHour: { usedPercent: -1, resetsAt: null } }],
    [{ fiveHour: { usedPercent: 101, resetsAt: null } }],
    [{ fiveHour: { usedPercent: Number.NaN, resetsAt: null } }],
    [{ fiveHour: { usedPercent: '5', resetsAt: null } }],
    [{ fiveHour: { usedPercent: 5 } }],
    [{ weekly: { usedPercent: 5, resetsAt: NOW + 9 * 24 * HOUR } }],
    [{ weekly: { usedPercent: 5, resetsAt: Infinity } }],
  ])('refuses %j', (value) => {
    expect(() => parseWindows(value, NOW)).toThrow();
  });
});

describe('parseRule', () => {
  it('takes a window, a whole share from 1 to 99 and an action', () => {
    expect(parseRule({ window: 'weekly', percent: 80, action: 'ask' })).toEqual({
      window: 'weekly',
      percent: 80,
      action: 'ask',
    });
  });

  it.each([
    [{ window: 'daily', percent: 80, action: 'ask' }],
    [{ window: 'weekly', percent: 0, action: 'ask' }],
    [{ window: 'weekly', percent: 100, action: 'ask' }],
    [{ window: 'weekly', percent: 80.5, action: 'ask' }],
    [{ window: 'weekly', percent: 80, action: 'nextBackend' }],
    ['ask'],
  ])('refuses %j', (value) => {
    expect(() => parseRule(value)).toThrow();
  });
});

describe('parseBackend', () => {
  it('takes the backends whose usage corrallm reads', () => {
    const backends = ['claude-code', 'codex'];
    expect(parseBackend('claude-code', backends)).toBe('claude-code');
    expect(parseBackend('codex', backends)).toBe('codex');
    expect(() => parseBackend('gemini', backends)).toThrow(/Expected one of: claude-code, codex/);
    expect(() => parseBackend('Claude', backends)).toThrow();
  });
});

describe('usageOver', () => {
  const reading: UsageReading = {
    backend: 'claude-code',
    windows: {
      fiveHour: { usedPercent: 85, resetsAt: NOW + HOUR },
      weekly: { usedPercent: 40, resetsAt: null },
    },
    at: NOW - HOUR,
  };

  it('holds while the latest reading of the window is over the share', () => {
    expect(usageOver(reading, 'fiveHour', 80, NOW)).toBe(true);
    expect(usageOver(reading, 'fiveHour', 85, NOW)).toBe(false);
    expect(usageOver(reading, 'weekly', 30, NOW)).toBe(true);
  });

  it('no longer holds once the window has reset, or without a reading', () => {
    expect(usageOver(reading, 'fiveHour', 80, NOW + HOUR)).toBe(false);
    expect(windowNow(reading, 'fiveHour', NOW + HOUR)).toBeUndefined();
    expect(usageOver(undefined, 'fiveHour', 1, NOW)).toBe(false);
    expect(usageOver({ ...reading, windows: {} }, 'weekly', 1, NOW)).toBe(false);
  });
});

describe('usedUpUntil', () => {
  it('says until when a reading shows its backend used up: the latest reset of its full windows', () => {
    expect(usedUpUntil({ fiveHour: { usedPercent: 100, resetsAt: NOW + HOUR } }, NOW)).toBe(
      NOW + HOUR,
    );
    // The weekly window, used up too, holds it past the 5-hour window's reset.
    expect(
      usedUpUntil(
        {
          fiveHour: { usedPercent: 100, resetsAt: NOW + HOUR },
          weekly: { usedPercent: 100, resetsAt: NOW + 50 * HOUR },
        },
        NOW,
      ),
    ).toBe(NOW + 50 * HOUR);
    expect(
      usedUpUntil(
        {
          fiveHour: { usedPercent: 40, resetsAt: NOW + HOUR },
          weekly: { usedPercent: 100, resetsAt: NOW + 50 * HOUR },
        },
        NOW,
      ),
    ).toBe(NOW + 50 * HOUR);
  });

  it('says nothing where no window is full, or a full one’s reset has passed or isn’t said', () => {
    expect(usedUpUntil({}, NOW)).toBeUndefined();
    expect(
      usedUpUntil(
        {
          fiveHour: { usedPercent: 99, resetsAt: NOW + HOUR },
          weekly: { usedPercent: 60, resetsAt: NOW + 50 * HOUR },
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(usedUpUntil({ fiveHour: { usedPercent: 100, resetsAt: NOW } }, NOW)).toBeUndefined();
    expect(usedUpUntil({ weekly: { usedPercent: 100, resetsAt: null } }, NOW)).toBeUndefined();
  });
});
