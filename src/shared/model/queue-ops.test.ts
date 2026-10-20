import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import type { AgentNode, CanvasDocument } from './canvas';
import type {
  QueueItem,
  QueueMessage,
  QueueStep,
  QueueChange,
  QueueRepeat,
  Condition,
  Time,
  WaitTarget,
} from './queue';
import { add, move, remove, update } from './queue-ops';
import { fromFile, toFile } from './file';
import { TEST_CATALOG } from '../engine/test-engine';

const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
function doc(queue: QueueItem[]): CanvasDocument {
  return {
    id: ID,
    arrange: true,
    nodes: [
      { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A', queue } },
      { id: 'b', type: 'agent', position: { x: 300, y: 0 }, data: { label: 'B' } },
    ],
    links: [{ source: 'a', target: 'b' }],
  };
}
function queue(document: CanvasDocument): QueueItem[] {
  const node = document.nodes[0];
  if (node?.type !== 'agent') throw new Error('no agent');
  return node.data.queue ?? [];
}
function frozen(queue: QueueItem[]): CanvasDocument {
  const document = doc(queue);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(document);
  return document;
}
const items: (QueueStep | QueueMessage)[] = [
  { id: 'first', message: 'First' },
  { id: 'second', action: 'Read', instruction: 'notes.txt', by: 'outside:old' },
  { id: 'third', message: 'Third', by: 'agent:b' },
];

describe('queue operations', () => {
  it('mints ids and records the author, preserving every untouched object', () => {
    const before = frozen(items);
    const result = add(
      before,
      { agent: 'a', entry: { message: 'New' } },
      'outside:writer',
      () => 'new',
    );
    expect(result.result).toEqual({ item: 'new' });
    expect(queue(result.next)).toEqual([
      ...items,
      { id: 'new', message: 'New', by: 'outside:writer' },
    ]);
    expect(queue(result.next)[0]).toBe(items[0]);
    expect(result.next.nodes[1]).toBe(before.nodes[1]);
    expect(result.next.links).toBe(before.links);
    expect((result.next.nodes[0] as AgentNode).position).toBe(before.nodes[0]?.position);
    expect(result.next.arrange).toBe(true);
  });
  it('changes authorship only when authored text changes, including nested text', () => {
    const before = frozen([{ id: 'if', if: { kind: 'failed' }, then: items.slice(0, 2) }]);
    const changed = update(
      before,
      { agent: 'a', item: 'first', change: { kind: 'message', message: 'Edited' } },
      'outside:writer',
    );
    const branch = queue(changed.next)[0];
    expect(branch).toMatchObject({
      then: [{ id: 'first', message: 'Edited', by: 'outside:writer' }, items[1]],
    });
    expect(branch && 'then' in branch ? branch.then[1] : undefined).toBe(items[1]);
    const targeted = update(
      before,
      { agent: 'a', item: 'second', change: { kind: 'target', target: 'b' } },
      'you',
    );
    expect(queue(targeted.next)[0]).toMatchObject({
      then: [items[0], { ...items[1], target: 'b' }],
    });
    expect(
      update(
        before,
        { agent: 'a', item: 'first', change: { kind: 'message', message: 'First' } },
        'outside:writer',
      ).next,
    ).toBe(before);
  });
  it('moves by neighbours without changing item identity or authorship', () => {
    const before = frozen(items);
    const changed = move(before, { agent: 'a', item: 'third', before: 'first' }).next;
    expect(queue(changed)).toEqual([items[2], items[0], items[1]]);
    expect(queue(changed)[0]).toBe(items[2]);
    expect(move(before, { agent: 'a', item: 'first', after: 'second' }).next.nodes[1]).toBe(
      before.nodes[1],
    );
    expect(queue(move(before, { agent: 'a', item: 'first', before: null }).next)).toEqual([
      items[1],
      items[2],
      items[0],
    ]);
    expect(move(before, { agent: 'a', item: 'first', before: 'second' }).next).toBe(before);
  });
  it('removes an inner item without copying its siblings or other containers', () => {
    const loop: QueueItem = {
      id: 'loop',
      repeat: items,
      until: { kind: 'failed' },
      rounds: 3,
      otherwise: 'ask',
    };
    const untouched: QueueItem = { id: 'if', if: { kind: 'succeeded' }, then: [] };
    const before = frozen([loop, untouched]);
    const changed = remove(before, { agent: 'a', item: 'second' }).next;
    expect(queue(changed)[0]).toMatchObject({ repeat: [items[0], items[2]] });
    expect(queue(changed)[1]).toBe(untouched);
    expect(remove(before, { agent: 'a', item: 'missing' }).next).toBe(before);
  });
  it('keeps authorship through saving and loading, at every depth and on every kind', () => {
    const before = doc([
      ...items,
      {
        id: 'if',
        by: 'outside:writer',
        if: { kind: 'failed' },
        then: [{ id: 'inner', message: 'Inner', by: 'agent:b' }],
      },
      {
        id: 'loop',
        by: 'agent:b',
        repeat: [
          { id: 'wait', waitFor: [{ agent: 'b' }], by: 'corrallm' },
          { id: 'delay', delay: { seconds: 60 }, by: 'outside:writer' },
        ],
        until: { kind: 'failed' },
        rounds: 3,
        otherwise: 'ask',
      },
      { id: 'ok', approve: 'Review', by: 'agent:b' },
    ]);
    expect(fromFile(toFile(before), TEST_CATALOG, 'claude-code')).toEqual(before);
  });
  it('leaves your text with no author: yours is written as none, and read as none', () => {
    const before = frozen(items);
    const added = add(before, { agent: 'a', entry: { message: 'Mine' } }, 'you', () => 'mine');
    expect(queue(added.next).at(-1)).toEqual({ id: 'mine', message: 'Mine' });
    // Rewriting another party's text makes it yours; what isn't its text keeps its author.
    const rewritten = update(
      before,
      { agent: 'a', item: 'second', change: { kind: 'instruction', instruction: 'mine.txt' } },
      'you',
    );
    expect(queue(rewritten.next)[1]).toEqual({
      id: 'second',
      action: 'Read',
      instruction: 'mine.txt',
    });
    const retargeted = update(
      before,
      { agent: 'a', item: 'third', change: { kind: 'target', target: 'b' } },
      'you',
    );
    expect(queue(retargeted.next)[2]).toEqual({ ...items[2], target: 'b' });
    // A file can claim anything: one saying you wrote it says what saying nothing says.
    const claimed = toFile(doc([{ id: 'x', message: 'Claimed', by: 'you' }]));
    expect(queue(fromFile(claimed, TEST_CATALOG, 'claude-code'))).toEqual([
      { id: 'x', message: 'Claimed' },
    ]);
  });
});

describe('neighbour moves and edits in containers', () => {
  it.each(['then', 'repeat'] as const)(
    'moves inside %s, leaving all sibling lists untouched',
    (kind) => {
      const container: QueueItem =
        kind === 'then'
          ? { id: 'box', if: { kind: 'failed' }, then: items }
          : { id: 'box', repeat: items, until: { kind: 'failed' }, rounds: 3, otherwise: 'ask' };
      const before = frozen([container, { id: 'other', message: 'Outside' }]);
      const changed = move(before, { agent: 'a', item: 'first', after: 'second' }).next;
      expect(queue(changed)[0]).toMatchObject({ [kind]: [items[1], items[0], items[2]] });
      expect(queue(changed)[1]).toBe(queue(before)[1]);
      expect(move(before, { agent: 'a', item: 'first', before: 'other' }).next).toBe(before);
      expect(move(before, { agent: 'a', item: 'first', before: 'first' }).next).toBe(before);
    },
  );
  it('mints child ids and authors on a whole newly added branch', () => {
    const ids = ['branch', 'child'];
    const changed = add(
      doc([]),
      { agent: 'a', entry: { if: { kind: 'failed' }, then: [{ message: 'Child' }] } },
      'agent:b',
      () => ids.shift() ?? 'extra',
    );
    expect(queue(changed.next)).toEqual([
      {
        id: 'branch',
        by: 'agent:b',
        if: { kind: 'failed' },
        then: [{ id: 'child', by: 'agent:b', message: 'Child' }],
      },
    ]);
  });
});

const agentNode = (id: string, x: number, y: number): AgentNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id },
});
const get = (doc: CanvasDocument, id: string): AgentNode => {
  const node = doc.nodes.find((one) => one.id === id);
  if (node?.type !== 'agent') throw new Error('no agent');
  return node;
};
const queuedDoc = (nodes: AgentNode[]): CanvasDocument => ({ ...doc([]), nodes });
const addToQueue = (doc: CanvasDocument, agent: string, entry: QueueItem, into?: string) => {
  const ids = [
    entry.id,
    ...('then' in entry ? entry.then : 'repeat' in entry ? entry.repeat : []).map((one) => one.id),
  ];
  return add(
    doc,
    { agent, entry, ...(into === undefined ? {} : { into }) },
    'you',
    () => ids.shift() ?? 'extra',
  ).next;
};
const removeFromQueue = (doc: CanvasDocument, agent: string, item: string) =>
  remove(doc, { agent, item }).next;
