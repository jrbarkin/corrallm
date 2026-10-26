import { expect, it } from 'vitest';
import { settingsChange } from './settings-change';

const saved = { model: 'haiku', effort: 'low', mode: 'plan' } as const;

it('names only what a choice changed, null where it restores the default', () => {
  expect(settingsChange(saved, { effort: 'low', mode: 'plan' })).toEqual({ model: null });
  expect(settingsChange(saved, { model: 'haiku', effort: 'high', mode: 'plan' })).toEqual({
    effort: 'high',
  });
  expect(settingsChange({}, { mode: 'plan' })).toEqual({ mode: 'plan' });
});

it('keeps two choices made from the same saved settings apart, so the second never puts the first back', () => {
  // Both were made before the first reached the page: each is computed from the same `saved`.
  const first = settingsChange(saved, { effort: 'low', mode: 'plan' });
  const second = settingsChange(saved, { model: 'haiku', effort: 'low' });
  expect(first).toEqual({ model: null });
  expect(second).toEqual({ mode: null });
  expect(Object.keys(first).some((key) => key in second)).toBe(false);
});

it('names nothing when nothing changed', () => {
  expect(settingsChange(saved, saved)).toEqual({});
  expect(settingsChange(undefined, {})).toEqual({});
});
