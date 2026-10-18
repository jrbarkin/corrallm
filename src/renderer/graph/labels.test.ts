import { describe, expect, it } from 'vitest';

import type { GraphNode } from './graph';
import {
  describe as describeItem,
  expectedText,
  ifText,
  itemLabel,
  taskLabel,
  untilText,
  waitTargetLabel,
} from './labels';
import type { QueueItem, QueueRepeat } from './queue';

const agent = (id: string, label: string, queue: QueueItem[] = []): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label, queue },
});

const loop: QueueRepeat = {
  id: 'loop',
  repeat: [
    { id: 'fix', message: 'Make the tests pass, fixing the code and not the tests' },
    { id: 'tests', action: 'Bash' },
  ],
  until: { kind: 'succeeded' },
  rounds: 3,
  otherwise: 'ask',
};
const coder = agent('c', 'Coder', [loop]);

describe('untilText', () => {
  it('reads each kind of condition a repeat stops on', () => {
    expect(
      [
        { kind: 'succeeded' as const },
        { kind: 'failed' as const },
        { kind: 'outputContains' as const, text: 'APPROVED' },
        { kind: 'outputContains' as const, text: 'APPROVED', wholeLine: true },
        { kind: 'freeText' as const, text: 'the reviewer is happy' },
      ].map((until) => untilText([coder], until)),
    ).toEqual([
      'its last step succeeds',
      'its last step fails',
      'the output contains “APPROVED”',
      'the output contains “APPROVED” on a line of its own',
      'the reviewer is happy',
    ]);
  });

  it('names the repeat a repeat goes round with, or says it was removed', () => {
    const judge = agent('j', 'Judge', [{ ...loop, id: 'judging' }]);
    const follows = { kind: 'repeatEnds' as const, agent: 'j', item: 'judging' };
    expect(untilText([coder, judge], follows)).toBe("Judge's repeat ends");
    expect(untilText([coder, judge], { ...follows, item: 'gone' })).toBe('a removed repeat ends');
    expect(untilText([coder], follows)).toBe('a removed repeat ends');
    // Not a repeat: nothing to go round with.
    expect(
      untilText([coder, agent('j', 'Judge', [{ id: 'judging', action: 'Read' }])], follows),
    ).toBe('a removed repeat ends');
    // A follower runs as many rounds as its leader: its own are not named.
    expect(taskLabel([coder, judge], { ...loop, until: follows })).toBe(
      "Repeat until Judge's repeat ends",
    );
  });
});

describe('steps expected to fail, in words', () => {
  it('says so wherever the step is named, but not on its buttons', () => {
    const red = {
      id: 'red',
      action: 'Bash',
      instruction: 'Run the new tests.',
      expect: 'fails',
    } as const;
    expect(itemLabel(red)).toBe('Bash “Run the new tests.” (expected to fail)');
    expect(taskLabel([coder], { ...red, target: 'c' })).toBe(
      'Bash “Run the new tests.” (expected to fail) → Coder',
    );
    expect(itemLabel({ id: 'red', action: 'Bash', expect: 'fails' })).toBe(
      'Bash (expected to fail)',
    );
    expect(waitTargetLabel([agent('t', 'Tester', [red])], { agent: 't', item: 'red' })).toBe(
      'Tester: Bash “Run the new tests.” (expected to fail)',
    );
    expect(describeItem([coder], red)).toBe('Bash');
  });

  it('says how it went once judged: failing as expected, or passing', () => {
    expect(expectedText(true)).toBe('failed, as expected');
    expect(expectedText(false)).toBe('passed, but was expected to fail');
  });
});

describe('steps in words', () => {
  it('names a step by its action, and what it is to do when the user said', () => {
    const tests = {
      id: 's',
      action: 'Bash',
      instruction: 'run the whole test suite, slowly, twice',
    };
    expect(itemLabel(tests)).toBe('Bash “run the whole test…”');
    expect(taskLabel([coder], { ...tests, target: 'c' })).toBe(
      'Bash “run the whole test suite,…” → Coder',
    );
    expect(itemLabel({ id: 's', action: 'Bash' })).toBe('Bash');
    // Its buttons name the action alone.
    expect(describeItem([coder], tests)).toBe('Bash');
  });
});

describe('repeats in words', () => {
  it('names a repeat by when it stops and its rounds, and finds the steps inside it', () => {
    expect(taskLabel([coder], loop)).toBe('Repeat until its last step succeeds (up to 3 rounds)');
    expect(taskLabel([coder], { ...loop, rounds: 1 })).toBe(
      'Repeat until its last step succeeds (up to 1 round)',
    );
    expect(describeItem([coder], loop)).toBe('Repeat until its last step succeeds');
    expect(itemLabel(loop)).toBe('its repeat');
    // What another agent waits for, inside the repeat or the repeat itself.
    expect(waitTargetLabel([coder], { agent: 'c', item: 'fix' })).toBe(
      'Coder: “Make the tests pass,…”',
    );
    expect(waitTargetLabel([coder], { agent: 'c', item: 'loop' })).toBe('Coder: its repeat');
    expect(waitTargetLabel([coder], { agent: 'c', item: 'gone' })).toBe('Coder: a removed step');
  });
});

describe('ifText', () => {
  it('reads a usage condition with its backend, share and window', () => {
    expect(
      ifText({ kind: 'usageAbove', backend: 'claude-code', window: 'fiveHour', percent: 80 }),
    ).toBe('Claude’s usage is over 80% (5-hour)');
    expect(ifText({ kind: 'usageAbove', backend: 'codex', window: 'weekly', percent: 95 })).toBe(
      'Codex’s usage is over 95% (weekly)',
    );
  });
});