const moveInQueue = (doc: CanvasDocument, agent: string, item: string, index: number) => {
  const queue = get(doc, agent).data.queue ?? [];
  let list = queue;
  if (!list.some((one) => one.id === item)) {
    const container = queue.find((one) =>
      'then' in one
        ? one.then.some((inner) => inner.id === item)
        : 'repeat' in one && one.repeat.some((inner) => inner.id === item),
    );
    list =
      container && 'then' in container
        ? container.then
        : container && 'repeat' in container
          ? container.repeat
          : [];
  }
  const rest = list.filter((one) => one.id !== item);
  return move(doc, { agent, item, before: rest[Math.max(0, index)]?.id ?? null }).next;
};
const change = (doc: CanvasDocument, agent: string, item: string, change: QueueChange) =>
  update(doc, { agent, item, change }, 'you').next;
const retarget = (doc: CanvasDocument, agent: string, item: string, target: string | undefined) =>
  change(doc, agent, item, { kind: 'target', target: target ?? null });
const editMessage = (doc: CanvasDocument, agent: string, item: string, message: string) =>
  change(doc, agent, item, { kind: 'message', message });
const setInstruction = (doc: CanvasDocument, agent: string, item: string, instruction: string) =>
  change(doc, agent, item, { kind: 'instruction', instruction });
