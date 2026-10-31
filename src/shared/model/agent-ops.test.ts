import type { QueueItem } from './queue';
import type { AgentSettingsChange } from '../session';
import { describe, expect, it } from 'vitest';
import type { CanvasId } from '../canvas';
import type { AgentNode, CanvasDocument, CanvasNode } from './canvas';
import {
  setConnection,
  setRole,
  setSettings,
  setType,
  translateActions,
  equivalentAction,
  setFallback,
  fallbackMove,
} from './agent-ops';
import { TEST_CATALOG } from '../test-model';
import { MADE_UP } from '../test-made-up';

const context = { catalog: TEST_CATALOG, defaultAdapter: 'claude-code' };
const doc = (): CanvasDocument => ({
  id: '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId,
  arrange: true,
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'A', queue: [{ id: 's', action: 'Bash', by: 'you' }] },
    },
    { id: 'b', type: 'agent', position: { x: 300, y: 0 }, data: { label: 'B' } },
  ],
  links: [{ source: 'a', target: 'b' }],
});
const data = (document: CanvasDocument) => (document.nodes[0] as AgentNode).data;

describe('agent setup operations', () => {
  it('keeps the chain when a later type, connection, model or effort edit matches a step', () => {
    const before = doc();
    data(before).adapter = 'other';
    const ctx = { catalog: MADE_UP, defaultAdapter: 'zed' };
    const fallback = { to: [{ adapter: 'zed', connection: 'zed.acp' }] };
    data(before).fallback = fallback;
    const typed = setType(before, { agent: 'a', adapter: 'zed' }, ctx).next;
    expect(data(typed).fallback).toBe(fallback);
    data(typed).connection = 'zed.free';
    const connected = setConnection(typed, { agent: 'a', connection: 'zed.acp' }, ctx).next;
    expect(data(connected).fallback).toBe(fallback);
    for (const change of [{ model: 'chosen' }, { effort: 'low' }]) {
      const step = { adapter: 'zed', connection: 'zed.acp', ...change };
      data(connected).fallback = { to: [step] };
      const edited = setSettings(connected, { agent: 'a', adapter: 'zed', change }).next;
      expect(data(edited).fallback).toBe(data(connected).fallback);
      expect(data(edited).settings?.zed).toMatchObject(change);
    }
    expect(() => setFallback(connected, { agent: 'a', fallback }, ctx)).toThrow(/distinct/);
  });

  it('clears only fallback.on for your type and connection choices, even the existing choice', () => {
    const before = doc();
    data(before).adapter = 'zed';
    data(before).connection = 'zed.acp';
    data(before).fallback = {
      to: [{ adapter: 'zed', connection: 'zed.acp' }],
      on: { step: 0, from: { adapter: 'old', connection: 'old.api' }, why: 'rule', at: 1 },
    };
    const ctx = { catalog: MADE_UP, defaultAdapter: 'zed' };
    for (const next of [
      setType(before, { agent: 'a', adapter: 'zed' }, ctx).next,
      setConnection(before, { agent: 'a', connection: 'zed.acp' }, ctx).next,
      setConnection(before, { agent: 'a', connection: 'zed.free' }, ctx).next,
    ])
      expect(data(next).fallback).toEqual({ to: data(before).fallback?.to });
    expect(
      data(setConnection(before, { agent: 'a', connection: 'absent' }, ctx).next).fallback,
    ).toBe(data(before).fallback);
    expect(
      data(setSettings(before, { agent: 'a', adapter: 'zed', change: { model: 'new' } }).next)
        .fallback,
    ).toBe(data(before).fallback);
  });

  it('resolves a new chain, retains and reanchors only an existing position, or removes it', () => {
    const before = doc();
    data(before).adapter = 'zed';
    data(before).connection = 'zed.free';
    const from = { adapter: 'zed', connection: 'zed.acp' };
    const on = { step: 0, from, kept: { model: null }, why: 'rule' as const, at: 1 };
    data(before).fallback = { to: [{ adapter: 'zed', connection: 'zed.free' }], on };
    const ctx = { catalog: MADE_UP, defaultAdapter: 'zed' };
    const fallback = {
      to: [
        { adapter: 'zed', model: 'other' },
        { adapter: 'zed', connection: 'zed.free' },
      ],
    };
    const changed = setFallback(before, { agent: 'a', fallback }, ctx).next;
    expect(data(changed).fallback).toEqual({
      to: [
        { adapter: 'zed', connection: 'zed.acp', model: 'other' },
        { adapter: 'zed', connection: 'zed.free' },
      ],
      on: { ...on, step: 1 },
    });
    expect(setFallback(changed, { agent: 'a', fallback }, ctx).next).toBe(changed);
    expect(changed.nodes[1]).toBe(before.nodes[1]);
    expect(
      data(
        setFallback(
          before,
          { agent: 'a', fallback: { to: [{ adapter: 'zed', model: 'other' }] } },
          ctx,
        ).next,
      ).fallback,
    ).not.toHaveProperty('on');
    expect(data(setFallback(before, { agent: 'a', fallback: null }, ctx).next)).not.toHaveProperty(
      'fallback',
    );
    expect(data(before).fallback?.on).toEqual(on);
    expect(() =>
      setFallback(before, { agent: 'a', fallback: { to: [{ adapter: 'missing' }] } }, ctx),
    ).toThrow();
  });

  it('translates by catalog jobs, including an adapter the renderer does not know', () => {
    const catalog = { ...TEST_CATALOG, adapters: [...TEST_CATALOG.adapters, ...MADE_UP.adapters] };
    const before = doc();
    const changed = setType(
      before,
      { agent: 'a', adapter: 'zed' },
      { catalog, defaultAdapter: 'claude-code' },
    ).next;
    expect(data(changed).queue).toEqual([{ id: 's', action: 'shell', by: 'you' }]);
    expect(changed.nodes[1]).toBe(before.nodes[1]);
    expect(changed.links).toBe(before.links);
    expect(changed.nodes[0]?.position).toBe(before.nodes[0]?.position);
    const queue = [{ id: 'known', message: 'Keep me' }];
    expect(translateActions(queue, 'claude-code', 'zed', catalog)).toBe(queue);
  });
  it('merges settings, fits modes to the connection, and leaves a no-op identical', () => {
    const before = doc();
    data(before).adapter = 'zed';
    data(before).settings = {
      zed: { model: 'chosen', effort: 'low', mode: 'plan' },
      codex: { model: 'other' },
    };
    const ctx = { catalog: MADE_UP, defaultAdapter: 'zed' };
    const changed = setSettings(before, {
      agent: 'a',
      adapter: 'zed',
      change: { model: 'new' },
    }).next;
    expect(data(changed).settings).toEqual({
      zed: { model: 'new', effort: 'low', mode: 'plan' },
      codex: { model: 'other' },
    });
    expect(
      data(setConnection(changed, { agent: 'a', connection: 'zed.free' }, ctx).next).settings,
    ).toEqual({ zed: { model: 'new', effort: 'low' }, codex: { model: 'other' } });
    expect(
      setSettings(changed, { agent: 'a', adapter: 'zed', change: { model: 'new' } }).next,
    ).toBe(changed);
    expect(data(setRole(before, { agent: 'a', role: '  Reviews.  ' }).next).role).toBe('Reviews.');
  });
});

