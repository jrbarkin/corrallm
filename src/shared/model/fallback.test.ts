import { describe, expect, it } from 'vitest';

import type { Catalog } from '../adapter';
import { MADE_UP } from '../test-made-up';
import type { Fallback, FallbackStep } from './fallback';
import {
  FallbackSchema,
  HandoffSettingsSchema,
  HANDOFF_RESERVE,
  askPoint,
  next,
  parseFallback,
  resolveAction,
  sameFallback,
  sameHandoff,
} from './fallback';

const own: FallbackStep = { adapter: 'zed', connection: 'zed.acp' };
const free: FallbackStep = { adapter: 'zed', connection: 'zed.free' };
const alternative: FallbackStep = { ...own, model: 'other', effort: 'low' };
const position = { step: 0, from: own, kept: { model: null }, why: 'rule' as const, at: 1000 };
const [madeUp] = MADE_UP.adapters;
const [madeUpConnection] = madeUp?.connections ?? [];
if (madeUp === undefined || madeUpConnection === undefined)
  throw new Error('missing made-up fixture');
const switched: Fallback = {
  to: [free, alternative],
  back: 'return',
  on: position,
};
const other: Catalog['adapters'][number] = {
  ...madeUp,
  id: 'quill',
  name: 'Quill',
  actions: [
    { name: 'execute', description: '', job: 'shell' },
    { name: 'onlyHere', description: '' },
  ],
  connections: [{ ...madeUpConnection, id: 'quill.api', usage: 'quill' }],
};
const catalog: Catalog = {
  adapters: [...MADE_UP.adapters, other],
  usageBackends: [
    ...MADE_UP.usageBackends,
    { id: 'quill', label: 'Quill', source: '', windows: [] },
  ],
};

describe('fallback contracts', () => {
  it('keeps a stored unknown endpoint and a complete run position, canonically', () => {
    const value = { ...switched, to: [free, { adapter: 'future', connection: 'future.api' }] };
    expect(FallbackSchema.parse(value)).toEqual(value);
    expect(sameFallback(value, structuredClone(value))).toBe(true);
    expect(sameFallback(value, { ...value, on: { ...position, at: 1001 } })).toBe(false);
    expect(sameFallback(undefined, undefined)).toBe(true);
    expect(sameFallback(undefined, value)).toBe(false);
    expect(
      sameHandoff({ at: 95, file: 'notes/handoff.md' }, { file: 'notes/handoff.md', at: 95 }),
    ).toBe(true);
    expect(sameHandoff(undefined, {})).toBe(false);
  });

  it.each([
    { to: [] },
    { to: Array(4).fill(free) },
    { to: [free, free] },
    { to: [{ ...free, mode: 'plan' }] },
    { to: [{ ...free, model: '-flag' }] },
    { to: [{ ...free, effort: '-flag' }] },
    { to: [{ ...free, connection: 'x'.repeat(33) }] },
    { ...switched, on: { ...position, step: 2 } },
    { ...switched, on: { ...position, step: -1 } },
    { ...switched, on: { ...position, at: Infinity } },
    { ...switched, on: { ...position, why: 'manual' } },
    { ...switched, on: { ...position, from: free } },
    { to: [free], shell: 'program' },
  ])('refuses a malformed stored chain: %j', (value) => {
    expect(FallbackSchema.safeParse(value).success).toBe(false);
  });

  it('resolves omitted connections by catalog order and refuses unknown or mismatched input', () => {
    expect(parseFallback({ to: [{ adapter: 'quill' }] }, catalog, own)).toEqual({
      to: [{ adapter: 'quill', connection: 'quill.api' }],
    });
    for (const value of [
      { to: [{ adapter: 'future' }] },
      { to: [{ adapter: 'zed', connection: 'future.api' }] },
      { to: [{ adapter: 'zed', connection: 'quill.api' }] },
      { to: [own] },
      { to: [{ adapter: 'zed' }, own] },
      switched,
    ])
      expect(() => parseFallback(value, catalog, own)).toThrow();
    expect(parseFallback({ to: [alternative] }, catalog, own)).toEqual({ to: [alternative] });
  });
});

