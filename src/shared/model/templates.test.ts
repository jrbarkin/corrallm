import { describe, expect, it } from 'vitest';

import type { CanvasDocument, AgentNode } from './canvas';
import { fillTemplate, placeholdersOf } from './templates';
type Graph = Pick<CanvasDocument, 'links'> & { nodes: AgentNode[] };
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

it('preserves every unchanged item and returns the same canvas for an empty fill', () => {
  expect(fillTemplate(template, {})).toBe(template);
  const changed = fillTemplate(template, { feature: 'New' });
  expect(changed.links).toBe(template.links);
  expect(changed.nodes[0]?.position).toBe(template.nodes[0]?.position);
  expect(changed.nodes[0]?.data.queue?.[4]).toBe(template.nodes[0]?.data.queue?.[4]);
});
