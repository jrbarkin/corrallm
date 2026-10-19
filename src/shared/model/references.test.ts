import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import { TEST_CATALOG } from '../engine/test-engine';
import type { AgentNode, CanvasDocument } from './canvas';
import { fromFile, toFile } from './file';
import type { QueueItem, QueueRepeat, RepeatedItem } from './queue';
import { clearDeletedReferences } from './references';

const agent = (id: string, label: string, queue: QueueItem[] = []): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label, queue },
});
const loop = (repeat: RepeatedItem[], more: Partial<QueueRepeat> = {}): QueueRepeat => ({
  id: 'loop',
  repeat,
  until: { kind: 'succeeded' },
  rounds: 3,
  otherwise: 'ask',
  ...more,
});
const builder = agent('builder', 'Builder', [
  { id: 'one', action: 'Read' },
  { id: 'two', action: 'Bash' },
  loop([{ id: 'build', action: 'Edit' }], { id: 'building' }),
]);
const checker = agent('checker', 'Checker', [{ id: 'check', action: 'Read' }]);
const keep = { id: 'keep', action: 'Read' };

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function clean(queue: QueueItem[]) {
  const nodes = freeze([builder, agent('reviewer', 'Reviewer', queue), checker]);
  return clearDeletedReferences(nodes, new Set(['builder']));
}

const queueOf = (nodes: readonly AgentNode[]) => nodes.find((n) => n.id === 'reviewer')?.data.queue;

