import { describe, expect, it } from 'vitest';
import { fallbackTurn } from './fixtures/fallback.mjs';

describe('the Terminal fallback journey fixture', () => {
  it('keeps ordinary turns unchanged without an explicit script', () => {
    expect(fallbackTurn(undefined, 'hello', 1)).toBeNull();
    expect(fallbackTurn({ turns: { other: { fail: true } } }, 'hello', 1)).toBeNull();
  });
  it('answers corrallm’s handoff request with the exact configured reply, separately from work', () => {
    const text = '# Handoff\nKeep these exact words.\n';
    expect(
      fallbackTurn(
        { handoff: text },
        '[corrallm] Your context is 60% full, so corrallm asks you to write your handoff now.',
        1,
      ),
    ).toEqual({ reply: text });
  });
  it('reports native context and a relative reset before a scripted limit ends the turn', () => {
    const script = {
      turns: {
        'fallback-limit': {
          fail: true,
          resetAfterSeconds: 30,
          reading: {
            context_window: { context_window_size: 1_000_000, used_percentage: 60 },
            rate_limits: { five_hour: { used_percentage: 100 } },
          },
        },
      },
    };
    expect(fallbackTurn(script, '[corrallm] run\nfallback-limit', 10_000)).toEqual({
      ...script.turns['fallback-limit'],
      reading: {
        context_window: { context_window_size: 1_000_000, used_percentage: 60 },
        rate_limits: { five_hour: { used_percentage: 100, resets_at: 40 } },
      },
    });
    expect(script.turns['fallback-limit'].reading.rate_limits.five_hour).toEqual({
      used_percentage: 100,
    });
  });
});