function agentNode(id: string, x: number, y: number, extra: Partial<AgentNode> = {}): AgentNode {
  return { id, type: 'agent', position: { x, y }, data: { label: id }, ...extra };
}
function frame(id: string, x: number, y: number): CanvasNode {
  return { id, type: 'frame', position: { x, y }, data: { label: id } };
}
function frozen(nodes: CanvasNode[]): CanvasDocument {
  const document = { ...doc(), nodes };
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(document);
  return document;
}
function get(doc: CanvasDocument, id: string): AgentNode {
  const node = doc.nodes.find((one) => one.id === id);
  if (!node) throw new Error('no node');
  return node as AgentNode;
}
const setAgent = (doc: CanvasDocument, agent: string, adapter: string) =>
  setType(doc, { agent, adapter }, context).next;
const setSaved = (
  doc: CanvasDocument,
  agent: string,
  adapter: string,
  change: AgentSettingsChange,
) => setSettings(doc, { agent, adapter, change }).next;
const setConnected = (doc: CanvasDocument, agent: string, connection: string) =>
  setConnection(doc, { agent, connection }, context).next;
describe('setAgent', () => {
  it('translates steps to the new CLI, including Ifs and repeats, keeping their instructions', () => {
    const queue: QueueItem[] = [
      { id: 'run', action: 'Bash', instruction: 'npm test', expect: 'fails' },
      { id: 'read', action: 'Read', target: 'b', instruction: 'REVIEW.md' },
      { id: 'custom', action: '/custom' },
      { id: 'message', message: 'Carry on', target: 'b' },
      { id: 'if', if: { kind: 'failed' }, then: [{ id: 'edit', action: 'Edit' }] },
      {
        id: 'loop',
        repeat: [
          { id: 'search', action: 'WebSearch', instruction: 'Find the package documentation' },
          { id: 'wait', waitFor: [{ agent: 'b' }] },
          { id: 'delay', delay: { seconds: 60 } },
        ],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
    ];
    const g = frozen([
      agentNode('a', 0, 0, { data: { label: 'a', queue } }),
      agentNode('b', 0, 100),
    ]);
    const changed = setAgent(g, 'a', 'codex');
    expect(get(changed, 'a').data.queue).toEqual([
      { id: 'run', action: 'exec_command', instruction: 'npm test', expect: 'fails' },
      { id: 'read', action: 'Read', target: 'b', instruction: 'REVIEW.md' },
      { id: 'custom', action: '/custom' },
      { id: 'message', message: 'Carry on', target: 'b' },
      { id: 'if', if: { kind: 'failed' }, then: [{ id: 'edit', action: 'apply_patch' }] },
      {
        id: 'loop',
        repeat: [
          { id: 'search', action: 'web_search', instruction: 'Find the package documentation' },
          { id: 'wait', waitFor: [{ agent: 'b' }] },
          { id: 'delay', delay: { seconds: 60 } },
        ],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
    ]);
    expect(get(changed, 'b')).toBe(get(g, 'b'));
    expect(get(g, 'a').data.queue).toEqual(queue);
  });

  it("sets a node's agent type; groups have none", () => {
    const g = frozen([agentNode('a', 0, 0), frame('F', 0, 100)]);
    const qwen = setAgent(g, 'a', 'qwen');
    expect(get(qwen, 'a').data.adapter).toBe('qwen');
    expect(setAgent(qwen, 'a', 'qwen')).toBe(qwen);
    expect(setAgent(g, 'F', 'qwen')).toBe(g);
  });

  it('drops a connection the new type does not offer', () => {
    const g = frozen([
      agentNode('a', 0, 0, { data: { label: 'a', connection: 'claude-code.terminal' } }),
    ]);
    expect(get(setAgent(g, 'a', 'codex'), 'a').data).toEqual({
      label: 'a',
      adapter: 'codex',
    });
  });
});

describe('setConnection', () => {
  it('switches real connections; unavailable types and groups cannot be connected', () => {
    const g = frozen([
      agentNode('a', 0, 0),
      agentNode('b', 0, 100, { data: { label: 'b', adapter: 'gemini' } }),
      frame('F', 0, 200),
    ]);
    const sdk = setConnected(g, 'a', 'claude-code.sdk');
    expect(get(sdk, 'a').data.connection).toBe('claude-code.sdk');
    expect(setConnected(sdk, 'a', 'claude-code.sdk')).toBe(sdk);
    expect(get(setConnected(sdk, 'a', 'claude-code.terminal'), 'a').data).toEqual({
      label: 'a',
      connection: 'claude-code.terminal',
    });
    expect(setConnected(sdk, 'a', 'unavailable')).toBe(sdk);
    expect(setConnected(g, 'b', 'claude-code.terminal')).toBe(g);
    expect(setConnected(g, 'F', 'claude-code.terminal')).toBe(g);
  });
});

describe('setSettings', () => {
  it('merges a model-only change, keeping saved mode, effort and other adapters', () => {
    const other = { model: 'gpt-6-luna', mode: 'auto' };
    const g = frozen([
      agentNode('a', 0, 0, {
        data: {
          label: 'a',
          settings: {
            'claude-code': { model: 'opus', effort: 'high', mode: 'plan' },
            codex: other,
          },
        },
      }),
    ]);
    const result = setSaved(g, 'a', 'claude-code', { model: 'haiku' });
    expect(get(result, 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', effort: 'high', mode: 'plan' },
      codex: other,
    });
    expect(get(result, 'a').data.settings?.codex).toBe(other);
    expect(get(setSaved(result, 'a', 'claude-code', { effort: null }), 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', mode: 'plan' },
      codex: other,
    });
    expect(get(setSaved(result, 'a', 'claude-code', {}), 'a').data.settings).toEqual(
      get(result, 'a').data.settings,
    );
  });

  it('sets what an agent runs with by one adapter, keeping the other’s; nothing set leaves nothing', () => {
    const g = frozen([agentNode('a', 0, 0), frame('F', 0, 200)]);
    const claude = setSaved(g, 'a', 'claude-code', { model: 'haiku', mode: 'plan' });
    const both = setSaved(claude, 'a', 'codex', { effort: 'low' });
    expect(get(both, 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', mode: 'plan' },
      codex: { effort: 'low' },
    });
    expect(get(setSaved(both, 'a', 'codex', { effort: null }), 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', mode: 'plan' },
    });
    expect(
      get(setSaved(claude, 'a', 'claude-code', { model: null, mode: null }), 'a').data,
    ).toEqual({ label: 'a' });
    expect(setSaved(g, 'F', 'claude-code', { model: 'haiku' })).toBe(g);
  });

  it('drops a saved mode the connection an agent switches to does not start in', () => {
    // Codex's App Server starts in Plan; its Terminal only in Read only (Plan is chosen in it).
    const planning = { codex: { model: 'gpt-6-luna', mode: 'plan' } };
    const g = frozen([
      agentNode('a', 0, 0, {
        data: { label: 'a', adapter: 'codex', connection: 'codex.app-server', settings: planning },
      }),
    ]);
    expect(get(setConnected(g, 'a', 'codex.terminal'), 'a').data.settings).toEqual({
      codex: { model: 'gpt-6-luna' },
    });
    // A mode it starts in stays, and so does what other adapters are set to.
    const reading = {
      codex: { model: 'gpt-6-luna', mode: 'read-only' },
      'claude-code': { mode: 'plan' },
    };
    const read = setSaved(g, 'a', 'codex', reading.codex);
    const both = setSaved(read, 'a', 'claude-code', reading['claude-code']);
    expect(get(setConnected(both, 'a', 'codex.terminal'), 'a').data.settings).toEqual(reading);
    // Switching adapter, it runs that adapter's first connection.
    const claude = setSaved(
      frozen([agentNode('b', 0, 0, { data: { label: 'b', adapter: 'codex' } })]),
      'b',
      'codex',
      { mode: 'plan' },
    );
    expect(get(setAgent(claude, 'b', 'claude-code'), 'b').data.settings).toEqual({
      codex: { mode: 'plan' },
    });
    const back = setSaved(setAgent(claude, 'b', 'claude-code'), 'b', 'claude-code', {});
    expect(get(setAgent(back, 'b', 'codex'), 'b').data).not.toHaveProperty('settings');
  });
});

describe('catalog action translation', () => {
  it('translates each action to the one doing the same job, as the catalog declares jobs', () => {
    const { adapters } = TEST_CATALOG;
    for (const from of adapters) {
      for (const to of adapters) {
        for (const action of from.actions) {
          const same =
            from.id === to.id
              ? action.name
              : action.job && to.actions.find((one) => one.job === action.job)?.name;
          expect(equivalentAction(action.name, from.id, to.id, TEST_CATALOG)).toBe(same);
        }
      }
    }
  });
});

describe('catalog independence and roles', () => {
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'unknown'])(
    'keeps actions for an unavailable adapter %s, in either direction',
    (adapter) => {
      const queue = [
        { id: 'run', action: 'Bash' },
        { id: 'look', action: 'Read' },
      ];
      expect(translateActions(queue, adapter, 'codex', TEST_CATALOG)).toBe(queue);
      expect(translateActions(queue, 'claude-code', adapter, TEST_CATALOG)).toBe(queue);
    },
  );
  it('keeps unchanged branches and items identical while translating only changed actions', () => {
    const untouched = {
      id: 'if',
      if: { kind: 'failed' as const },
      then: [{ id: 'read', action: 'Read' }],
    };
    const translated = {
      id: 'loop',
      repeat: [
        { id: 'run', action: 'Bash', by: 'outside:writer' as const },
        { id: 'wait', waitFor: [{ agent: 'b' }] },
      ],
      until: { kind: 'failed' as const },
      rounds: 3,
      otherwise: 'ask' as const,
    };
    const queue = [untouched, translated];
    const result = translateActions(queue, 'claude-code', 'codex', TEST_CATALOG);
    expect(result[0]).toBe(untouched);
    expect(result[1]).toMatchObject({
      repeat: [{ id: 'run', action: 'exec_command', by: 'outside:writer' }, translated.repeat[1]],
    });
    expect(result[1] && 'repeat' in result[1] && result[1].repeat[1]).toBe(translated.repeat[1]);
  });
  it('normalises, clears and validates an independent role without copying unrelated data', () => {
    const before = doc();
    const changed = setRole(before, {
      agent: 'a',
      role: ' \n Reviewer.\n\tKeep formatting. \r\n',
    }).next;
    expect(data(changed).role).toBe('Reviewer.\n\tKeep formatting.');
    expect(data(changed).queue).toBe(data(before).queue);
    expect(changed.nodes[1]).toBe(before.nodes[1]);
    expect(setRole(changed, { agent: 'a', role: data(changed).role }).next).toBe(changed);
    expect(data(setRole(changed, { agent: 'a', role: ' \t ' }).next)).not.toHaveProperty('role');
    expect(() => setRole(before, { agent: 'a', role: 'bad\0role' })).toThrow(/role/i);
  });
});