const setExpect = (doc: CanvasDocument, agent: string, item: string, expect: QueueStep['expect']) =>
  change(doc, agent, item, { kind: 'expect', expect: expect ?? null });
const setCondition = (doc: CanvasDocument, agent: string, item: string, condition: Condition) =>
  change(doc, agent, item, { kind: 'condition', condition });
const setWaitFor = (doc: CanvasDocument, agent: string, item: string, waitFor: WaitTarget[]) =>
  change(doc, agent, item, { kind: 'waitFor', waitFor });
const setTime = (doc: CanvasDocument, agent: string, item: string, time: Time | undefined) =>
  change(doc, agent, item, { kind: 'time', time: time ?? null });
const setApproval = (doc: CanvasDocument, agent: string, item: string, approve: string) =>
  change(doc, agent, item, { kind: 'approve', approve });
const setRepeat = (
  doc: CanvasDocument,
  agent: string,
  item: string,
  fields: Partial<Pick<QueueRepeat, 'until' | 'rounds' | 'otherwise'>>,
) => change(doc, agent, item, { kind: 'repeat', ...fields });
describe('queues', () => {
  const g = queuedDoc([agentNode('a', 0, 0), agentNode('b', 0, 100)]);
  const first = { id: 'q1', action: 'Read' };
  const second = { id: 'q2', action: 'Edit', target: 'b' };
  const third = { id: 'q3', action: 'Bash' };
  const queued = [first, second, third].reduce((acc, q) => addToQueue(acc, 'a', q), g);
  const queueOf = (graph: CanvasDocument) => get(graph, 'a').data.queue ?? [];
  const order = (graph: CanvasDocument) => queueOf(graph).map((q) => q.id);

  it("appends items to a node's queue, in order", () => {
    expect(get(queued, 'a').data).toEqual({ label: 'a', queue: [first, second, third] });
    expect(get(queued, 'b')).toBe(get(g, 'b'));
    expect(addToQueue(g, 'missing', first)).toBe(g);
  });

  it("removes one item from a node's queue", () => {
    expect(order(removeFromQueue(queued, 'a', 'q2'))).toEqual(['q1', 'q3']);
    expect(removeFromQueue(queued, 'a', 'missing')).toBe(queued);
    expect(removeFromQueue(queued, 'b', 'q1')).toBe(queued);
  });

  it('moves an item to another place in the queue', () => {
    expect(order(moveInQueue(queued, 'a', 'q3', 0))).toEqual(['q3', 'q1', 'q2']);
    expect(order(moveInQueue(queued, 'a', 'q1', 1))).toEqual(['q2', 'q1', 'q3']);
    expect(order(moveInQueue(queued, 'a', 'q1', 99))).toEqual(['q2', 'q3', 'q1']);
    expect(moveInQueue(queued, 'a', 'q2', 1)).toBe(queued);
    expect(moveInQueue(queued, 'a', 'missing', 0)).toBe(queued);
  });

  it('changes which node an item acts on, or makes it act on its own node', () => {
    const onB = retarget(queued, 'a', 'q1', 'b');
    expect(queueOf(onB)[0]).toEqual({ ...first, target: 'b' });
    expect(queueOf(retarget(onB, 'a', 'q1', undefined))[0]).toEqual(first);
    expect(retarget(queued, 'a', 'q2', 'b')).toBe(queued);
  });

  it('holds messages for the agent, which can be edited, or sent to another agent', () => {
    const note = { id: 'm1', message: 'Use the staging database' };
    const withNote = addToQueue(queued, 'a', note);
    expect(queueOf(withNote).at(-1)).toEqual(note);
    expect(queueOf(editMessage(withNote, 'a', 'm1', 'Use prod')).at(-1)).toEqual({
      ...note,
      message: 'Use prod',
    });
    expect(editMessage(withNote, 'a', 'q1', 'x')).toBe(withNote);
    const sent = retarget(withNote, 'a', 'm1', 'b');
    expect(queueOf(sent).at(-1)).toEqual({ ...note, target: 'b' });
    expect(queueOf(retarget(sent, 'a', 'm1', undefined)).at(-1)).toEqual(note);
  });

  it('says what a step is to do, in the user’s words; empty takes it off', () => {
    const told = setInstruction(queued, 'a', 'q3', 'run npm test');
    expect(queueOf(told)[2]).toEqual({ ...third, instruction: 'run npm test' });
    expect(queueOf(setInstruction(told, 'a', 'q3', ''))[2]).toEqual(third);
    expect(setInstruction(told, 'a', 'q3', 'run npm test')).toBe(told);
    expect(setInstruction(queued, 'a', 'q3', '')).toBe(queued);
    // Only a step has one.
    const note = addToQueue(queued, 'a', { id: 'm1', message: 'Use staging' });
    expect(setInstruction(note, 'a', 'm1', 'x')).toBe(note);
  });

  it('expects a step to fail, or (undefined) to succeed as steps do', () => {
    const red = setExpect(queued, 'a', 'q3', 'fails');
    expect(queueOf(red)[2]).toEqual({ ...third, expect: 'fails' });
    expect(queueOf(setExpect(red, 'a', 'q3', undefined))[2]).toEqual(third);
    expect(setExpect(red, 'a', 'q3', 'fails')).toBe(red);
    expect(setExpect(queued, 'a', 'q3', undefined)).toBe(queued);
    // Only a step does.
    const note = addToQueue(queued, 'a', { id: 'm1', message: 'Use staging' });
    expect(setExpect(note, 'a', 'm1', 'fails')).toBe(note);
  });

  it('holds waits for other agents or their steps, which can be changed', () => {
    const wait = { id: 'w1', waitFor: [{ agent: 'b' }] };
    const waiting = addToQueue(queued, 'a', wait);
    expect(queueOf(waiting).at(-1)).toEqual(wait);
    const both = [{ agent: 'b' }, { agent: 'c', item: 's1' }];
    expect(queueOf(setWaitFor(waiting, 'a', 'w1', both)).at(-1)).toEqual({
      id: 'w1',
      waitFor: both,
    });
    // A wait waits for something, and only waits are changed.
    expect(setWaitFor(waiting, 'a', 'w1', [])).toBe(waiting);
    expect(setWaitFor(waiting, 'a', 'w1', [{ agent: 'b' }])).toBe(waiting);
    expect(setWaitFor(waiting, 'a', 'q1', [{ agent: 'b' }])).toBe(waiting);
    // A step of b is not b.
    expect(setWaitFor(waiting, 'a', 'w1', [{ agent: 'b', item: 's1' }])).not.toBe(waiting);
    // Waits are left alone by what changes steps and messages.
    expect(retarget(waiting, 'a', 'w1', 'c')).toBe(waiting);
    expect(editMessage(waiting, 'a', 'w1', 'x')).toBe(waiting);
  });

  it("sets a delay's time, and sets and clears a wait's time limit", () => {
    const delay = { id: 'd1', delay: { seconds: 600 } };
    const wait = { id: 'w1', waitFor: [{ agent: 'b' }] };
    const timed = addToQueue(addToQueue(queued, 'a', delay), 'a', wait);
    const item = (graph: CanvasDocument, id: string) => queueOf(graph).find((q) => q.id === id);

    const longer = setTime(timed, 'a', 'd1', { at: '09:00' });
    expect(item(longer, 'd1')).toEqual({ id: 'd1', delay: { at: '09:00' } });
    // A delay always has a time.
    expect(setTime(timed, 'a', 'd1', undefined)).toBe(timed);
    expect(setTime(timed, 'a', 'd1', { seconds: 600 })).toBe(timed);

    const limited = setTime(timed, 'a', 'w1', { seconds: 1800 });
    expect(item(limited, 'w1')).toEqual({ ...wait, timeout: { seconds: 1800 } });
    expect(setTime(limited, 'a', 'w1', { seconds: 1800 })).toBe(limited);
    expect(item(setTime(limited, 'a', 'w1', undefined), 'w1')).toEqual(wait);
    expect(setTime(timed, 'a', 'w1', undefined)).toBe(timed);
    // Only delays and waits have times; delays are left alone by what changes steps.
    expect(setTime(timed, 'a', 'q1', { seconds: 60 })).toBe(timed);
    expect(retarget(timed, 'a', 'd1', 'b')).toBe(timed);
    expect(editMessage(timed, 'a', 'd1', 'x')).toBe(timed);
  });

  it('holds OKs, whose words can be changed, and which nothing else changes', () => {
    const ok = { id: 'ok1', approve: 'the spec' };
    const asked = addToQueue(queued, 'a', ok);
    expect(queueOf(asked).at(-1)).toEqual(ok);
    const plan = setApproval(asked, 'a', 'ok1', 'the plan in PLAN.md');
    expect(queueOf(plan).at(-1)).toEqual({
      id: 'ok1',
      approve: 'the plan in PLAN.md',
    });
    expect(queueOf(setApproval(asked, 'a', 'ok1', '')).at(-1)).toEqual({
      id: 'ok1',
      approve: '',
    });
    // The same words, or an item that is not an OK, change nothing.
    expect(setApproval(asked, 'a', 'ok1', 'the spec')).toBe(asked);
    expect(setApproval(asked, 'a', 'q1', 'the spec')).toBe(asked);
    expect(retarget(asked, 'a', 'ok1', 'b')).toBe(asked);
    expect(editMessage(asked, 'a', 'ok1', 'x')).toBe(asked);
    expect(setTime(asked, 'a', 'ok1', { seconds: 60 })).toBe(asked);
  });

  describe('if-then', () => {
    const block = { id: 'if1', if: { kind: 'failed' as const }, then: [] };
    const withIf = addToQueue(queued, 'a', block);
    const step = (id: string) => ({ id, action: 'Read' });
    const filled = addToQueue(addToQueue(withIf, 'a', step('t1'), 'if1'), 'a', step('t2'), 'if1');
    const thenOf = (graph: CanvasDocument) => {
      const found = queueOf(graph).find((q) => q.id === 'if1');
      return found && 'then' in found ? found.then.map((q) => q.id) : undefined;
    };

    it('adds steps inside an if-then, not to the queue; never a wait, a delay or an OK', () => {
      expect(order(filled)).toEqual(['q1', 'q2', 'q3', 'if1']);
      expect(thenOf(filled)).toEqual(['t1', 't2']);
      expect(addToQueue(withIf, 'a', step('x'), 'q1')).toBe(withIf);
      expect(addToQueue(withIf, 'a', { id: 'w', waitFor: [{ agent: 'b' }] }, 'if1')).toBe(withIf);
      expect(addToQueue(withIf, 'a', { id: 'd', delay: { seconds: 60 } }, 'if1')).toBe(withIf);
      expect(addToQueue(withIf, 'a', { id: 'ok', approve: '' }, 'if1')).toBe(withIf);
    });

    it('removes, moves and retargets the steps inside it', () => {
      expect(thenOf(removeFromQueue(filled, 'a', 't1'))).toEqual(['t2']);
      expect(thenOf(moveInQueue(filled, 'a', 't2', 0))).toEqual(['t2', 't1']);
      const onB = retarget(filled, 'a', 't1', 'b');
      const inside = queueOf(onB).find((q) => q.id === 'if1');
      expect(inside && 'then' in inside ? inside.then[0] : undefined).toEqual({
        ...step('t1'),
        target: 'b',
      });
      // The if-then itself moves like any item, its steps with it.
      expect(order(moveInQueue(filled, 'a', 'if1', 0))).toEqual(['if1', 'q1', 'q2', 'q3']);
      expect(thenOf(moveInQueue(filled, 'a', 'if1', 0))).toEqual(['t1', 't2']);
    });

    it('changes its condition', () => {
      const done = setCondition(filled, 'a', 'if1', { kind: 'outputContains', text: 'PASS' });
      expect(queueOf(done).find((q) => q.id === 'if1')).toMatchObject({
        if: { kind: 'outputContains', text: 'PASS' },
      });
      expect(setCondition(filled, 'a', 'q1', { kind: 'failed' })).toBe(filled);
    });
  });

  describe('repeat', () => {
    const loop = {
      id: 'r1',
      repeat: [],
      until: { kind: 'succeeded' as const },
      rounds: 3,
      otherwise: 'ask' as const,
    };
    const withRepeat = addToQueue(queued, 'a', loop);
    const fix = { id: 'fix', message: 'Make the tests pass' };
    const tests = { id: 'tests', action: 'Bash' };
    const wait = { id: 'w', waitFor: [{ agent: 'b' }] };
    const pause = { id: 'p', delay: { seconds: 60 } };
    const filled = [fix, tests, wait, pause].reduce(
      (graph, item) => addToQueue(graph, 'a', item, 'r1'),
      withRepeat,
    );
    const repeatOf = (graph: CanvasDocument) => {
      const found = queueOf(graph).find((q) => q.id === 'r1');
      return found && 'repeat' in found ? found : undefined;
    };
    const inner = (graph: CanvasDocument) => repeatOf(graph)?.repeat ?? [];

    it('adds steps, messages, waits and delays inside a repeat; never an if-then, repeat or OK', () => {
      expect(order(filled)).toEqual(['q1', 'q2', 'q3', 'r1']);
      expect(inner(filled)).toEqual([fix, tests, wait, pause]);
      const ifThen = { id: 'if', if: { kind: 'failed' as const }, then: [] };
      expect(addToQueue(withRepeat, 'a', ifThen, 'r1')).toBe(withRepeat);
      expect(addToQueue(withRepeat, 'a', { ...loop, id: 'r2' }, 'r1')).toBe(withRepeat);
      expect(addToQueue(withRepeat, 'a', { id: 'ok', approve: '' }, 'r1')).toBe(withRepeat);
      // Nor does an if-then hold a repeat.
      const withIf = addToQueue(withRepeat, 'a', ifThen);
      expect(addToQueue(withIf, 'a', { ...loop, id: 'r2' }, 'if')).toBe(withIf);
    });

    it('removes, moves, retargets and edits what is inside it, and changes its waits and delays', () => {
      const ids = (graph: CanvasDocument) => inner(graph).map((q) => q.id);
      expect(ids(removeFromQueue(filled, 'a', 'tests'))).toEqual(['fix', 'w', 'p']);
      expect(ids(moveInQueue(filled, 'a', 'p', 0))).toEqual(['p', 'fix', 'tests', 'w']);
      expect(moveInQueue(filled, 'a', 'fix', 0)).toBe(filled);
      expect(inner(retarget(filled, 'a', 'tests', 'b'))[1]).toEqual({ ...tests, target: 'b' });
      expect(inner(editMessage(filled, 'a', 'fix', 'Fix it'))[0]).toEqual({
        ...fix,
        message: 'Fix it',
      });
      expect(inner(setInstruction(filled, 'a', 'tests', 'only the cart'))[1]).toEqual({
        ...tests,
        instruction: 'only the cart',
      });
      expect(inner(setExpect(filled, 'a', 'tests', 'fails'))[1]).toEqual({
        ...tests,
        expect: 'fails',
      });
      expect(inner(setWaitFor(filled, 'a', 'w', [{ agent: 'b', item: 's' }]))[2]).toEqual({
        id: 'w',
        waitFor: [{ agent: 'b', item: 's' }],
      });
      expect(inner(setTime(filled, 'a', 'w', { seconds: 30 }))[2]).toEqual({
        ...wait,
        timeout: { seconds: 30 },
      });
      expect(inner(setTime(filled, 'a', 'p', { at: '09:00' }))[3]).toEqual({
        id: 'p',
        delay: { at: '09:00' },
      });
      // What changes nothing gives back the same graph.
      expect(editMessage(filled, 'a', 'fix', fix.message)).toBe(filled);
      expect(retarget(filled, 'a', 'w', 'b')).toBe(filled);
      // The repeat itself moves and goes like any item, what it holds with it.
      expect(order(moveInQueue(filled, 'a', 'r1', 0))).toEqual(['r1', 'q1', 'q2', 'q3']);
      expect(order(removeFromQueue(filled, 'a', 'r1'))).toEqual(['q1', 'q2', 'q3']);
    });

    it('changes when it stops, how many rounds it runs at most (1 to 20), and then what', () => {
      const until = { kind: 'outputContains' as const, text: 'APPROVED' };
      expect(repeatOf(setRepeat(filled, 'a', 'r1', { until, rounds: 5 }))).toMatchObject({
        until,
        rounds: 5,
        otherwise: 'ask',
      });
      expect(repeatOf(setRepeat(filled, 'a', 'r1', { otherwise: 'goOn' }))?.otherwise).toBe('goOn');
      expect(repeatOf(setRepeat(filled, 'a', 'r1', { rounds: 0 }))?.rounds).toBe(1);
      expect(repeatOf(setRepeat(filled, 'a', 'r1', { rounds: 99 }))?.rounds).toBe(20);
      expect(repeatOf(setRepeat(filled, 'a', 'r1', { rounds: 2.6 }))?.rounds).toBe(3);
      // Nothing new, or no repeat by that id: the same graph.
      expect(setRepeat(filled, 'a', 'r1', { rounds: 3, until: { kind: 'succeeded' } })).toBe(
        filled,
      );
      expect(setRepeat(filled, 'a', 'q1', { rounds: 5 })).toBe(filled);
    });
  });
});

