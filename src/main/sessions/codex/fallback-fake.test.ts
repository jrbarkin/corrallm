import { describe, expect, it } from 'vitest';
import { fallbackTurn } from './fixtures/fallback.mjs';

describe('the App Server fallback journey fixture', () => {
  it('keeps ordinary turns unchanged without an explicit script', () => {
    expect(fallbackTurn(undefined, 'hello', 1)).toBeNull();
    expect(fallbackTurn({ turns: {} }, 'hello', 1)).toBeNull();
  });
  it('makes a real native account reading with its own reset, without a simulated field', () => {
    const result = fallbackTurn(
      { turns: { boundary: { usedPercent: 90, resetAfterSeconds: 30, gate: '/test/release' } } },
      '[corrallm] boundary',
      10_000,
    );
    expect(result).toMatchObject({
      usedPercent: 90,
      gate: '/test/release',
      limits: {
        limitId: 'codex',
        primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 40 },
      },
    });
    expect(result?.limits).not.toHaveProperty('simulated');
  });
  it('can fail only the named source turn while preserving the carried task as target work', () => {
    const script = { turns: { 'source-limit': { fail: true } } };
    expect(fallbackTurn(script, 'source-limit', 1)).toEqual({ fail: true });
    expect(fallbackTurn(script, 'a different target turn', 1)).toBeNull();
  });
});
