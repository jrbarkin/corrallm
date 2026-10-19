import { describe, expect, it } from 'vitest';

import { mergeAgentSettings } from './session';
import type { AgentSettings } from './session';

describe('mergeAgentSettings', () => {
  const alpha = Object.freeze({ model: 'large', effort: 'high', mode: 'plan' });
  const beta = Object.freeze({ model: 'small', mode: 'manual' });
  const saved = Object.freeze({ alpha, beta });

  it('merges a model-only change without losing mode or effort', () => {
    expect(mergeAgentSettings(saved, 'alpha', { model: 'medium' })).toEqual({
      alpha: { model: 'medium', effort: 'high', mode: 'plan' },
      beta,
    });
    expect(saved.alpha).toEqual({ model: 'large', effort: 'high', mode: 'plan' });
  });

  it.each(['model', 'effort', 'mode'] as const)('unsets only %s when it is null', (field) => {
    const expected: AgentSettings = { ...alpha };
    Reflect.deleteProperty(expected, field);
    expect(mergeAgentSettings(saved, 'alpha', { [field]: null })).toEqual({
      alpha: expected,
      beta,
    });
  });

  it('drops an adapter’s entry when its last field is unset', () => {
    expect(
      mergeAgentSettings({ alpha: { model: 'large' }, beta }, 'alpha', { model: null }),
    ).toEqual({ beta });
    expect(
      mergeAgentSettings({ alpha: { mode: 'plan' } }, 'alpha', { mode: null }),
    ).toBeUndefined();
  });

  it('preserves another adapter’s entry and does not create empty entries', () => {
    expect(mergeAgentSettings(saved, 'alpha', { effort: null })?.beta).toBe(beta);
    expect(mergeAgentSettings({ beta }, 'alpha', { model: null })).toEqual({ beta });
    expect(mergeAgentSettings(undefined, 'alpha', {})).toBeUndefined();
    expect(mergeAgentSettings(saved, 'alpha', {})).toEqual(saved);
  });
});
