import { describe, expect, it } from 'vitest';

import { catalog } from '../catalog';
import { runCatalog } from '../graph/agents';
import {
  ageText,
  backendsOf,
  holdText,
  percentText,
  resetTime,
  ruleText,
  warningText,
} from './usage';

const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();
const NOW = at(2026, 9, 12, 12, 0); // Monday 12 October 2026, noon

describe('backendsOf', () => {
  it('lists the backends a canvas’s agents use (by their adapters), once each, in order', () => {
    expect(backendsOf(catalog(), ['codex', 'claude-code', 'qwen', 'claude-code'])).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(backendsOf(catalog(), [])).toEqual([]);
  });
});

describe('the wording of usage', () => {
  it('says how much is used', () => {
    expect(percentText(42.4)).toBe('42%');
    expect(percentText(0.3)).toBe('<1%');
    expect(percentText(0)).toBe('0%');
    expect(percentText(100)).toBe('100%');
  });

  it('says when a window resets: the time today, the day this week, the date further off', () => {
    expect(resetTime(at(2026, 9, 12, 15, 40), NOW, 'en-US')).toBe('3:40 PM');
    expect(resetTime(at(2026, 9, 15, 9, 0), NOW, 'en-US')).toBe('Thu 9:00 AM');
    expect(resetTime(at(2026, 9, 20, 9, 0), NOW, 'en-US')).toBe('Oct 20 9:00 AM');
  });

  it('says how old a reading is', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('just now');
    expect(ageText(NOW - 4 * 60_000, NOW)).toBe('4 min ago');
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(ageText(NOW - 26 * 3_600_000, NOW)).toBe('1 day ago');
    expect(ageText(NOW - 50 * 3_600_000, NOW)).toBe('2 days ago');
  });

  it('reads a rule, and what a hold and a warning say', () => {
    expect(ruleText({ window: 'fiveHour', percent: 80, action: 'ask' })).toBe(
      'Over 80% of the 5-hour window: pause and ask me',
    );
    const hold = {
      backend: 'claude-code',
      window: 'weekly',
      percent: 90,
      used: 93.6,
      resetsAt: at(2026, 9, 12, 15, 40),
    } as const;
    const engine = runCatalog();
    expect(holdText(hold, engine)).toBe('Claude has used 94% of its weekly window (over 90%)');
    expect(warningText(hold, engine, NOW, 'en-US')).toBe(
      'Claude has used 94% of its weekly window (over 90%). It resets at 3:40 PM.',
    );
    expect(warningText({ ...hold, resetsAt: null }, engine, NOW)).toBe(
      'Claude has used 94% of its weekly window (over 90%).',
    );
  });
});
