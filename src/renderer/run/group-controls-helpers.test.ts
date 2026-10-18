import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import { groupControlText, groupPaused, individualPaused } from './controls';
import type { AgentRun, Run } from './runner';

const node = (id: string, type: 'agent' | 'frame', parentId?: string): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id },
  ...(parentId === undefined ? {} : { parentId }),
});
const agent = (extra: Partial<AgentRun> = {}): AgentRun => ({
  status: 'waiting',
  outcomes: {},
  ...extra,
});
const run = (agents: Run['agents']): Run => ({ running: true, agents });

describe('pause causes', () => {
  it('reads old agent pause flags until explicit cause arrays are present', () => {
    const legacy = run({ a: agent({ paused: true }), b: agent() });
    expect(individualPaused(legacy, 'a')).toBe(true);
    expect(individualPaused(legacy, 'b')).toBe(false);
    expect(individualPaused(legacy, 'missing')).toBe(false);
    expect(groupPaused(legacy, 'team')).toBe(false);

    expect(individualPaused({ ...legacy, individualPauses: [] }, 'a')).toBe(false);
    expect(individualPaused({ ...legacy, groupPauses: ['team'] }, 'a')).toBe(false);
    expect(individualPaused({ ...legacy, groupPauses: [] }, 'a')).toBe(false);
    expect(individualPaused({ ...legacy, individualPauses: ['b'] }, 'b')).toBe(true);
  });

  it('keeps an individual pause distinct from a group pause', () => {
    const state = {
      ...run({ a: agent({ paused: true }), b: agent({ paused: true }) }),
      individualPauses: ['a'],
      groupPauses: ['team'],
    };
    expect(individualPaused(state, 'a')).toBe(true);
    expect(individualPaused(state, 'b')).toBe(false);
    expect(groupPaused(state, 'team')).toBe(true);
    expect(groupPaused(state, 'other')).toBe(false);
  });
});

describe('group pause text', () => {
  const nodes = [
    node('team', 'frame'),
    node('lead', 'agent', 'team'),
    node('worker', 'agent', 'lead'),
    node('outside', 'agent'),
    node('empty', 'frame'),
  ];

  it('shows only the pause belonging to that group', () => {
    const state = {
      ...run({ lead: agent({ paused: true }), worker: agent({ paused: true }) }),
      individualPauses: ['lead', 'worker'],
      groupPauses: ['team'],
    };
    expect(groupControlText(nodes, state, 'team')).toBe('Paused');
    expect(groupControlText(nodes, state, 'lead')).toBeUndefined();
    expect(groupControlText(nodes, state, 'empty')).toBeUndefined();
  });

  it('waits for an unfinished member turn, including an agent parent', () => {
    const active = agent({ paused: true, status: 'running', current: 'task' });
    const state = {
      ...run({ lead: active, worker: agent({ paused: true }) }),
      groupPauses: ['lead'],
    };
    expect(groupControlText(nodes, state, 'lead')).toBe('Pausing');
    expect(
      groupControlText(
        nodes,
        {
          ...state,
          agents: { lead: { ...active, outcomes: { task: 'succeeded' } } },
        },
        'lead',
      ),
    ).toBe('Paused');
  });

  it('ignores active nonmembers and treats held or absent member queues as paused', () => {
    const state = {
      ...run({
        lead: agent({ paused: true, status: 'asking', current: 'review' }),
        outside: agent({ paused: true, status: 'running', current: 'other' }),
      }),
      groupPauses: ['team', 'empty'],
    };
    expect(groupControlText(nodes, state, 'team')).toBe('Paused');
    expect(groupControlText(nodes, state, 'empty')).toBe('Paused');
  });
});
