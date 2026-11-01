import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { assembledState } from './topic-wire';

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;

describe('a chunked worktrees snapshot (B9a §7)', () => {
  it('is assembled as the core divides it: each agent’s item, then each tree kept, in order', () => {
    const items = [
      { agent: 'b', workspace: null, state: 'unmade' },
      { agent: 'a/b', workspace: null, state: 'unmade' },
    ];
    const kept = [{ workspace: '22222222-2222-4222-8222-222222222222', state: 'retained' }];
    expect(
      assembledState(`worktrees:${CANVAS}`, {}, [
        ...items.map((item) => [`item/${encodeURIComponent(item.agent)}`, item] as const),
        ...kept.map((tree, index) => [`kept/${String(index)}`, tree] as const),
      ]),
    ).toEqual({ items, kept });
  });
});

describe('a chunked settings snapshot (B12 C2)', () => {
  it('keeps the default agent, none included, and where the MCP server listens', () => {
    const api = { state: 'listening', port: 4242, url: 'http://127.0.0.1:4242/mcp' };
    for (const defaultAdapter of ['codex', null]) {
      expect(
        assembledState('settings', { defaultAdapter, api }, [['codex', { plan: true }]]),
      ).toEqual({ defaultAdapter, api, consents: { codex: { plan: true } } });
    }
  });
});