describe('handoff settings and reported tokens', () => {
  it.each([{}, { off: true }, { at: 10 }, { at: 95, file: 'notes/My handoff.md' }])(
    'keeps bounded settings %j',
    (value) => {
      expect(HandoffSettingsSchema.parse(value)).toEqual(value);
    },
  );

  it.each([
    { at: 9 },
    { at: 96 },
    { at: 94.5 },
    { off: false },
    { file: null },
    { file: '' },
    { file: '/handoff.md' },
    { file: '../handoff.md' },
    { file: 'a//handoff.md' },
    { file: 'a/./handoff.md' },
    { file: '-a/handoff.md' },
    { file: '.git/handoff.md' },
    { file: '.GIT/handoff.md' },
    { file: 'handoff.MD' },
    { file: 'a\\handoff.md' },
    { file: 'a'.repeat(198) + '.md' },
    { shell: 'program' },
  ])('refuses invalid settings %j', (value) => {
    expect(HandoffSettingsSchema.safeParse(value).success).toBe(false);
  });

  it('asks before compaction on both F13 token bases, with the fixed reserve', () => {
    expect(HANDOFF_RESERVE).toBe(20_000);
    expect(askPoint(95, { used: 950_000, window: 1_000_000, compactAt: 967_000 })).toBe(947_000);
    expect(askPoint(95, { used: 450_000, window: 475_000, compactAt: 450_000 })).toBe(430_000);
    expect(askPoint(50, { used: 1, window: 1_000_000, compactAt: 967_000 })).toBe(500_000);
    expect(askPoint(95, { used: 1, window: 1000, compactAt: null })).toBe(950);
    expect(askPoint(95, { used: 1, window: 1000, compactAt: 1000 })).toBe(0);
  });
});

describe('the bounded forward walk', () => {
  it('starts at the first next step, never inventing a chain or spending a backend with none', () => {
    expect(next(own, catalog, new Map())).toEqual({ none: [] });
    expect(next({ ...own, fallback: { to: [free] } }, catalog, new Map())).toEqual({
      step: free,
      passed: [],
    });
  });

  it('passes missing endpoints and every step spending the same held pool, then ends at its origin', () => {
    const missing = { adapter: 'future', connection: 'future.api' };
    const paid = { adapter: 'quill', connection: 'quill.api' };
    const fallback: Fallback = {
      to: [free, missing, paid],
      on: { step: 0, from: own, why: 'usage-limit', at: 1 },
    };
    const held = new Map([['quill', { why: 'usage-limit' as const, resetsAt: 2000 }]]);
    expect(next({ ...free, fallback }, catalog, held)).toEqual({
      step: own,
      passed: [
        { step: missing, why: 'unavailable' },
        { step: paid, why: 'usage-limit', resetsAt: 2000 },
      ],
    });
    held.set('zed', { why: 'usage-limit', resetsAt: 3000 });
    expect(next({ ...free, fallback }, catalog, held)).toEqual({
      none: [
        { step: missing, why: 'unavailable' },
        { step: paid, why: 'usage-limit', resetsAt: 2000 },
        { step: own, why: 'usage-limit', resetsAt: 3000 },
      ],
    });
  });

  it('takes only the suffix after the current step and skips a supplied real rule hold', () => {
    const held = new Map([['zed', { why: 'rule' as const, resetsAt: null }]]);
    expect(next({ ...free, fallback: switched }, catalog, held)).toEqual({
      none: [
        { step: alternative, why: 'rule', resetsAt: null },
        { step: own, why: 'rule', resetsAt: null },
      ],
    });
    expect(
      next(
        {
          ...own,
          settings: { zed: { model: 'other', effort: 'low' } },
          fallback: { ...switched, on: { ...position, step: 1 } },
        },
        catalog,
        new Map(),
      ),
    ).toEqual({ step: own, passed: [] });
  });

  it('passes a step matching the edited current endpoint, comparing model and effort too', () => {
    const fallback = { to: [own, alternative] };
    expect(next({ ...own, fallback }, catalog, new Map())).toEqual({
      step: alternative,
      passed: [{ step: own, why: 'already-on' }],
    });
    expect(
      next(
        { ...own, settings: { zed: { model: 'other', effort: 'low' } }, fallback: switched },
        catalog,
        new Map(),
      ),
    ).toEqual({
      step: own,
      passed: [{ step: alternative, why: 'already-on' }],
    });
    expect(
      next({ ...own, fallback: { ...switched, on: { ...position, step: 1 } } }, catalog, new Map()),
    ).toEqual({
      none: [{ step: own, why: 'already-on' }],
    });
  });
});

describe('action resolution for a send (no document rewrite)', () => {
  it('keeps declared actions, translates a known job, and refuses everything else', () => {
    expect(resolveAction('shell', 'zed', catalog)).toEqual({ action: 'shell' });
    expect(resolveAction('shell', 'quill', catalog)).toEqual({ action: 'execute' });
    expect(resolveAction('onlyHere', 'zed', catalog)).toEqual({ unknown: true });
    expect(resolveAction('madeUp', 'zed', catalog)).toEqual({ unknown: true });
    expect(resolveAction('shell', 'missing', catalog)).toEqual({ unknown: true });
    const ambiguous = {
      ...catalog,
      adapters: [
        ...catalog.adapters,
        {
          ...other,
          id: 'other',
          actions: [{ name: 'shell', description: '', job: 'write' as const }],
        },
      ],
    };
    expect(resolveAction('shell', 'quill', ambiguous)).toEqual({ unknown: true });
    const unnamed = {
      ...catalog,
      adapters: [
        ...catalog.adapters,
        { ...other, id: 'other', actions: [{ name: 'shell', description: '' }] },
      ],
    };
    expect(resolveAction('shell', 'quill', unnamed)).toEqual({ unknown: true });
  });
});
