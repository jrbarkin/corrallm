import { describe, expect, it } from 'vitest';

import { MADE_UP } from '../test-made-up';
import { adapterIn } from '../adapter';
import { TEST_CATALOG } from '../test-model';
import type { CanvasDocument, AgentNode } from './canvas';
import {
  fillTemplate,
  placeholdersOf,
  withAgents as chooseAgents,
  withConnections as chooseConnections,
} from './templates';
type Graph = Pick<CanvasDocument, 'links'> & { nodes: AgentNode[] };
const context = { catalog: TEST_CATALOG, defaultAdapter: 'claude-code' };
const withAgents = (graph: Graph, types: Readonly<Record<string, string | undefined>>) =>
  chooseAgents(graph, types, context);
const withConnections = (graph: Graph, connections: Readonly<Record<string, string>>) =>
  chooseConnections(graph, connections, context, { defaults: false });
const defaultConnection = (adapter: string) =>
  adapterIn(TEST_CATALOG, adapter)?.connections[0]?.id ?? 'unavailable';
const template: Graph = {
  nodes: [
    {
      id: 'tests',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        label: '{{language}} tester',
        adapter: 'codex',
        queue: [
          { id: 'write', message: 'Write failing tests for {{feature}} in {{language}}.' },
          {
            id: 'red',
            if: { kind: 'freeText', text: 'a test for {{feature}} passes already' },
            then: [
              { id: 'fix', message: 'Make the tests for {{feature}} fail first.', target: 'x' },
            ],
          },
          { id: 'run', action: 'exec_command', instruction: 'Run the tests for {{feature}}.' },
          { id: 'ok', approve: 'the tests for {{feature}}' },
          {
            id: 'loop',
            repeat: [
              { id: 'green', message: 'Make the {{framework}} tests pass.' },
              { id: 'check', action: 'exec_command', instruction: 'Run {{framework}}.' },
            ],
            until: { kind: 'outputContains', text: '{{marker}}' },
            rounds: 3,
            otherwise: 'ask',
          },
        ],
      },
    },
  ],
  links: [],
};

describe('templates', () => {
  it('attributes only text filled by a party, including conditions and nested steps', () => {
    const filled = fillTemplate(
      template,
      {
        feature: 'export',
        language: 'TypeScript',
        framework: 'Vitest',
        marker: 'DONE',
      },
      'outside:builder',
    );
    const queue = filled.nodes[0]?.data.queue ?? [];
    for (const item of queue) {
      expect(item.by).toBe('outside:builder');
      const children = 'then' in item ? item.then : 'repeat' in item ? item.repeat : [];
      for (const child of children) expect(child.by).toBe('outside:builder');
    }
    expect(fillTemplate(template, {}, 'outside:builder')).toBe(template);
    const nested = fillTemplate(template, { framework: 'Vitest' }, 'agent:lead').nodes[0]?.data
      .queue?.[4];
    expect(nested).not.toHaveProperty('by');
    expect(nested && 'repeat' in nested && nested.repeat[0]).toMatchObject({ by: 'agent:lead' });
    const yours = fillTemplate(filled, { feature: 'mine' }, 'you');
    expect(yours).toBe(filled);
    const authored = {
      ...template,
      nodes: template.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          queue: [{ id: 'new', message: '{{feature}}', by: 'outside:other' as const }],
        },
      })),
    };
    expect(
      fillTemplate(authored, { feature: 'Mine' }, 'you').nodes[0]?.data.queue[0],
    ).not.toHaveProperty('by');
  });
  it('lists the placeholders a canvas uses, in the order they first appear', () => {
    // Inside repeats too: their messages, and the text they stop on.
    expect(placeholdersOf(template)).toEqual(['language', 'feature', 'framework', 'marker']);
    // An OK's words are text that may have a blank in it.
    const asking: Graph = {
      nodes: template.nodes.map((n) => ({
        ...n,
        data: { label: 'Planner', queue: [{ id: 'ok', approve: 'the plan in {{file}}' }] },
      })),
      links: [],
    };
    expect(placeholdersOf(asking)).toEqual(['file']);
  });

  it("fills every placeholder in agents' names, messages, steps' instructions, conditions and OKs, leaving others", () => {
    const filled = fillTemplate(template, {
      feature: 'rate limiting',
      language: 'Go',
      framework: 'go test',
      marker: 'PASS',
    });
    const [tester] = filled.nodes;
    expect(tester?.data.label).toBe('Go tester');
    expect(tester?.data.queue).toEqual([
      { id: 'write', message: 'Write failing tests for rate limiting in Go.' },
      {
        id: 'red',
        if: { kind: 'freeText', text: 'a test for rate limiting passes already' },
        then: [{ id: 'fix', message: 'Make the tests for rate limiting fail first.', target: 'x' }],
      },
      { id: 'run', action: 'exec_command', instruction: 'Run the tests for rate limiting.' },
      { id: 'ok', approve: 'the tests for rate limiting' },
      {
        id: 'loop',
        repeat: [
          { id: 'green', message: 'Make the go test tests pass.' },
          { id: 'check', action: 'exec_command', instruction: 'Run go test.' },
        ],
        until: { kind: 'outputContains', text: 'PASS' },
        rounds: 3,
        otherwise: 'ask',
      },
    ]);
    // Placeholders without a value stay as they are.
    expect(fillTemplate(template, { feature: 'search' }).nodes[0]?.data.label).toBe(
      '{{language}} tester',
    );
  });
});

