import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { answersOf, heldAsks } from './asks';
import type { AgentRun, Run } from './runner';

const agent = (id: string, label: string, queue: QueueItem[]): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label, queue },
});

const planner = agent('p', 'Planner', [
  { id: 'spec', message: 'Before any code, write a spec for this to SPEC.md' },
  { id: 'pause', delay: { seconds: 60 } },
  { id: 'ok', approve: 'the spec in SPEC.md' },
]);
const builder = agent('b', 'Builder', [{ id: 'check', approve: '' }]);
const reviewer = agent('r', 'Reviewer', [{ id: 'fine', approve: 'the review' }]);

const at = (current: string, status: AgentRun['status']): AgentRun => ({
  current,
  status,
  outcomes: {},
});

describe('heldAsks', () => {
  it('lists the OKs a running run holds, in graph order, with the work each comes after', () => {
    const run: Run = {
      running: true,
      // Not in graph order; and the Reviewer's queue was stopped at its OK.
      agents: { b: at('check', 'asking'), p: at('ok', 'asking'), r: at('fine', 'stopped') },
    };
    const asks = heldAsks([planner, builder, reviewer], run);
    expect(asks.map((ask) => [ask.agent.id, ask.item.id, ask.text, ask.detail])).toEqual([
      // A delay between the two only pauses: the OK is on the message before it.
      ['p', 'ok', 'Your OK on the spec in SPEC.md?', 'After “Before any code, write…”'],
      ['b', 'check', 'Your OK on the work before it?', undefined],
    ]);
    expect(asks[0]?.choices.map((choice) => choice.key)).toEqual(['approve', 'stop']);
  });

  it('lists nothing while the agent works on the changes asked for, or once the run stops', () => {
    expect(heldAsks([planner], { running: true, agents: { p: at('ok', 'running') } })).toEqual([]);
    expect(heldAsks([planner], { running: false, agents: { p: at('ok', 'asking') } })).toEqual([]);
    // An agent deleted while it was held is no longer asked about.
    expect(heldAsks([], { running: true, agents: { p: at('ok', 'asking') } })).toEqual([]);
  });
});

describe('answersOf', () => {
  it('answers an OK with Approve, Stop here, or the changes to make', () => {
    expect(answersOf({ id: 'ok', approve: '' })).toEqual({
      choices: [
        { key: 'approve', label: 'Approve', primary: true },
        {
          key: 'stop',
          label: 'Stop here',
          title: 'Stop this queue here, and whatever waits on it',
        },
      ],
      reply: { label: 'What should change?', button: 'Ask for changes' },
    });
    expect(answersOf({ id: 'step', action: 'Read' })).toBeUndefined();
  });
});
