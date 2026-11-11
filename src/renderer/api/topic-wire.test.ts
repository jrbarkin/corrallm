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

  it('keeps the branch the project checkout is on, which the core sends in the summary', () => {
    const into = { ref: 'main', commit: 'a'.repeat(40) };
    expect(assembledState(`worktrees:${CANVAS}`, { into }, [])).toEqual({
      items: [],
      kept: [],
      into,
    });
    expect(assembledState(`worktrees:${CANVAS}`, { into: null }, [])).toEqual({
      items: [],
      kept: [],
      into: null,
    });
  });
});

describe('a chunked leads snapshot (B24 C1)', () => {
  it('is assembled as the core divides it: each lead by its agent, then each outside name', () => {
    const leads = [
      { agent: 'b', grants: { questions: true, plans: false, approvals: true }, held: null },
      { agent: 'a/b', grants: { questions: false, plans: false, approvals: true }, held: 'role' },
    ];
    const outside = [{ name: 'orchestrator', approvals: true, live: false }];
    expect(
      assembledState(`leads:${CANVAS}`, {}, [
        ...leads.map((lead) => [`lead/${encodeURIComponent(lead.agent)}`, lead] as const),
        ...outside.map((one) => [`outside/${encodeURIComponent(one.name)}`, one] as const),
      ]),
    ).toEqual({ leads, outside });
  });
});

describe('a chunked settings snapshot (B12 C2)', () => {
  it('keeps the default agent, none included, and where the MCP server listens', () => {
    const api = { state: 'listening', port: 4242, url: 'http://127.0.0.1:4242/mcp' };
    for (const defaultAdapter of ['codex', null]) {
      expect(
        assembledState('settings', { defaultAdapter, api }, [['consent/codex', { plan: true }]]),
      ).toEqual({ defaultAdapter, api, consents: { codex: { plan: true } } });
    }
  });
});

describe('a chunked settings snapshot, as only you are sent it (B22a C2)', () => {
  const api = { state: 'stopped', port: null };
  const notifications = { enabled: false, lastDelivery: 'shown' };
  const SITES = ['https://b.example.com:8443', 'http://localhost:5173', 'https://a.example.com'];
  const site = (origin: string) => [`site/${encodeURIComponent(origin)}`, origin] as const;

  it('puts your remembered sites back in their order, beside the built-in ones', () => {
    expect(
      assembledState(
        'settings',
        {
          defaultAdapter: null,
          api,
          notifications,
          links: { state: 'ready', builtIn: ['https://github.com'] },
        },
        [
          ['consent/old-adapter', { allowed: true }],
          ['consent/codex', { plan: true }],
          ...SITES.map(site),
        ],
      ),
    ).toEqual({
      defaultAdapter: null,
      api,
      notifications,
      consents: { 'old-adapter': { allowed: true }, codex: { plan: true } },
      links: { state: 'ready', sites: SITES, builtIn: ['https://github.com'] },
    });
    const unavailable = { state: 'unavailable', sentence: 'Not now.' };
    expect(
      assembledState(
        'settings',
        { defaultAdapter: null, api, notifications, links: unavailable },
        [],
      ),
    ).toEqual({ defaultAdapter: null, api, notifications, consents: {}, links: unavailable });
  });

  it('refuses an entry of no namespace, a key that isn’t its value, a repeat, or a site with no list', () => {
    const ready = {
      defaultAdapter: null,
      api,
      notifications,
      links: { state: 'ready', builtIn: [] },
    };
    for (const pairs of [
      [['codex', { plan: true }]],
      [['consentcodex', { plan: true }]],
      [['other/codex', { plan: true }]],
      [
        ['consent/codex', { plan: true }],
        ['consent/codex', { plan: true }],
      ],
      [['consent/%E0%A4%A', { plan: true }]],
      [['consent/a%2fb', { plan: true }]],
      [[`site/${encodeURIComponent(SITES[0] ?? '')}`, SITES[1]]],
      [site(SITES[0] ?? ''), site(SITES[0] ?? '')],
    ] as [string, unknown][][])
      expect(() => assembledState('settings', ready, pairs), JSON.stringify(pairs)).toThrow();
    // Sites for a reader told no list: none of them is kept.
    expect(() =>
      assembledState('settings', { defaultAdapter: null, api }, [site(SITES[0] ?? '')]),
    ).toThrow();
  });
});
