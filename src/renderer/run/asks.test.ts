import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import type { UsageHold } from '../usage/usage';
import { answersOf, heldAsks, usageAnswers } from './asks';
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

describe('a repeat out of rounds', () => {
  const coder = agent('c', 'Coder', [
    {
      id: 'loop',
      repeat: [{ id: 'build', message: 'Build it' }],
      until: { kind: 'outputContains', text: 'APPROVED' },
      rounds: 3,
      otherwise: 'ask',
    },
  ]);

  it('asks for one more round, or to go on, or what to try next', () => {
    const run: Run = {
      running: true,
      agents: { c: { ...at('loop', 'asking'), rounds: { loop: { round: 3 } } } },
    };
    const [ask] = heldAsks([coder], run);
    expect([ask?.item.id, ask?.text, ask?.detail]).toEqual([
      'loop',
      '3 rounds done, and still not: the output contains “APPROVED”.',
      undefined,
    ]);
    expect(ask?.choices).toEqual([
      { key: 'more', label: 'One more round', primary: true },
      { key: 'goOn', label: 'Go on', title: 'End the repeat as failed and carry on' },
    ]);
    expect(ask?.reply).toEqual({ label: 'What should it try next?', button: 'Try this' });
    // One round: said so.
    const once: Run = {
      running: true,
      agents: { c: { ...at('loop', 'asking'), rounds: { loop: { round: 1 } } } },
    };
    expect(heldAsks([coder], once)[0]?.text).toBe(
      '1 round done, and still not: the output contains “APPROVED”.',
    );
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

describe('a usage rule that pauses and asks', () => {
  const coder = agent('c', 'Coder', [
    { id: 'tests', message: 'Write the tests for the parser' },
    { id: 'if', if: { kind: 'failed' }, then: [{ id: 'fix', action: 'Edit' }] },
  ]);
  const hold: UsageHold = {
    backend: 'Claude',
    window: 'fiveHour',
    percent: 80,
    used: 84,
    resetsAt: new Date(2026, 9, 12, 15, 40).getTime(),
  };
  const held = (current: string, usage = hold): Run => ({
    running: true,
    agents: { c: { current, status: 'asking', outcomes: {}, usage } },
  });

  it('asks whether to go on, before the task it holds, saying when the window resets', () => {
    const now = new Date(2026, 9, 12, 12, 0).getTime();
    const [ask] = heldAsks([coder], held('tests'), now);
    expect(ask?.text).toBe('Claude has used 84% of its 5-hour window (over 80%). Go on?');
    expect(ask?.detail).toMatch(/^Before “Write the tests for the…” · resets 3:40\sPM$/);
    expect(ask?.choices.map((choice) => choice.key)).toEqual(['goOn', 'wait', 'stop']);
    expect(ask?.reply).toBeUndefined();
    // A step in an if-then is held as well.
    expect(heldAsks([coder], held('fix'), now)[0]?.item.id).toBe('fix');
  });

  it('offers no wait for a reset it does not know', () => {
    expect(usageAnswers({ ...hold, resetsAt: null }).choices.map((c) => c.key)).toEqual([
      'goOn',
      'stop',
    ]);
    expect(heldAsks([coder], held('tests', { ...hold, resetsAt: null }))[0]?.detail).toBe(
      'Before “Write the tests for the…”',
    );
  });
});
