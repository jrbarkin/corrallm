import type { Edge, XYPosition } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { absolutePosition } from '../../shared/model/geometry';
import { autosize, size } from './geometry';
import type { QueueItem } from '../../shared/model/queue';

import {
  addAgent,
  documentOf,
  graphOf,
  addParent,
  addToQueue,
  canvasNodes,
  connect,
  deleteSelection,
  editMessage,
  groupSelection,
  moveInQueue,
  removeFromQueue,
  renameNode,
  retarget,
  selectOnly,
  setAgent,
  setApproval,
  setCondition,
  setConnection,
  setExpect,
  setInstruction,
  setSettings,
  setRepeat,
  setTime,
  setWaitFor,
  ungroupSelection,
} from './graph';
import { HEADER, CARD_SIZE, PADDING } from '../../shared/model/geometry';
import type { Graph, GraphNode } from './graph';
import type { CanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { insertGraph } from './insert';

it('carries arrangement between the graph and its model', () => {
  const graph = { nodes: [], edges: [], arrange: true };
  const model = documentOf(graph, '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId);
  expect(model).toHaveProperty('arrange', true);
  expect(graphOf(model)).toEqual(graph);
});

it.each(['add', 'delete', 'group', 'parent', 'ungroup', 'insert'] as const)(
  'keeps arrangement through %s',
  (change) => {
    const graph = {
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 200, 0, { selected: true })],
      edges: [],
      arrange: true,
    };
    const grouped = { ...groupSelection(graph, 'frame', 'G'), arrange: true };
    const result =
      change === 'add'
        ? addAgent(graph, 'c', { x: 500, y: 200 })
        : change === 'delete'
          ? deleteSelection(graph)
          : change === 'group'
            ? groupSelection(graph, 'frame', 'G')
            : change === 'parent'
              ? addParent(grouped, 'G')
              : change === 'ungroup'
                ? ungroupSelection(grouped)
                : insertGraph(
                    graph,
                    { nodes: [], edges: [] },
                    { group: 'G', name: 'Template', newId: () => 'new' },
                  );
    expect(result).toHaveProperty('arrange', true);
  },
);

/** An item measured at 100×40. */
function agentNode(id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'agent',
    position: { x, y },
    data: { label: id },
    measured: { width: 100, height: 40 },
    ...extra,
  };
}

function frame(id: string, x: number, y: number, width: number, height: number): GraphNode {
  return {
    id,
    type: 'frame',
    position: { x, y },
    data: { label: id },
    width,
    height,
    measured: { width, height },
  };
}

function inside(parentId: string, node: GraphNode): GraphNode {
  return { ...node, parentId };
}

function selected(node: GraphNode): GraphNode {
  return { ...node, selected: true };
}

function edge(source: string, target: string, extra: Partial<Edge> = {}): Edge {
  return { id: `${source}->${target}`, source, target, ...extra };
}

/** Freezes the graph deeply, so any mutation by an operation throws. */
function frozen(nodes: GraphNode[], edges: Edge[] = []): Graph {
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  const graph = { nodes, edges };
  freeze(graph);
  return graph;
}

function get(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function abs(graph: Graph, id: string): XYPosition {
  return absolutePosition(get(graph, id), new Map(graph.nodes.map((n) => [n.id, n])));
}

function absAll(graph: Graph, ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, abs(graph, id)]));
}

function selectedIds(graph: Graph) {
  return graph.nodes.filter((n) => n.selected).map((n) => n.id);
}

/**
 * Invariants every operation keeps: parents come before their children, React Flow's
 * `expandParent` is never used, and every container exactly fits its children: PADDING inside its
 * left, right and bottom edges and PADDING below the header zone at the top of its box.
 */
function expectValid(graph: Graph) {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  for (const [i, node] of graph.nodes.entries()) {
    expect(node.expandParent, node.id).toBeUndefined();
    if (node.parentId !== undefined) {
      expect(index.get(node.parentId), `${node.parentId} before ${node.id}`).toBeLessThan(i);
    }
    const children = graph.nodes.filter((n) => n.parentId === node.id);
    if (children.length === 0) continue;
    // A parent node's card straddles the box's top border, above the same header zone a frame has.
    const top = (node.type === 'frame' ? 0 : CARD_SIZE.height / 2) + HEADER + PADDING;
    const right = Math.max(...children.map((c) => c.position.x + size(c).width));
    const bottom = Math.max(...children.map((c) => c.position.y + size(c).height));
    expect(Math.min(...children.map((c) => c.position.x)), node.id).toBe(PADDING);
    expect(Math.min(...children.map((c) => c.position.y)), node.id).toBe(top);
    expect(node.width, node.id).toBe(right + PADDING);
    expect(node.height, node.id).toBe(bottom + PADDING);
    expect(node.measured, node.id).toEqual({ width: node.width, height: node.height });
  }
}