describe('fallbackMove: corrallm’s commit of a switch or a return (B11a C2)', () => {
  /** A on Claude · Terminal at model opus, its chain Codex · Terminal at m2 high, then the SDK. */
  const chained = (): CanvasDocument => {
    const before = doc();
    const a = before.nodes[0] as AgentNode;
    return {
      ...before,
      nodes: [
        {
          ...a,
          data: {
            ...a.data,
            adapter: 'claude-code',
            connection: 'claude-code.terminal',
            settings: {
              'claude-code': { model: 'opus' },
              codex: { model: 'm1', mode: 'read-only' },
            },
            fallback: {
              to: [
                { adapter: 'codex', connection: 'codex.terminal', model: 'm2', effort: 'high' },
                { adapter: 'claude-code', connection: 'claude-code.sdk' },
              ],
              back: 'return',
            },
          },
        },
        ...before.nodes.slice(1),
      ],
    };
  };
  const OWN = { adapter: 'claude-code', connection: 'claude-code.terminal', model: 'opus' };

  it('runs the step, writing its model and effort, keeping what they replace and where it came from', () => {
    const before = chained();
    const next = fallbackMove(
      before,
      { agent: 'a', step: 0, why: 'usage-limit', at: 5 },
      context,
    ).next;
    expect(data(next)).toMatchObject({
      adapter: 'codex',
      connection: 'codex.terminal',
      settings: {
        'claude-code': { model: 'opus' },
        codex: { model: 'm2', effort: 'high', mode: 'read-only' },
      },
      fallback: {
        on: { step: 0, from: OWN, kept: { model: 'm1', effort: null }, why: 'usage-limit', at: 5 },
      },
    });
    // The queue is never rewritten (C9), and nothing else of the agent's changes.
    expect(data(next).queue).toBe(data(before).queue);
    expect(data(next).fallback?.to).toEqual(data(before).fallback?.to);
    expect(next.nodes[1]).toBe(before.nodes[1]);
  });

  it('leaving a step, puts back what it kept, only where corrallm’s value still is', () => {
    const on = fallbackMove(chained(), { agent: 'a', step: 0, why: 'rule', at: 5 }, context).next;
    // You changed its effort since: yours stays.
    const edited = setSettings(on, {
      agent: 'a',
      adapter: 'codex',
      change: { effort: 'low' },
    }).next;
    const next = fallbackMove(
      edited,
      { agent: 'a', step: 1, why: 'usage-limit', at: 9 },
      context,
    ).next;
    expect(data(next)).toMatchObject({
      adapter: 'claude-code',
      connection: 'claude-code.sdk',
      settings: { 'claude-code': { model: 'opus' }, codex: { model: 'm1', effort: 'low' } },
      fallback: { on: { step: 1, from: OWN, why: 'usage-limit', at: 9 } },
    });
    // The SDK step names no model: it runs the agent's saved one, and keeps nothing.
    expect(data(next).fallback?.on).not.toHaveProperty('kept');
  });

  it('returns to its own endpoint: what corrallm wrote put back, its place forgotten', () => {
    const on = fallbackMove(chained(), { agent: 'a', step: 0, why: 'rule', at: 5 }, context).next;
    const back = fallbackMove(on, { agent: 'a', step: null, why: 'rule', at: 7 }, context).next;
    expect(data(back)).toMatchObject({
      adapter: 'claude-code',
      connection: 'claude-code.terminal',
      settings: { 'claude-code': { model: 'opus' }, codex: { model: 'm1', mode: 'read-only' } },
    });
    expect(data(back).settings?.codex).not.toHaveProperty('effort');
    expect(data(back).fallback).toEqual(data(chained()).fallback);
    // Already on it: nothing changes.
    expect(fallbackMove(back, { agent: 'a', step: null, why: 'rule', at: 8 }, context).next).toBe(
      back,
    );
  });

  it('switches between models of one CLI, putting the first back on return', () => {
    const before = chained();
    const a = before.nodes[0] as AgentNode;
    const same: CanvasDocument = {
      ...before,
      nodes: [
        {
          ...a,
          data: {
            ...a.data,
            fallback: {
              to: [{ adapter: 'claude-code', connection: 'claude-code.terminal', model: 'sonnet' }],
            },
          },
        },
        ...before.nodes.slice(1),
      ],
    };
    const on = fallbackMove(same, { agent: 'a', step: 0, why: 'usage-limit', at: 1 }, context).next;
    expect(data(on).settings?.['claude-code']).toEqual({ model: 'sonnet' });
    expect(data(on).fallback?.on).toMatchObject({ from: OWN, kept: { model: 'opus' } });
    const back = fallbackMove(on, { agent: 'a', step: null, why: 'rule', at: 2 }, context).next;
    expect(data(back).settings?.['claude-code']).toEqual({ model: 'opus' });
  });

  it('refuses an agent with no chain, or a step it doesn’t have', () => {
    expect(() => fallbackMove(doc(), { agent: 'a', step: 0, why: 'rule', at: 1 }, context)).toThrow(
      /chain/,
    );
    expect(() =>
      fallbackMove(chained(), { agent: 'a', step: 2, why: 'rule', at: 1 }, context),
    ).toThrow(/step/);
  });
});