describe('withAgents', () => {
  const pinned: Graph = {
    nodes: [
      {
        id: 'tester',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'Tester',
          adapter: 'codex',
          queue: [
            { id: 'run', action: 'exec_command', expect: 'fails' },
            { id: 'diff', action: '/diff' },
            {
              id: 'red',
              if: { kind: 'failed' },
              then: [{ id: 'patch', action: 'apply_patch' }],
            },
            { id: 'ok', approve: '' },
            {
              id: 'loop',
              repeat: [
                { id: 'green', action: 'exec_command' },
                { id: 'w', waitFor: [{ agent: 'any' }] },
              ],
              until: { kind: 'succeeded' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        },
      },
      {
        id: 'any',
        type: 'agent',
        position: { x: 0, y: 100 },
        data: { label: 'Any', queue: [{ id: 'run', action: 'Bash' }] },
      },
    ],
    links: [],
  };

  it('gives each agent its chosen type, its steps the same job in that type where there is one', () => {
    const [tester, any] = withAgents(pinned, { tester: 'claude-code', any: 'gemini' }).nodes;
    expect(tester?.data.adapter).toBe('claude-code');
    // Codex's /diff has no Claude equivalent: it stays, for the user to see and change.
    expect(tester?.data.queue).toEqual([
      // What it is expected to do goes with it.
      { id: 'run', action: 'Bash', expect: 'fails' },
      { id: 'diff', action: '/diff' },
      { id: 'red', if: { kind: 'failed' }, then: [{ id: 'patch', action: 'Edit' }] },
      { id: 'ok', approve: '' },
      // Inside a repeat too.
      {
        id: 'loop',
        repeat: [
          { id: 'green', action: 'Bash' },
          { id: 'w', waitFor: [{ agent: 'any' }] },
        ],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
    ]);
    // An adapter this build lacks declares no actions: its steps stay as they were.
    expect(any?.data).toEqual({
      label: 'Any',
      adapter: 'gemini',
      queue: [{ id: 'run', action: 'Bash' }],
    });
  });

  it('leaves an agent left open without a type, to be the default agent', () => {
    const [tester] = withAgents(pinned, { tester: undefined }).nodes;
    expect(tester?.data.adapter).toBeUndefined();
    expect(tester?.data.queue?.[0]).toEqual({ id: 'run', action: 'Bash', expect: 'fails' });
  });
});

describe('withConnections', () => {
  const crew: Graph = {
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'A', adapter: 'claude-code' },
      },
      {
        id: 'b',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'B', adapter: 'codex', connection: 'codex.app-server' },
      },
      { id: 'c', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'C' } },
      { id: 'd', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'D', adapter: 'gemini' } },
    ],
    links: [],
  };

  it('runs each agent as chosen, if its type runs that way; others keep theirs', () => {
    const run = withConnections(crew, {
      a: 'claude-code.terminal',
      b: 'codex.terminal',
      c: 'claude-code.terminal',
      d: 'codex.terminal',
    });
    expect(run.nodes.map((n) => n.data.connection)).toEqual([
      'claude-code.terminal',
      'codex.terminal',
      // An agent left to the default agent (Claude) runs as Claude does.
      'claude-code.terminal',
      // Gemini has no connector yet; an invalid connection never makes it runnable.
      undefined,
    ]);
    expect(withConnections(crew, { a: 'claude-code.sdk' }).nodes[1]?.data.connection).toBe(
      'codex.app-server',
    );
  });

  it('defaults to real terminals and keeps unsupported types unavailable', () => {
    expect(defaultConnection('claude-code')).toBe('claude-code.terminal');
    expect(defaultConnection('codex')).toBe('codex.terminal');
    expect(defaultConnection('qwen')).toBe('unavailable');
    expect(defaultConnection('gemini')).toBe('unavailable');
  });
});

it('preserves every unchanged item and returns the same canvas for no-op template choices', () => {
  expect(fillTemplate(template, {})).toBe(template);
  expect(withAgents(template, {})).toBe(template);
  expect(withConnections(template, {})).toBe(template);
  const changed = fillTemplate(template, { feature: 'New' });
  expect(changed.links).toBe(template.links);
  expect(changed.nodes[0]?.position).toBe(template.nodes[0]?.position);
  expect(changed.nodes[0]?.data.queue?.[4]).toBe(template.nodes[0]?.data.queue?.[4]);
});

it('chooses an adapter and its first connection from the supplied catalog alone', () => {
  const catalog = { ...TEST_CATALOG, adapters: [...TEST_CATALOG.adapters, ...MADE_UP.adapters] };
  const context = { catalog, defaultAdapter: 'zed' };
  const doc: Graph = {
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'A', adapter: 'claude-code', queue: [{ id: 's', action: 'Bash' }] },
      },
    ],
    links: [],
  };
  const chosen = chooseAgents(doc, { a: 'zed' }, context);
  expect(chosen.nodes[0]?.data.queue).toEqual([{ id: 's', action: 'shell' }]);
  const first = adapterIn(catalog, 'zed')?.connections[0]?.id;
  if (!first) throw new Error('no first connection');
  const connected = chooseConnections(chosen, { a: first }, context);
  expect(connected.nodes[0]?.data.connection).toBe('zed.acp');
  expect(chooseConnections(connected, { a: first }, context)).toBe(connected);
  expect(chooseAgents(chosen, { a: 'zed' }, context)).toBe(chosen);
});

it('fills omitted connections from each adapter’s first, even if a template saved another', () => {
  const context = { catalog: MADE_UP, defaultAdapter: 'zed' };
  const doc: Graph = {
    nodes: [
      { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } },
      {
        id: 'b',
        type: 'agent',
        position: { x: 400, y: 0 },
        data: { label: 'B', adapter: 'zed', connection: 'zed.free' },
      },
    ],
    links: [],
  };
  const filled = chooseConnections(doc, {}, context);
  expect(filled.nodes.map((node) => node.data.connection)).toEqual(['zed.acp', 'zed.acp']);
  expect(chooseConnections(filled, {}, context)).toBe(filled);
});
