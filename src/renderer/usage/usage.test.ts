import { describe, expect, it } from 'vitest';

import { catalog } from '../catalog';
import { ageText, backendsOf, ruleText } from './usage';

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
  it('says how old a reading is', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('just now');
    expect(ageText(NOW - 4 * 60_000, NOW)).toBe('4 min ago');
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(ageText(NOW - 26 * 3_600_000, NOW)).toBe('1 day ago');
    expect(ageText(NOW - 50 * 3_600_000, NOW)).toBe('2 days ago');
  });

  it('reads a rule', () => {
    expect(ruleText({ window: 'fiveHour', percent: 80, action: 'ask' })).toBe(
      'Over 80% of the 5-hour window: pause and ask me',
    );
  });
});
