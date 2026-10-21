import { expect, it } from 'vitest';
import { NEW_SESSION } from '../../shared/model/session';
import type { CanvasNode } from '../../shared/model/canvas';
import type { Run } from '../../shared/engine/run/runner';
import { runCatalog } from './agents';
import { agentCard, agentStatus } from './agent-status';

const nodes: CanvasNode[] = [
  {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      label: 'Writer',
      queue: [
        { id: 'done', message: 'First' },
        { id: 'current', message: 'Make the tests pass' },
        { id: 'blank', message: '' },
      ],
    },
  },
];
it('uses the dock’s live-session, needs and pause precedence for cards too', () => {
  const run: Run = { running: true, agents: { a: { status: 'done', outcomes: {} } } };
  expect(agentStatus('a', {}, run, new Set())).toBe('Done');
  expect(agentStatus('a', { a: { ...NEW_SESSION, status: 'working' } }, run, new Set())).toBe(
    'Working',
  );
  expect(agentStatus('a', { a: { ...NEW_SESSION, status: 'working' } }, run, new Set(['a']))).toBe(
    'Needs you',
  );
  expect(agentStatus('a', {}, { ...run, paused: true }, new Set())).toBe('Done');
  expect(
    agentStatus(
      'a',
      {},
      {
        running: false,
        agents: { a: { status: 'asking', current: 'current', paused: true, outcomes: {} } },
      },
      new Set(),
    ),
  ).toBe('Paused');
});
it('shows the actual current task and finished queue marks, excluding blank items', () => {
  const run: Run = {
    running: true,
    agents: { a: { status: 'running', current: 'current', outcomes: { done: 'succeeded' } } },
  };
  expect(agentCard('a', nodes, {}, run, new Set(), runCatalog())).toEqual({
    status: 'Working',
    line: 'Working · Message “Make the tests pass”',
    completed: 1,
    total: 2,
  });
  expect(
    agentCard(
      'a',
      nodes,
      {},
      {
        running: false,
        agents: { a: { status: 'done', outcomes: { done: 'succeeded', current: 'skipped' } } },
      },
      new Set(),
      runCatalog(),
    ),
  ).toMatchObject({ status: 'Done', completed: 2, total: 2 });
});
it('keeps a paused held question lit and shows a failed turn’s reason', () => {
  const run: Run = {
    running: false,
    paused: true,
    agents: {
      a: {
        status: 'asking',
        current: 'current',
        problem: { kind: 'failed', agent: 'a', text: 'The command failed.', reason: 'error' },
        outcomes: { done: 'failed' },
      },
    },
  };
  expect(agentCard('a', nodes, {}, run, new Set(['a']), runCatalog())).toMatchObject({
    status: 'Needs you',
    line: 'Needs you · The command failed.',
    completed: 1,
    total: 2,
  });
});
