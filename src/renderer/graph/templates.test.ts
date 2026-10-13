import { describe, expect, it } from 'vitest';

import { AGENT_ACTIONS, defaultConnection, EQUIVALENT_ACTIONS } from './agents';
import type { AgentType } from './agents';
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
        agent: 'Codex',
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
          agent: 'Codex',
          queue: [
            { id: 'run', action: 'exec_command' },
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
    const [tester, any] = withAgents(pinned, { tester: 'Claude', any: 'Gemini' }).nodes;
    expect(tester?.data.agent).toBe('Claude');
    // Codex's /diff has no Claude equivalent: it stays, for the user to see and change.
    expect(tester?.data.queue).toEqual([
      { id: 'run', action: 'Bash' },
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
    expect(any?.data).toEqual({
      label: 'Any',
      agent: 'Gemini',
      queue: [{ id: 'run', action: 'run_shell_command' }],
    });
  });

  it('leaves an agent left open without a type, to be the default agent', () => {
    const [tester] = withAgents(pinned, { tester: undefined }).nodes;
    expect(tester?.data.agent).toBeUndefined();
    expect(tester?.data.queue?.[0]).toEqual({ id: 'run', action: 'Bash' });
  });

  it('only names, as equivalents, actions each agent type has', () => {
    for (const job of EQUIVALENT_ACTIONS) {
      for (const [type, action] of Object.entries(job)) {
        expect(AGENT_ACTIONS[type as AgentType].map((a) => a.name)).toContain(action);
      }
    }
  });
});

describe('withConnections', () => {
  const crew: Graph = {
    nodes: [
      { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A', agent: 'Claude' } },
      {
        id: 'b',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'B', agent: 'Codex', connection: 'app-server' },
      },
      { id: 'c', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'C' } },
      { id: 'd', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'D', agent: 'Gemini' } },
    ],
    edges: [],
  };

  it('runs each agent as chosen, if its type runs that way; others keep theirs', () => {
    const run = withConnections(crew, {
      a: 'terminal',
      b: 'simulated',
      c: 'terminal',
      d: 'codex-terminal',
    });
    expect(run.nodes.map((n) => n.data.connection)).toEqual([
      'terminal',
      undefined,
      // An agent left to the default agent (Claude) runs as Claude does.
      'terminal',
      // Gemini can only be simulated.
      undefined,
    ]);
    expect(withConnections(crew, { a: 'sdk' }).nodes[1]?.data.connection).toBe('app-server');
  });

  it('runs an agent in a Terminal by default where the user has its CLI, else simulated', () => {
    const has = { claude: true, codex: false };
    expect(defaultConnection('Claude', has)).toBe('terminal');
    expect(defaultConnection('Codex', has)).toBe('simulated');
    expect(defaultConnection('Codex', { claude: false, codex: true })).toBe('codex-terminal');
    expect(defaultConnection('Gemini', { claude: true, codex: true })).toBe('simulated');
    // Not known yet (main has not said): simulated.
    expect(defaultConnection('Claude', undefined)).toBe('simulated');
  });
});
