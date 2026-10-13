import { describe, expect, it } from 'vitest';

import { property } from '../transcript';
import { recordedNotifications, recordedResult } from './app-server/recorded';
import { codexLimits, usageWindows } from './limits';

/** When the recordings were made (their weekly window resets six days later). */
const NOW = 1_791_880_000_000;

/** A snapshot's windows as a usage reading has them. */
const windowsOf = (snapshot: unknown, now = NOW) => usageWindows(codexLimits(snapshot) ?? [], now);

describe('Codex’s usage limits', () => {
  it('reads the 5-hour and weekly windows from what the real app server answered and told', () => {
    const read = property(recordedResult('handshake', 'account/rateLimits/read'), 'rateLimits');
    expect(windowsOf(read)).toEqual({
      fiveHour: { usedPercent: 0, resetsAt: 1_791_896_263_000 },
      weekly: { usedPercent: 0, resetsAt: 1_792_483_063_000 },
    });
    const updated = recordedNotifications('turns').find(
      ({ method }) => method === 'account/rateLimits/updated',
    );
    expect(windowsOf(property(updated?.params, 'rateLimits'))).toEqual({
      fiveHour: { usedPercent: 0, resetsAt: 1_791_896_788_000 },
      weekly: { usedPercent: 0, resetsAt: 1_792_483_588_000 },
    });
  });

  it('names each window by its length, and by its place only when Codex does not say', () => {
    expect(
      windowsOf({
        limitId: 'codex',
        primary: { usedPercent: 37.5, windowDurationMins: 10_080, resetsAt: null },
      }),
    ).toEqual({ weekly: { usedPercent: 37.5, resetsAt: null } });
    expect(
      windowsOf({
        limitId: null,
        primary: { usedPercent: 12, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 3 },
      }),
    ).toEqual({
      fiveHour: { usedPercent: 12, resetsAt: null },
      weekly: { usedPercent: 3, resetsAt: null },
    });
    // A window corrallm does not count in (a day) is left out.
    expect(
      windowsOf({ limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 1440 } }),
    ).toBeUndefined();
  });

  it('keeps shares from 0 to 100, and only reset times within a week and a day', () => {
    expect(
      windowsOf({
        limitId: 'codex',
        primary: { usedPercent: 104, windowDurationMins: 300, resetsAt: NOW / 1000 + 90 * 86_400 },
        secondary: { usedPercent: -2, windowDurationMins: 10_080, resetsAt: 'soon' },
      }),
    ).toEqual({
      fiveHour: { usedPercent: 100, resetsAt: null },
      weekly: { usedPercent: 0, resetsAt: null },
    });
  });

  it('reads nothing from another limit (a model’s), or from what is not a snapshot', () => {
    expect(
      codexLimits({ limitId: 'gpt-6-sol', primary: { usedPercent: 50, windowDurationMins: 300 } }),
    ).toBeUndefined();
    expect(codexLimits(null)).toBeUndefined();
    expect(codexLimits('codex')).toBeUndefined();
    // Codex's own, with no window that says how much is used: none.
    expect(codexLimits({ limitId: 'codex', primary: null, secondary: null })).toEqual([]);
    expect(windowsOf({ limitId: 'codex', primary: { usedPercent: '12' } })).toBeUndefined();
  });
});