describe('queue update variants', () => {
  it.each([
    [
      { id: 'x', action: 'Read', by: 'outside:old' },
      { kind: 'action', action: 'Edit' },
      { action: 'Edit', by: 'agent:b' },
    ],
    [
      { id: 'x', action: 'Read', instruction: 'Old', by: 'outside:old' },
      { kind: 'instruction', instruction: null },
      { by: 'agent:b' },
    ],
    [
      { id: 'x', action: 'Read', expect: 'fails', by: 'outside:old' },
      { kind: 'expect', expect: null },
      { by: 'outside:old' },
    ],
    [
      { id: 'x', message: 'Message', target: 'b', by: 'outside:old' },
      { kind: 'target', target: null },
      { message: 'Message', by: 'outside:old' },
    ],
    [
      { id: 'x', if: { kind: 'freeText', text: 'Old' }, then: [], by: 'outside:old' },
      { kind: 'condition', condition: { kind: 'freeText', text: 'New' } },
      { if: { kind: 'freeText', text: 'New' }, by: 'agent:b' },
    ],
    [
      { id: 'x', approve: 'Old', by: 'outside:old' },
      { kind: 'approve', approve: 'New' },
      { approve: 'New', by: 'agent:b' },
    ],
    [
      {
        id: 'x',
        repeat: [],
        until: { kind: 'freeText', text: 'Old' },
        rounds: 3,
        otherwise: 'ask',
        by: 'outside:old',
      },
      { kind: 'repeat', until: { kind: 'freeText', text: 'New' } },
      { until: { kind: 'freeText', text: 'New' }, by: 'agent:b' },
    ],
    [
      {
        id: 'x',
        repeat: [],
        until: { kind: 'failed' },
        rounds: 3,
        otherwise: 'ask',
        by: 'outside:old',
      },
      { kind: 'repeat', until: { kind: 'repeatEnds', agent: 'b', item: 'loop' } },
      { until: { kind: 'repeatEnds', agent: 'b', item: 'loop' }, by: 'outside:old' },
    ],
  ] satisfies [QueueItem, QueueChange, Record<string, unknown>][])(
    'changes the right field and its author (%j)',
    (item, change, expected) => {
      const result = queue(
        update(frozen([item]), { agent: 'a', item: 'x', change }, 'agent:b').next,
      )[0];
      expect(result).toMatchObject(expected);
      if (change.kind === 'instruction') expect(result).not.toHaveProperty('instruction');
      if (change.kind === 'expect') expect(result).not.toHaveProperty('expect');
      if (change.kind === 'target') expect(result).not.toHaveProperty('target');
    },
  );
  it('keeps a structurally equal condition identical regardless of key order', () => {
    const before = frozen([
      { id: 'x', if: { kind: 'outputContains', text: 'PASS', wholeLine: true }, then: [] },
    ]);
    expect(
      update(
        before,
        {
          agent: 'a',
          item: 'x',
          change: {
            kind: 'condition',
            condition: { wholeLine: true, text: 'PASS', kind: 'outputContains' },
          },
        },
        'you',
      ).next,
    ).toBe(before);
  });
  it('does not edit frames or mint an id for an incompatible container', () => {
    const before = frozen([{ id: 'branch', if: { kind: 'failed' }, then: [] }]);
    const withFrame: CanvasDocument = {
      ...before,
      nodes: [
        ...before.nodes,
        { id: 'f', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Frame' } },
      ],
    };
    const never = () => {
      throw new Error('must not mint');
    };
    expect(add(withFrame, { agent: 'f', entry: { message: 'No' } }, 'you', never).next).toBe(
      withFrame,
    );
    expect(
      add(before, { agent: 'a', into: 'branch', entry: { delay: { seconds: 60 } } }, 'you', never)
        .next,
    ).toBe(before);
    expect(
      update(
        withFrame,
        { agent: 'f', item: 'x', change: { kind: 'message', message: 'No' } },
        'you',
      ).next,
    ).toBe(withFrame);
  });
});

it('writes a newly authored item in the same form that reopening it writes', () => {
  const changed = add(
    doc([]),
    { agent: 'a', entry: { message: 'New' } },
    'outside:writer',
    () => 'new',
  ).next;
  const text = toFile(changed);
  expect(toFile(fromFile(text, TEST_CATALOG, 'claude-code'))).toBe(text);
});