describe('clearDeletedReferences', () => {
  it.each([false, true])('clears step targets (inside a repeat: %s)', (inside) => {
    const step = {
      id: 'review',
      action: 'Read',
      instruction: 'Review its work',
      target: 'builder',
    };
    const cleared = { id: 'review', action: 'Read', instruction: 'Review its work' };
    const result = clean(inside ? [loop([step, keep])] : [step, keep]);
    expect(queueOf(result.nodes)).toEqual(inside ? [loop([cleared, keep])] : [cleared, keep]);
    expect(result.cleared).toEqual([
      `Reviewer’s step 1${inside ? ' in repeat 1' : ''} no longer targets Builder.`,
    ]);
  });

  it.each([false, true])(
    'removes messages to a deleted recipient (inside a repeat: %s)',
    (inside) => {
      const message = { id: 'send', message: 'Review this', target: 'builder' };
      const result = clean(inside ? [loop([message, keep])] : [message, keep]);
      expect(queueOf(result.nodes)).toEqual(inside ? [loop([keep])] : [keep]);
      expect(result.cleared).toContain(
        `Reviewer’s message 1${inside ? ' in repeat 1' : ''} to Builder was removed.`,
      );
    },
  );

  it.each([undefined, 'two', 'build'])(
    'removes an empty wait for a deleted agent’s item %s, at either depth',
    (item) => {
      const wait = {
        id: 'wait',
        waitFor: [{ agent: 'builder', ...(item ? { item } : {}) }],
        timeout: { seconds: 60 },
      };
      for (const inside of [false, true]) {
        const result = clean(inside ? [loop([wait, keep])] : [wait, keep]);
        expect(queueOf(result.nodes)).toEqual(inside ? [loop([keep])] : [keep]);
        const target =
          item === 'two'
            ? 'Builder’s step 2'
            : item === 'build'
              ? 'Builder’s step 1 in repeat 3'
              : 'Builder';
        expect(result.cleared).toContain(
          `Reviewer’s wait 1${inside ? ' in repeat 1' : ''} for ${target} was removed.`,
        );
      }
    },
  );

  it.each([false, true])(
    'keeps a wait’s surviving targets and timeout (inside a repeat: %s)',
    (inside) => {
      const wait = {
        id: 'wait',
        waitFor: [
          { agent: 'builder', item: 'two' },
          { agent: 'checker', item: 'check' },
        ],
        timeout: { at: '09:00' },
      };
      const expected = { ...wait, waitFor: [{ agent: 'checker', item: 'check' }] };
      const result = clean(inside ? [loop([wait, keep])] : [wait, keep]);
      expect(queueOf(result.nodes)).toEqual(inside ? [loop([expected, keep])] : [expected, keep]);
      expect(result.cleared).toEqual([
        `Reviewer’s wait 1${inside ? ' in repeat 1' : ''} no longer waits for Builder’s step 2.`,
      ]);
    },
  );

  it('unwraps a repeat whose leader was deleted, keeping its remaining work once', () => {
    const result = clean([
      loop([keep], { until: { kind: 'repeatEnds', agent: 'builder', item: 'building' } }),
    ]);
    expect(queueOf(result.nodes)).toEqual([keep]);
    expect(result.cleared).toEqual([
      'Reviewer’s repeat 1 no longer follows Builder’s repeat 3; its remaining items run once.',
    ]);
  });

  it('clears targets inside If branches and removes empty branches', () => {
    const result = clean([
      {
        id: 'branch',
        if: { kind: 'freeText', text: 'Ready?' },
        then: [
          { id: 'step', action: 'Read', target: 'builder' },
          { id: 'message', message: 'Go', target: 'builder' },
        ],
      },
      {
        id: 'empty',
        if: { kind: 'freeText', text: 'Ready?' },
        then: [{ id: 'only', message: 'Go', target: 'builder' }],
      },
    ]);
    expect(queueOf(result.nodes)).toEqual([
      {
        id: 'branch',
        if: { kind: 'freeText', text: 'Ready?' },
        then: [{ id: 'step', action: 'Read' }],
      },
    ]);
    expect(result.cleared).toEqual([
      'Reviewer’s step 1 in If 1 no longer targets Builder.',
      'Reviewer’s message 2 in If 1 to Builder was removed.',
      'Reviewer’s message 1 in If 2 to Builder was removed.',
      'Reviewer’s If 2 was removed because it has no steps left.',
    ]);
  });

  it.each(['succeeded', 'failed', 'outputContains', 'timedOut'] as const)(
    'removes an If whose %s condition would switch to different work',
    (kind) => {
      const condition = kind === 'outputContains' ? { kind, text: 'PASS' } : { kind };
      const result = clean([
        keep,
        { id: 'wait', waitFor: [{ agent: 'builder' }] },
        { id: 'delay', delay: { seconds: 1 } },
        { id: 'branch', if: condition, then: [{ id: 'do', action: 'Read' }] },
      ]);
      expect(queueOf(result.nodes)).toEqual([keep, { id: 'delay', delay: { seconds: 1 } }]);
      expect(result.cleared).toContain(
        'Reviewer’s If 4 was removed because the task it checked was removed.',
      );
    },
  );

  it('keeps conditions that ask independently or read usage', () => {
    const conditions: QueueItem[] = [
      { id: 'text', if: { kind: 'freeText', text: 'Is the work ready?' }, then: [keep] },
      {
        id: 'usage',
        if: { kind: 'usageAbove', backend: 'codex', window: 'weekly', percent: 80 },
        then: [{ id: 'note', message: 'Wait' }],
      },
    ];
    const result = clean([{ id: 'wait', waitFor: [{ agent: 'builder' }] }, ...conditions]);
    expect(queueOf(result.nodes)).toEqual(conditions);
    expect(result.cleared).toHaveLength(1);
  });

  it('unwraps a repeat whose condition’s last task was removed', () => {
    const result = clean([
      loop([keep, { id: 'send', message: 'Review', target: 'builder' }], {
        until: { kind: 'outputContains', text: 'READY' },
      }),
    ]);
    expect(queueOf(result.nodes)).toEqual([keep]);
    expect(result.cleared).toContain(
      'Reviewer’s repeat 1 no longer checks its removed last task; its remaining items run once.',
    );
  });

  it('removes empty repeats rather than saving an empty wait', () => {
    const result = clean([loop([{ id: 'wait', waitFor: [{ agent: 'builder' }] }])]);
    expect(queueOf(result.nodes)).toEqual([]);
    expect(result.cleared).toContain(
      'Reviewer’s repeat 1 was removed because it has no items left.',
    );
  });

  it('clears cascades through surviving agents, even in reverse dependency order', () => {
    const nodes = [
      agent('last', 'Last', [{ id: 'last-wait', waitFor: [{ agent: 'reviewer', item: 'wait' }] }]),
      agent('reviewer', 'Reviewer', [{ id: 'wait', waitFor: [{ agent: 'middle', item: 'send' }] }]),
      agent('middle', 'Middle', [{ id: 'send', message: 'Go', target: 'builder' }]),
      builder,
    ];
    const result = clearDeletedReferences(freeze(nodes), new Set(['builder']));
    expect(result.nodes.slice(0, 3).map((n) => n.data.queue)).toEqual([[], [], []]);
    expect(result.cleared).toHaveLength(3);
  });

  it('clears waits for the children of an If removed with its checked task', () => {
    const nodes = [
      agent('checker', 'Checker', [
        { id: 'follow', waitFor: [{ agent: 'reviewer', item: 'then' }] },
      ]),
      agent('reviewer', 'Reviewer', [
        { id: 'send', message: 'Go', target: 'builder' },
        { id: 'branch', if: { kind: 'succeeded' }, then: [{ id: 'then', action: 'Read' }] },
      ]),
      builder,
    ];
    const result = clearDeletedReferences(freeze(nodes), new Set(['builder']));
    expect(result.nodes.slice(0, 2).map((n) => n.data.queue)).toEqual([[], []]);
    expect(result.cleared).toContain('Checker’s wait 1 for Reviewer’s step 1 in If 2 was removed.');
  });

  it('clears repeat leaders and waits on repeat containers removed by cleanup', () => {
    const nodes = [
      agent('watcher', 'Watcher', [
        { id: 'watch', waitFor: [{ agent: 'reviewer', item: 'following' }] },
      ]),
      agent('reviewer', 'Reviewer', [
        loop([keep], {
          id: 'following',
          until: { kind: 'repeatEnds', agent: 'middle', item: 'leading' },
        }),
      ]),
      agent('middle', 'Middle', [
        loop([{ id: 'send', message: 'Go', target: 'builder' }], { id: 'leading' }),
      ]),
      builder,
    ];
    const result = clearDeletedReferences(freeze(nodes), new Set(['builder']));
    expect(result.nodes.slice(0, 3).map((n) => n.data.queue)).toEqual([[], [keep], []]);
    expect(result.cleared).toContain(
      'Reviewer’s repeat 1 no longer follows Middle’s repeat 1; its remaining items run once.',
    );
    expect(result.cleared).toContain('Watcher’s wait 1 for Reviewer’s repeat 1 was removed.');
  });

  it('clears several deleted agents together, without reporting their own queues', () => {
    const nodes = [
      agent('a', 'A', [{ id: 'to-b', message: 'Hello', target: 'b' }]),
      agent('b', 'B', [{ id: 'to-a', message: 'Hello', target: 'a' }]),
      agent('reviewer', 'Reviewer', [
        { id: 'join', waitFor: [{ agent: 'a' }, { agent: 'b' }, { agent: 'checker' }] },
      ]),
      checker,
    ];
    const result = clearDeletedReferences(freeze(nodes), new Set(['a', 'b']));
    expect(queueOf(result.nodes)).toEqual([{ id: 'join', waitFor: [{ agent: 'checker' }] }]);
    expect(result.cleared).toEqual(['Reviewer’s wait 1 no longer waits for A and B.']);
    expect(result.nodes[0]).toBe(nodes[0]);
    expect(result.nodes[1]).toBe(nodes[1]);
  });

  it('detaches display-only submission references without deleting the record', () => {
    const submission = {
      id: 'submitted',
      text: 'Already sent',
      status: 'completed' as const,
      task: { agent: 'builder', item: 'two' },
      after: 'send',
    };
    const result = clean([
      { id: 'send', message: 'Go', target: 'builder' },
      { id: 'submitted', message: 'Already sent', submission },
    ]);
    expect(queueOf(result.nodes)).toEqual([
      {
        id: 'submitted',
        message: 'Already sent',
        submission: { id: 'submitted', text: 'Already sent', status: 'completed' },
      },
    ]);
    expect(result.cleared).toContain(
      'Reviewer’s message 2 is no longer associated with Builder’s step 2.',
    );
    expect(result.cleared).toContain(
      'Reviewer’s message 2 no longer follows Reviewer’s message 1.',
    );
  });

  it('keeps node identities and reports nothing when there are no affected references', () => {
    const nodes = freeze([
      builder,
      agent('reviewer', 'Reviewer', [
        { ...keep, target: 'checker' },
        { id: 'send', message: 'Go', target: 'checker' },
        { id: 'wait', waitFor: [{ agent: 'checker', item: 'check' }] },
        loop([{ id: 'read', action: 'Read' }], {
          until: { kind: 'repeatEnds', agent: 'checker', item: 'checking' },
        }),
      ]),
      agent('checker', 'Checker', [
        { id: 'check', action: 'Read' },
        loop([{ id: 'test', action: 'Bash' }], { id: 'checking' }),
      ]),
    ]);
    const result = clearDeletedReferences(nodes, new Set(['builder', 'unknown']));
    expect(result.nodes).toBe(nodes);
    expect(result.cleared).toEqual([]);
    expect(clearDeletedReferences(nodes, new Set()).nodes).toBe(nodes);
  });

  it('saves and reads back the cleared workflow, with the deleted nodes removed', () => {
    const result = clean([
      { id: 'wait', waitFor: [{ agent: 'builder' }] },
      loop([{ id: 'review', action: 'Read', target: 'builder' }, keep], {
        until: { kind: 'repeatEnds', agent: 'builder', item: 'building' },
      }),
    ]);
    const canvas: CanvasDocument = {
      id: '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId,
      arrange: false,
      nodes: result.nodes.filter((n) => n.id !== 'builder'),
      links: [],
    };
    expect(fromFile(toFile(canvas), TEST_CATALOG, 'claude-code')).toEqual(canvas);
    expect(queueOf(result.nodes)).toEqual([{ id: 'review', action: 'Read' }, keep]);
  });
});
