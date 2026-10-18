import { describe, expect, it } from 'vitest';

import { catalog } from '../catalog';
import { defaultConnection, equivalentAction } from './agents';
import type { Graph } from './graph';
import { fillTemplate, placeholdersOf, withAgents, withConnections } from './templates';
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
  edges: [],
};

describe('templates', () => {
  it('lists the placeholders a canvas uses, in the order they first appear', () => {
    // Inside repeats too: their messages, and the text they stop on.
    expect(placeholdersOf(template)).toEqual(['language', 'feature', 'framework', 'marker']);
    // An OK's words are text that may have a blank in it.
    const asking: Graph = {
      nodes: template.nodes.map((n) => ({
        ...n,
        data: { label: 'Planner', queue: [{ id: 'ok', approve: 'the plan in {{file}}' }] },
      })),
      edges: [],
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
    edges: [],
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

  it('translates each action to the one doing the same job, as the catalog declares jobs', () => {
    const { adapters } = catalog();
    for (const from of adapters) {
      for (const to of adapters) {
        for (const action of from.actions) {
          const same =
            from.id === to.id
              ? action.name
              : action.job && to.actions.find((one) => one.job === action.job)?.name;
          expect(equivalentAction(action.name, from.id, to.id)).toBe(same);
        }
      }
    }
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
    edges: [],
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
