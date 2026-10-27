import { expect, it } from 'vitest';
import { SetFallbackInput, SetHandoffInput } from './fallback';
import { parseHandoff, SessionContextSchema } from '../model/fallback';

it('prepares strict, bounded inputs, with no caller-supplied run position', () => {
  const input = { agent: 'worker', fallback: { to: [{ adapter: 'zed' }] } };
  expect(SetFallbackInput.parse(input)).toMatchObject(input);
  expect(SetFallbackInput.parse({ agent: 'worker', fallback: null }).fallback).toBeNull();
  for (const fallback of [
    { to: [] },
    { to: Array(4).fill({ adapter: 'zed' }) },
    { to: [{ adapter: 'zed', mode: 'plan' }] },
    { ...input.fallback, on: { step: 0 } },
  ])
    expect(SetFallbackInput.safeParse({ agent: 'worker', fallback }).success).toBe(false);
  expect(SetFallbackInput.safeParse({ ...input, path: '/outside' }).success).toBe(false);
  expect(SetFallbackInput.safeParse({ ...input, agent: 'x'.repeat(257) }).success).toBe(false);
});

it('prepares handoff defaults and a nullable export-file removal', () => {
  expect(
    SetHandoffInput.parse({ agent: 'worker', handoff: { at: 95, file: null } }).handoff,
  ).toEqual({ at: 95, file: null });
  expect(parseHandoff({ at: 95, file: null })).toEqual({ at: 95 });
  expect(parseHandoff(null)).toBeUndefined();
  expect(SetHandoffInput.safeParse({ agent: 'worker', handoff: { off: false } }).success).toBe(
    false,
  );
});

it('validates whole reported token counts without estimating or clipping them', () => {
  expect(SessionContextSchema.parse({ used: 1001, window: 1000, compactAt: null })).toEqual({
    used: 1001,
    window: 1000,
    compactAt: null,
  });
  for (const context of [
    { used: -1, window: 1000, compactAt: null },
    { used: 1, window: 0, compactAt: null },
    { used: 1.5, window: 1000, compactAt: null },
    { used: Infinity, window: 1000, compactAt: null },
    { used: 1, window: 1000 },
  ])
    expect(SessionContextSchema.safeParse(context).success).toBe(false);
});
