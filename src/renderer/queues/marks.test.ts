import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import type { AgentRun } from '../run/runner';
import { lanesOf } from './lanes';
import { queueMarks } from './marks';

const agent = (id: string, queue: QueueItem[]): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

const layout = lanesOf([
  agent('a', [
    { id: 'build', message: 'Build it' },
    { id: 'ok', approve: '' },
  ]),
  agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'ok' }] }]),
]);
const marksOf = (a: AgentRun, { running = true, asking = [] as string[] } = {}) =>
  queueMarks(layout, { running, agents: { a } }, new Set(asking));

describe('queueMarks', () => {
  it.each(['queued', 'running', 'completed', 'failed', 'cancelled'] as const)(
    'marks a submitted message %s independently of the workflow run',
    (status) => {
      const live = lanesOf([
        agent('a', [
          {
            id: 'live',
            message: 'Check it',
            submission: {
              id: 'm1',
              text: 'Check it',
              status,
            },
          },
        ]),
      ]);
      const marks = queueMarks(live, { running: false, agents: {} }, new Set(['a']));
      expect(marks('a', 'live')['data-run']).toBe(status);
      expect(marks('a', 'live')['data-decide']).toBeUndefined();
    },
  );

  it('marks an OK, and the row the run holds for the user to decide at', () => {
    const marks = marksOf({
      current: 'ok',
      status: 'asking',
      outcomes: { build: 'succeeded' },
      changes: { ok: ['Cover the empty state', 'And the error state'] },
    });
    expect(marks('a', 'ok')).toMatchObject({
      'data-mark': 'ok',
      'data-waited-for': '',
      'data-run': 'asking',
      'data-decide': '',
      'data-asked': 'And the error state',
      'data-asked-times': '2',
    });
    expect(marks('a', 'build')['data-decide']).toBeUndefined();
    expect(marks('b', 'w')['data-mark']).toBe('wait');
  });

  it('marks a task a usage rule holds: why, and what the user can decide there', () => {
    const usage = {
      backend: 'Claude',
      window: 'fiveHour',
      percent: 80,
      used: 84,
      resetsAt: 7_200_000,
    } as const;
    const asking = marksOf({ current: 'build', status: 'asking', outcomes: {}, usage });
    expect(asking('a', 'build')).toMatchObject({
      'data-run': 'asking',
      'data-decide': '',
      'data-usage': 'Claude has used 84% of its 5-hour window (over 80%)',
      'data-usage-backend': 'Claude',
      'data-usage-reset': '7200000',
    });
    expect(asking('a', 'ok')['data-usage']).toBeUndefined();
    const waiting = marksOf({
      current: 'build',
      status: 'waiting',
      until: 7_200_000,
      outcomes: {},
      usage: { ...usage, resetsAt: 7_200_000 },
    });
    expect(waiting('a', 'build')).toMatchObject({
      'data-run': 'waiting',
      'data-until': '7200000',
      'data-decide': undefined,
      'data-usage': 'Claude has used 84% of its 5-hour window (over 80%): waiting for it to reset',
    });
  });

  it('marks how a step expected to fail went against what was expected, once judged', () => {
    const red = lanesOf([
      agent('a', [
        { id: 'red', action: 'Bash', expect: 'fails' },
        { id: 'again', action: 'Bash', expect: 'fails' },
        { id: 'broken', action: 'Bash', expect: 'fails' },
      ]),
    ]);
    const marks = queueMarks(
      red,
      {
        running: false,
        agents: {
          a: {
            status: 'done',
            outcomes: { red: 'succeeded', again: 'failed', broken: 'failed' },
            asExpected: { red: true, again: false },
          },
        },
      },
      new Set(),
    );
    expect(marks('a', 'red')).toMatchObject({ 'data-run': 'succeeded', 'data-expected': 'met' });
    expect(marks('a', 'again')).toMatchObject({ 'data-run': 'failed', 'data-expected': 'unmet' });
    // Its turn failed: it did not run as asked, so it went neither way.
    expect(marks('a', 'broken')).toMatchObject({
      'data-run': 'failed',
      'data-expected': undefined,
    });
  });

  it('leaves a decision to the run alone: not while its agent asks permission, nor once stopped', () => {
    // A permission prompt in a task, or in the turn that makes the changes asked for at the OK.
    const task = marksOf({ current: 'build', status: 'running', outcomes: {} }, { asking: ['a'] });
    expect(task('a', 'build')).toMatchObject({ 'data-run': 'asking', 'data-decide': undefined });
    const changing = marksOf(
      { current: 'ok', status: 'running', outcomes: {}, changes: { ok: ['More tests'] } },
      { asking: ['a'] },
    );
    expect(changing('a', 'ok')).toMatchObject({
      'data-run': 'asking',
      'data-decide': undefined,
      'data-asked': 'More tests',
      'data-asked-times': undefined,
    });
    const stopped = marksOf({ current: 'ok', status: 'asking', outcomes: {} }, { running: false });
    expect(stopped('a', 'ok')).toMatchObject({ 'data-run': 'stopped', 'data-decide': undefined });
  });

  describe('a repeat', () => {
    const looped = lanesOf([
      agent('a', [
        {
          id: 'loop',
          repeat: [
            { id: 'fix', message: 'Make the tests pass' },
            { id: 'w', waitFor: [{ agent: 'b' }] },
          ],
          until: { kind: 'succeeded' },
          rounds: 3,
          otherwise: 'ask',
        },
      ]),
      agent('b', [{ id: 'build', action: 'Edit' }]),
    ]);
    const marks = (a: AgentRun) => queueMarks(looped, { running: true, agents: { a } }, new Set());

    it('says which round it is on while the run is in it, and how many it took once over', () => {
      const inside = marks({
        current: 'fix',
        status: 'running',
        outcomes: {},
        rounds: { loop: { round: 2 } },
      });
      expect(inside('a', 'loop')['data-round']).toBe('Round 2 of 3');
      expect(inside('a', 'fix')['data-run']).toBe('running');
      // A wait in it is marked as a wait.
      expect(inside('a', 'w')['data-mark']).toBe('wait');
      // Rounds the user added count too.
      const more = marks({
        current: 'w',
        status: 'waiting',
        outcomes: {},
        rounds: { loop: { round: 4, more: 1 } },
      });
      expect(more('a', 'loop')['data-round']).toBe('Round 4 of 4');
      const over = marks({
        status: 'done',
        outcomes: { loop: 'succeeded' },
        rounds: { loop: { round: 2 } },
      });
      expect(over('a', 'loop')).toMatchObject({
        'data-round': '2 rounds',
        'data-run': 'succeeded',
      });
      const once = marks({
        status: 'done',
        outcomes: { loop: 'failed' },
        rounds: { loop: { round: 1 } },
      });
      expect(once('a', 'loop')['data-round']).toBe('1 round');
      // Not reached yet: no rounds to tell.
      expect(marks({ status: 'done', outcomes: {} })('a', 'loop')['data-round']).toBeUndefined();
    });

    it('asks the user to decide once it is out of rounds', () => {
      const asking = marks({
        current: 'loop',
        status: 'asking',
        outcomes: {},
        rounds: { loop: { round: 3 } },
      });
      expect(asking('a', 'loop')).toMatchObject({
        'data-run': 'asking',
        'data-decide': '',
        'data-round': 'Round 3 of 3',
      });
    });
  });

  it("counts a follower's rounds as its leader's, and marks repeats following each other stuck", () => {
    const repeat = (id: string, agent: string, item: string, rounds: number): QueueItem => ({
      id,
      repeat: [{ id: `${id}-step`, action: 'Read' }],
      until: { kind: 'repeatEnds', agent, item },
      rounds,
      otherwise: 'ask',
    });
    const leader: QueueItem = {
      id: 'lead',
      repeat: [{ id: 'work', action: 'Edit' }],
      until: { kind: 'succeeded' },
      rounds: 4,
      otherwise: 'ask',
    };
    const marks = queueMarks(
      lanesOf([agent('a', [leader]), agent('b', [repeat('follow', 'a', 'lead', 1)])]),
      {
        running: true,
        agents: {
          a: {
            current: 'work',
            status: 'running',
            outcomes: {},
            rounds: { lead: { round: 2, more: 1 } },
          },
          b: {
            current: 'follow',
            status: 'waiting',
            outcomes: {},
            rounds: { follow: { round: 2 } },
          },
        },
      },
      new Set(),
    );
    expect(marks('b', 'follow')).toMatchObject({
      'data-round': 'Round 2 of 5',
      'data-run': 'waiting',
    });
    expect(marks('b', 'follow')['data-mark']).toBeUndefined();

    const stuck = queueMarks(
      lanesOf([agent('a', [repeat('r', 'b', 'r', 3)]), agent('b', [repeat('r', 'a', 'r', 3)])]),
      { running: false, agents: {} },
      new Set(),
    );
    expect([stuck('a', 'r')['data-mark'], stuck('b', 'r')['data-mark']]).toEqual([
      'stuck',
      'stuck',
    ]);
  });
});