/** Frame H holding frame G holding frame F holding items c and d, all sized to fit. */
function nested(): GraphNode[] {
  return autosize([
    frame('H', 0, 0, 0, 0),
    inside('H', frame('G', 20, 52, 0, 0)),
    inside('G', frame('F', 20, 52, 0, 0)),
    inside('F', agentNode('c', 20, 52)),
    inside('F', agentNode('d', 20, 112)),
  ]);
}

/** `nodes` with node `id` moved to `position`, as a drag would leave it. */
function moved(nodes: GraphNode[], id: string, position: XYPosition): GraphNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, position } : n));
}

describe('queues', () => {
  const g = frozen([agentNode('a', 0, 0), agentNode('b', 0, 100)]);
  const first = { id: 'q1', action: 'Read' };
  const second = { id: 'q2', action: 'Edit', target: 'b' };
  const third = { id: 'q3', action: 'Bash' };
  const queued = [first, second, third].reduce((acc, q) => addToQueue(acc, 'a', q), g);
  const queueOf = (graph: Graph) => get(graph, 'a').data.queue ?? [];
  const order = (graph: Graph) => queueOf(graph).map((q) => q.id);

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
    const item = (graph: Graph, id: string) => queueOf(graph).find((q) => q.id === id);

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
    expect(queueOf(plan).at(-1)).toEqual({ id: 'ok1', approve: 'the plan in PLAN.md' });
    expect(queueOf(setApproval(asked, 'a', 'ok1', '')).at(-1)).toEqual({ id: 'ok1', approve: '' });
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
    const thenOf = (graph: Graph) => {
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
    const repeatOf = (graph: Graph) => {
      const found = queueOf(graph).find((q) => q.id === 'r1');
      return found && 'repeat' in found ? found : undefined;
    };
    const inner = (graph: Graph) => repeatOf(graph)?.repeat ?? [];

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
      const ids = (graph: Graph) => inner(graph).map((q) => q.id);
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
      // Its keys stay in the order the file writes them.
      expect(
        Object.keys(repeatOf(setRepeat(filled, 'a', 'r1', { otherwise: 'goOn' })) ?? {}),
      ).toEqual(['id', 'repeat', 'until', 'rounds', 'otherwise']);
    });
  });
});

describe('setAgent', () => {
  it('translates steps to the new CLI, including Ifs and repeats, keeping their instructions', () => {
    const queue: QueueItem[] = [
      { id: 'run', action: 'Bash', instruction: 'npm test', expect: 'fails' },
      { id: 'read', action: 'Read', target: 'b', instruction: 'REVIEW.md' },
      { id: 'custom', action: '/custom' },
      { id: 'message', message: 'Carry on', target: 'b' },
      { id: 'if', if: { kind: 'failed' }, then: [{ id: 'edit', action: 'Edit' }] },
      {
        id: 'loop',
        repeat: [
          { id: 'search', action: 'WebSearch', instruction: 'Find the package documentation' },
          { id: 'wait', waitFor: [{ agent: 'b' }] },
          { id: 'delay', delay: { seconds: 60 } },
        ],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
    ];
    const g = frozen([
      agentNode('a', 0, 0, { data: { label: 'a', queue } }),
      agentNode('b', 0, 100),
    ]);
    const changed = setAgent(g, 'a', 'codex');
    expect(get(changed, 'a').data.queue).toEqual([
      { id: 'run', action: 'exec_command', instruction: 'npm test', expect: 'fails' },
      { id: 'read', action: 'Read', target: 'b', instruction: 'REVIEW.md' },
      { id: 'custom', action: '/custom' },
      { id: 'message', message: 'Carry on', target: 'b' },
      { id: 'if', if: { kind: 'failed' }, then: [{ id: 'edit', action: 'apply_patch' }] },
      {
        id: 'loop',
        repeat: [
          { id: 'search', action: 'web_search', instruction: 'Find the package documentation' },
          { id: 'wait', waitFor: [{ agent: 'b' }] },
          { id: 'delay', delay: { seconds: 60 } },
        ],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
    ]);
    expect(get(changed, 'b')).toBe(get(g, 'b'));
    expect(get(g, 'a').data.queue).toEqual(queue);
  });

  it("sets a node's agent type; groups have none", () => {
    const g = frozen([agentNode('a', 0, 0), frame('F', 0, 100, 200, 200)]);
    const qwen = setAgent(g, 'a', 'qwen');
    expect(get(qwen, 'a').data.adapter).toBe('qwen');
    expect(setAgent(qwen, 'a', 'qwen')).toBe(qwen);
    expect(setAgent(g, 'F', 'qwen')).toBe(g);
  });

  it('drops a connection the new type does not offer', () => {
    const g = frozen([
      agentNode('a', 0, 0, { data: { label: 'a', connection: 'claude-code.terminal' } }),
    ]);
    expect(get(setAgent(g, 'a', 'codex'), 'a').data).toEqual({
      label: 'a',
      adapter: 'codex',
    });
  });
});

describe('setConnection', () => {
  it('switches real connections; unavailable types and groups cannot be connected', () => {
    const g = frozen([
      agentNode('a', 0, 0),
      agentNode('b', 0, 100, { data: { label: 'b', adapter: 'gemini' } }),
      frame('F', 0, 200, 200, 200),
    ]);
    const sdk = setConnection(g, 'a', 'claude-code.sdk');
    expect(get(sdk, 'a').data.connection).toBe('claude-code.sdk');
    expect(setConnection(sdk, 'a', 'claude-code.sdk')).toBe(sdk);
    expect(get(setConnection(sdk, 'a', 'claude-code.terminal'), 'a').data).toEqual({
      label: 'a',
      connection: 'claude-code.terminal',
    });
    expect(setConnection(sdk, 'a', 'unavailable')).toBe(sdk);
    expect(setConnection(g, 'b', 'claude-code.terminal')).toBe(g);
    expect(setConnection(g, 'F', 'claude-code.terminal')).toBe(g);
  });
});

describe('setSettings', () => {
  it('merges a model-only change, keeping saved mode, effort and other adapters', () => {
    const other = { model: 'gpt-6-luna', mode: 'auto' };
    const g = frozen([
      agentNode('a', 0, 0, {
        data: {
          label: 'a',
          settings: {
            'claude-code': { model: 'opus', effort: 'high', mode: 'plan' },
            codex: other,
          },
        },
      }),
    ]);
    const result = setSettings(g, 'a', 'claude-code', { model: 'haiku' });
    expect(get(result, 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', effort: 'high', mode: 'plan' },
      codex: other,
    });
    expect(get(result, 'a').data.settings?.codex).toBe(other);
    expect(
      get(setSettings(result, 'a', 'claude-code', { effort: null }), 'a').data.settings,
    ).toEqual({
      'claude-code': { model: 'haiku', mode: 'plan' },
      codex: other,
    });
    expect(get(setSettings(result, 'a', 'claude-code', {}), 'a').data.settings).toEqual(
      get(result, 'a').data.settings,
    );
  });

  it('sets what an agent runs with by one adapter, keeping the other’s; nothing set leaves nothing', () => {
    const g = frozen([agentNode('a', 0, 0), frame('F', 0, 200, 200, 200)]);
    const claude = setSettings(g, 'a', 'claude-code', { model: 'haiku', mode: 'plan' });
    const both = setSettings(claude, 'a', 'codex', { effort: 'low' });
    expect(get(both, 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', mode: 'plan' },
      codex: { effort: 'low' },
    });
    expect(get(setSettings(both, 'a', 'codex', { effort: null }), 'a').data.settings).toEqual({
      'claude-code': { model: 'haiku', mode: 'plan' },
    });
    expect(
      get(setSettings(claude, 'a', 'claude-code', { model: null, mode: null }), 'a').data,
    ).toEqual({ label: 'a' });
    expect(setSettings(g, 'F', 'claude-code', { model: 'haiku' })).toBe(g);
  });

  it('drops a saved mode the connection an agent switches to does not start in', () => {
    // Codex's App Server starts in Plan; its Terminal only in Read only (Plan is chosen in it).
    const planning = { codex: { model: 'gpt-6-luna', mode: 'plan' } };
    const g = frozen([
      agentNode('a', 0, 0, {
        data: { label: 'a', adapter: 'codex', connection: 'codex.app-server', settings: planning },
      }),
    ]);
    expect(get(setConnection(g, 'a', 'codex.terminal'), 'a').data.settings).toEqual({
      codex: { model: 'gpt-6-luna' },
    });
    // A mode it starts in stays, and so does what other adapters are set to.
    const reading = {
      codex: { model: 'gpt-6-luna', mode: 'read-only' },
      'claude-code': { mode: 'plan' },
    };
    const read = setSettings(g, 'a', 'codex', reading.codex);
    const both = setSettings(read, 'a', 'claude-code', reading['claude-code']);
    expect(get(setConnection(both, 'a', 'codex.terminal'), 'a').data.settings).toEqual(reading);
    // Switching adapter, it runs that adapter's first connection.
    const claude = setSettings(
      frozen([agentNode('b', 0, 0, { data: { label: 'b', adapter: 'codex' } })]),
      'b',
      'codex',
      { mode: 'plan' },
    );
    expect(get(setAgent(claude, 'b', 'claude-code'), 'b').data.settings).toEqual({
      codex: { mode: 'plan' },
    });
    const back = setSettings(setAgent(claude, 'b', 'claude-code'), 'b', 'claude-code', {});
    expect(get(setAgent(back, 'b', 'codex'), 'b').data).not.toHaveProperty('settings');
  });
});

describe('selectOnly', () => {
  it('selects only that node, deselecting other nodes and every edge', () => {
    const g = frozen(
      [selected(agentNode('a', 0, 0)), selected(agentNode('b', 0, 100)), agentNode('c', 0, 200)],
      [edge('a', 'b', { selected: true })],
    );
    const result = selectOnly(g, 'b');
    expect(selectedIds(result)).toEqual(['b']);
    expect(result.edges[0]?.selected).toBe(false);
    expect(get(result, 'b')).toBe(get(g, 'b'));
    expect(get(result, 'c')).toBe(get(g, 'c'));
  });

  it('returns the same graph when that node is already the only selected element', () => {
    const g = frozen([agentNode('a', 0, 0), selected(agentNode('b', 0, 100))], [edge('a', 'b')]);
    expect(selectOnly(g, 'b')).toBe(g);
  });
});

describe('autosize during a drag', () => {
  it('keeps the top-left corner of containers around a dragged node until the drag ends', () => {
    // React Flow only reports a drag move when the node's position in its container changes, so a
    // container that moved along with the node would swallow moves.
    const before = frozen(nested());
    const dragging = (nodes: GraphNode[], value: boolean) =>
      nodes.map((n) => (n.id === 'c' ? { ...n, dragging: value } : n));
    const out = autosize(dragging(moved(before.nodes, 'c', { x: -60, y: 300 }), true));
    for (const id of ['H', 'G', 'F']) {
      expect(get(frozen(out), id).position, id).toEqual(get(before, id).position);
    }
    // The right and bottom edges still follow: F now reaches down to c.
    expect(get(frozen(out), 'F').height).toBe(300 + 40 + PADDING);
    const dropped = frozen(autosize(dragging(out, false)));
    expect(absAll(dropped, ['c', 'd'])).toEqual(absAll(frozen(out), ['c', 'd']));
    expectValid(dropped);
  });
});

describe('canvasNodes', () => {
  it('are the model’s nodes: agents and groups, without how the view draws them', () => {
    const { nodes } = frozen([
      selected(frame('F', 0, 0, 300, 200)),
      inside(
        'F',
        agentNode('a', 20, 52, {
          data: {
            label: 'Builder',
            adapter: 'codex',
            connection: 'codex.app-server',
            role: 'Builds',
            queue: [{ id: 'm', message: 'Build it' }],
            color: 2,
          },
          dragging: true,
        }),
      ),
      agentNode('b', 400, 0),
    ]);
    expect(canvasNodes(nodes)).toEqual([
      { id: 'F', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'F' } },
      {
        id: 'a',
        type: 'agent',
        position: { x: 20, y: 52 },
        parentId: 'F',
        data: {
          label: 'Builder',
          adapter: 'codex',
          connection: 'codex.app-server',
          role: 'Builds',
          queue: [{ id: 'm', message: 'Build it' }],
          color: 2,
        },
      },
      { id: 'b', type: 'agent', position: { x: 400, y: 0 }, data: { label: 'b' } },
    ]);
  });

  it('keep a group’s label and colour, and nothing only an agent has, on a frame', () => {
    const team = {
      ...frame('F', 0, 0, 100, 100),
      data: { label: 'Team', color: 3, queue: [{ id: 'm', message: 'Stray' }] },
    };
    expect(canvasNodes(frozen([team]).nodes)).toEqual([
      { id: 'F', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team', color: 3 } },
    ]);
  });
});

describe('a canvas, drawn', () => {
  const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
  /** A group holding an agent, another agent outside it, and a link between the two. */
  const canvas: CanvasDocument = {
    id: ID,
    arrange: false,
    nodes: [
      { id: 'G', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team', color: 2 } },
      {
        id: 'a',
        type: 'agent',
        parentId: 'G',
        position: { x: 20, y: 52 },
        data: { label: 'Coder', adapter: 'codex' },
      },
      { id: 'b', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'Reviewer' } },
    ],
    links: [{ source: 'a', target: 'b', dots: ['bottom', 'top'] }],
  };

  it('draws a canvas with its groups sized to fit what they hold, and its links as edges', () => {
    const graph = graphOf(canvas);
    expectValid(graph);
    expect(graph.nodes.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      {
        id: 'G',
        width: PADDING + CARD_SIZE.width + PADDING,
        height: HEADER + PADDING + CARD_SIZE.height + PADDING,
      },
      { id: 'a', width: undefined, height: undefined },
      { id: 'b', width: undefined, height: undefined },
    ]);
    expect(graph.edges).toEqual([
      { id: 'a->b', source: 'a', target: 'b', sourceHandle: 'bottom', targetHandle: 'top' },
    ]);
  });

  it('keeps of a graph what the model keeps: no selection, sizes or edge ids', () => {
    const graph = graphOf(canvas);
    expect(documentOf(graph, ID)).toEqual(canvas);
    const drawn: Graph = {
      nodes: graph.nodes.map((n) => ({ ...n, selected: true, dragging: false })),
      edges: graph.edges.map((e) => ({ ...e, selected: true })),
    };
    expect(documentOf(drawn, ID)).toEqual(canvas);
    // An edge drawn without its dots keeps none.
    expect(documentOf({ ...graph, edges: [edge('a', 'b')] }, ID).links).toEqual([
      { source: 'a', target: 'b' },
    ]);
  });
});

describe('model edit projection', () => {
  it('keeps view measurements and applies selection hints while grouping model nodes', () => {
    const g = frozen([selected(agentNode('a', 100, 100)), selected(agentNode('b', 300, 200))]);
    const grouped = groupSelection(g, 'frame', 'F');
    expect(get(grouped, 'F')).toMatchObject({
      width: 340,
      height: 212,
      measured: { width: 340, height: 212 },
      selected: true,
    });
    expect(get(grouped, 'a').measured).toBe(g.nodes[0]?.measured);
    expect(selectedIds(grouped)).toEqual(['F']);
    expect(absAll(grouped, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(grouped);
  });
  it('keeps untouched view nodes identical during a rename and a link edit', () => {
    const g = frozen([
      selected(agentNode('a', 0, 0)),
      agentNode('b', 300, 0),
      frame('F', 600, 0, 100, 100),
    ]);
    const renamed = renameNode(g, 'a', 'Edited');
    expect(get(renamed, 'F')).toBe(g.nodes[2]);
    expect(get(renamed, 'a').selected).toBe(true);
    expect(get(renamed, 'a').measured).toBe(g.nodes[0]?.measured);
    const linked = connect(g, { source: 'a', target: 'b' });
    expect(linked.nodes).toBe(g.nodes);
    expect(get(linked, 'F')).toBe(g.nodes[2]);
    const renamedFrame = renameNode(g, 'F', 'Edited frame');
    expect(get(renamedFrame, 'F')).toMatchObject({ width: 100, height: 100 });
    expect(renamedFrame.edges).toBe(g.edges);
  });
});
