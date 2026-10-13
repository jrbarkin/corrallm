import type { Edge, XYPosition } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import {
  absolutePosition,
  addAgent,
  addParent,
  addToQueue,
  answerQuestion,
  areLinked,
  askUser,
  autosize,
  canConnect,
  canUngroup,
  connect,
  containerAt,
  deleteEdge,
  deleteSelection,
  editMessage,
  GROUP_COLORS,
  groupColors,
  EMPTY_FRAME,
  groupMembers,
  groupSelection,
  HEADER,
  CARD_SIZE,
  moveInQueue,
  nextLabel,
  PADDING,
  pendingQuestions,
  removeFromQueue,
  renameNode,
  retarget,
  selectOnly,
  setAgent,
  setCondition,
  setWaitFor,
  size,
  spawnAgent,
  ungroupSelection,
} from './graph';
import type { Graph, GraphNode } from './graph';
import { AgentType } from './agents';

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
function graphOf(nodes: GraphNode[], edges: Edge[] = []): Graph {
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

describe('nextLabel', () => {
  it('numbers past the largest existing label with the prefix', () => {
    expect(nextLabel([], 'Agent')).toBe('Agent 1');
    const nodes = ['Agent 2', 'Agent 7', 'Agent 9a', 'Group 12', 'Alpha'].map((label, i) =>
      agentNode(String(i), 0, 0, { data: { label } }),
    );
    expect(nextLabel(nodes, 'Agent')).toBe('Agent 8');
    expect(nextLabel(nodes, 'Group')).toBe('Group 13');
  });
});

describe('addAgent', () => {
  it('adds a selected item centred on the point and deselects everything else', () => {
    const g = graphOf([selected(agentNode('a', 0, 0))], [edge('a', 'a', { selected: true })]);
    const result = addAgent(g, 'n', { x: 200, y: 100 });
    expect(get(result, 'n')).toEqual({
      id: 'n',
      type: 'agent',
      position: { x: 125, y: 83 },
      // Its queue starts with a message to write: what the agent is to do.
      data: {
        label: 'Agent 1',
        agent: AgentType.Claude,
        queue: [{ id: 'n/message', message: '' }],
      },
      selected: true,
    });
    expect(selectedIds(result)).toEqual(['n']);
    expect(result.edges[0]?.selected).toBe(false);
  });

  it('nudges a node that would land on the corner of another', () => {
    let g = graphOf([]);
    for (const id of ['a', 'b', 'c']) g = addAgent(g, id, { x: 200, y: 100 });
    expect(g.nodes.map((n) => n.position)).toEqual([
      { x: 125, y: 83 },
      { x: 149, y: 107 },
      { x: 173, y: 131 },
    ]);
  });

  it('adds into the innermost container under the point, which grows to fit it', () => {
    // F at (100, 100) holds G at (120, 152), which holds x at (140, 204).
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', frame('G', 20, 52, 0, 0)),
        inside('G', agentNode('x', 20, 52)),
      ]),
    );
    const result = addAgent(g, 'n', { x: 250, y: 250 });
    expect(get(result, 'n').parentId).toBe('G');
    expect(abs(result, 'n')).toEqual({ x: 175, y: 233 });
    expect(abs(result, 'x')).toEqual(abs(g, 'x'));
    expect(abs(result, 'F')).toEqual(abs(g, 'F'));
    expectValid(result);
  });

  it('moves a container left and up for a node added past its padding, moving nothing else', () => {
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', frame('G', 20, 52, 0, 0)),
        inside('G', agentNode('x', 20, 52)),
      ]),
    );
    const result = addAgent(g, 'n', { x: 130, y: 220 }); // just inside G's left edge
    expect(get(result, 'n').parentId).toBe('G');
    expect(abs(result, 'n')).toEqual({ x: 55, y: 203 });
    expect(abs(result, 'x')).toEqual(abs(g, 'x'));
    expect(abs(result, 'F').x).toBeLessThan(100);
    expectValid(result);
  });
});

describe('spawnAgent', () => {
  /** Where the next card along a row goes: one card and the gap between neighbours further. */
  const NEXT = CARD_SIZE.width + 40;

  it('puts a peer beside the agent, in its row: of its type, selected, and not linked to it', () => {
    const codex = { label: 'a', agent: AgentType.Codex };
    const g = graphOf([selected(agentNode('a', 0, 0, { data: codex }))]);
    const result = spawnAgent(g, 'a', 'n', 'peer');
    expect(get(result, 'n')).toMatchObject({
      position: { x: 140, y: 0 },
      data: { label: 'Agent 1', agent: AgentType.Codex, queue: [{ id: 'n/message', message: '' }] },
    });
    expect(selectedIds(result)).toEqual(['n']);
    expect(result.edges).toEqual([]);
    // The next one lines up to its right.
    expect(get(spawnAgent(result, 'a', 'm', 'peer'), 'm').position).toEqual({
      x: 140 + NEXT,
      y: 0,
    });
  });

  it('puts a linked agent below the agent, linked to it, in a row of the ones linked before', () => {
    const g = graphOf([agentNode('a', 0, 0)]);
    const one = spawnAgent(g, 'a', 'n', 'linked');
    expect(get(one, 'n').position).toEqual({ x: 0, y: 100 });
    // Linked as drawing from the agent's bottom dot to the new one's top dot would.
    expect(one.edges).toEqual([
      { id: 'a->n', source: 'a', target: 'n', sourceHandle: 'bottom', targetHandle: 'top' },
    ]);
    const two = spawnAgent(one, 'a', 'm', 'linked');
    expect(get(two, 'm').position).toEqual({ x: NEXT, y: 100 });
    expect(two.edges.map((e) => e.id)).toEqual(['a->n', 'a->m']);
  });

  it('steps past every card and group in the way, but not past what is clear of its row', () => {
    const g = graphOf([
      agentNode('a', 0, 0),
      agentNode('b', 150, 20), // overlaps the first spot
      frame('F', 280, -100, 200, 150), // overlaps the spot past b
      agentNode('c', 520, 100), // below the row, clear of it
    ]);
    expect(abs(spawnAgent(g, 'a', 'n', 'peer'), 'n')).toEqual({ x: 520, y: 0 });
  });

  it("stays in the agent's group, which grows to fit it, moving nothing else", () => {
    const g = graphOf(autosize([frame('F', 100, 100, 0, 0), inside('F', agentNode('a', 20, 52))]));
    const peer = spawnAgent(g, 'a', 'n', 'peer');
    expect(get(peer, 'n').parentId).toBe('F');
    expect(abs(peer, 'n')).toEqual({ x: abs(g, 'a').x + 140, y: abs(g, 'a').y });
    expect(get(peer, 'F').width).toBeGreaterThan(get(g, 'F').width ?? 0);
    expect(absAll(peer, ['F', 'a'])).toEqual(absAll(g, ['F', 'a']));
    expectValid(peer);

    const linked = spawnAgent(g, 'a', 'n', 'linked');
    expect(get(linked, 'n').parentId).toBe('F');
    expect(abs(linked, 'n')).toEqual({ x: abs(g, 'a').x, y: abs(g, 'a').y + 100 });
    expectValid(linked);
  });

  it('spawns only from an agent', () => {
    const g = graphOf([frame('F', 0, 0, 200, 100)]);
    expect(spawnAgent(g, 'F', 'n', 'peer')).toBe(g);
    expect(spawnAgent(g, 'missing', 'n', 'linked')).toBe(g);
  });
});

describe('renameNode', () => {
  it('renames items and frames, accepting an empty label', () => {
    const g = graphOf([agentNode('a', 0, 0), frame('F', 0, 0, 100, 100)]);
    expect(get(renameNode(g, 'a', 'Alpha'), 'a').data.label).toBe('Alpha');
    expect(get(renameNode(g, 'F', ''), 'F').data.label).toBe('');
  });

  it('returns the same graph when nothing changes', () => {
    const g = graphOf([agentNode('a', 0, 0)]);
    expect(renameNode(g, 'a', 'a')).toBe(g);
    expect(renameNode(g, 'missing', 'x')).toBe(g);
  });
});

describe('queues', () => {
  const g = graphOf([agentNode('a', 0, 0), agentNode('b', 0, 100)]);
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

  describe('if-then', () => {
    const block = { id: 'if1', if: { kind: 'failed' as const }, then: [] };
    const withIf = addToQueue(queued, 'a', block);
    const step = (id: string) => ({ id, action: 'Read' });
    const filled = addToQueue(addToQueue(withIf, 'a', step('t1'), 'if1'), 'a', step('t2'), 'if1');
    const thenOf = (graph: Graph) => {
      const found = queueOf(graph).find((q) => q.id === 'if1');
      return found && 'then' in found ? found.then.map((q) => q.id) : undefined;
    };

    it('adds steps inside an if-then, not to the queue; never a wait', () => {
      expect(order(filled)).toEqual(['q1', 'q2', 'q3', 'if1']);
      expect(thenOf(filled)).toEqual(['t1', 't2']);
      expect(addToQueue(withIf, 'a', step('x'), 'q1')).toBe(withIf);
      expect(addToQueue(withIf, 'a', { id: 'w', waitFor: [{ agent: 'b' }] }, 'if1')).toBe(withIf);
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
});

describe('questions', () => {
  const g = graphOf([agentNode('a', 0, 0, { data: { label: 'Planner' } }), agentNode('b', 0, 100)]);
  const asked = askUser(
    askUser(g, 'a', { id: 'q1', text: 'Which branch?', options: ['main', 'dev'] }),
    'b',
    { id: 'q2', text: 'May I delete the cache?' },
  );

  it('lists the questions agents are waiting on, by agent', () => {
    expect(
      pendingQuestions(asked.nodes).map(({ agent, question }) => [agent.id, question.id]),
    ).toEqual([
      ['a', 'q1'],
      ['b', 'q2'],
    ]);
    expect(askUser(g, 'missing', { id: 'x', text: '?' })).toBe(g);
  });

  it('records an answer, which takes the question off the list', () => {
    const answered = answerQuestion(asked, 'a', 'q1', 'dev');
    expect(get(answered, 'a').data.questions).toEqual([
      { id: 'q1', text: 'Which branch?', options: ['main', 'dev'], answer: 'dev' },
    ]);
    expect(pendingQuestions(answered.nodes).map(({ question }) => question.id)).toEqual(['q2']);
    expect(answerQuestion(asked, 'a', 'missing', 'x')).toBe(asked);
  });
});

describe('setAgent', () => {
  it("sets a node's agent type; groups have none", () => {
    const g = graphOf([agentNode('a', 0, 0), frame('F', 0, 100, 200, 200)]);
    const qwen = setAgent(g, 'a', AgentType.Qwen);
    expect(get(qwen, 'a').data.agent).toBe(AgentType.Qwen);
    expect(setAgent(qwen, 'a', AgentType.Qwen)).toBe(qwen);
    expect(setAgent(g, 'F', AgentType.Qwen)).toBe(g);
  });
});

describe('selectOnly', () => {
  it('selects only that node, deselecting other nodes and every edge', () => {
    const g = graphOf(
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
    const g = graphOf([agentNode('a', 0, 0), selected(agentNode('b', 0, 100))], [edge('a', 'b')]);
    expect(selectOnly(g, 'b')).toBe(g);
  });
});

describe('connect', () => {
  const g = graphOf([
    agentNode('a', 0, 0),
    agentNode('b', 0, 100),
    frame('F', 300, 0, 200, 200),
    inside('F', agentNode('c', 20, 52)),
  ]);

  it('links two agents so they can talk: no arrowhead, between the dots it was drawn between', () => {
    const ab = connect(g, {
      source: 'a',
      target: 'b',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
    expect(ab.edges).toEqual([
      { id: 'a->b', source: 'a', target: 'b', sourceHandle: 'bottom', targetHandle: 'top' },
    ]);
    expect([areLinked(ab, 'a', 'b'), areLinked(ab, 'b', 'a'), areLinked(g, 'a', 'b')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('links two agents once, either way round', () => {
    const ab = connect(g, { source: 'a', target: 'b' });
    expect(connect(ab, { source: 'a', target: 'b' })).toBe(ab);
    expect(connect(ab, { source: 'b', target: 'a' })).toBe(ab);
    // Drawing between linked agents is still allowed: it can queue work instead.
    expect(canConnect(ab, { source: 'b', target: 'a' })).toBe(true);
  });

  it('rejects self-loops, frames and unknown nodes, but not containers', () => {
    for (const [source, target] of [
      ['a', 'a'],
      ['a', 'F'],
      ['F', 'a'],
      ['a', 'missing'],
    ] as const) {
      expect(canConnect(g, { source, target }), `${source}->${target}`).toBe(false);
      expect(connect(g, { source, target })).toBe(g);
    }
    expect(canConnect(g, { source: 'a', target: 'c' })).toBe(true);
  });
});

describe('deleteEdge', () => {
  it('deletes only that edge', () => {
    const g = graphOf(
      [agentNode('a', 0, 0), agentNode('b', 0, 100)],
      [edge('a', 'b'), edge('b', 'a')],
    );
    expect(deleteEdge(g, 'a->b').edges).toEqual([edge('b', 'a')]);
    expect(deleteEdge(g, 'missing')).toBe(g);
  });
});

describe('deleteSelection', () => {
  it('deletes the selected agents and edges, and the edges of deleted agents', () => {
    const g = graphOf(
      [selected(agentNode('a', 0, 0)), agentNode('b', 0, 100), agentNode('c', 0, 200)],
      [edge('a', 'b'), edge('c', 'a'), edge('b', 'c', { selected: true }), edge('c', 'b')],
    );
    const result = deleteSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(result.edges.map((e) => e.id)).toEqual(['c->b']);
  });

  it('returns the same graph when nothing is selected', () => {
    const g = graphOf([agentNode('a', 0, 0)], [edge('a', 'a')]);
    expect(deleteSelection(g)).toBe(g);
  });

  it('keeps the children of a deleted container, in place, in the nearest surviving ancestor', () => {
    const g = graphOf([
      frame('P', 10, 10, 300, 300),
      selected(inside('P', frame('F', 20, 40, 200, 200))),
      inside('F', agentNode('a', 5, 6)),
      frame('T', 500, 0, 300, 300),
      selected(inside('T', frame('U', 20, 52, 200, 200))),
      inside('U', selected(frame('V', 20, 52, 150, 120))),
      inside('V', agentNode('b', 20, 52)),
    ]);
    const result = deleteSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['P', 'a', 'T', 'b']);
    expect(get(result, 'a').parentId).toBe('P');
    expect(get(result, 'b').parentId).toBe('T');
    expect(absAll(result, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(result);
  });

  it('shrinks a container to fit what is left, and an emptied frame to its smallest size', () => {
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', agentNode('a', 20, 52)),
        selected(inside('F', agentNode('b', 300, 200))),
        frame('E', 600, 100, 0, 0),
        selected(inside('E', agentNode('e', 20, 52))),
      ]),
    );
    const result = deleteSelection(g);
    expect(get(result, 'F')).toMatchObject({
      position: { x: 100, y: 100 },
      width: 140,
      height: 112,
    });
    expect(get(result, 'E')).toMatchObject({ position: { x: 600, y: 100 }, ...EMPTY_FRAME });
    expectValid(result);
  });

  it('moves the children of a deleted top-level frame to the top level', () => {
    const g = graphOf([
      selected(frame('F', 100, 100, 300, 200)),
      inside('F', agentNode('a', 20, 52)),
    ]);
    expect(deleteSelection(g).nodes).toEqual([agentNode('a', 120, 152)]);
  });

  it('turns a parent node whose last child is deleted back into a plain node, keeping its edges', () => {
    const parent: GraphNode = { ...agentNode('p', 0, 0), width: 300, height: 200 };
    const g = graphOf(
      [parent, agentNode('b', 400, 0), selected(inside('p', agentNode('a', 20, 54)))],
      [edge('p', 'b')],
    );
    const result = deleteSelection(g);
    // Where its card was: centred on the box's top border.
    expect(get(result, 'p')).toEqual(agentNode('p', 75, 0));
    expect(result.edges).toEqual([edge('p', 'b')]);
  });
});

describe('groupMembers', () => {
  it('is empty when nothing is selected', () => {
    expect(groupMembers([agentNode('a', 0, 0)])).toEqual([]);
  });

  it('accepts a single node', () => {
    expect(groupMembers([selected(agentNode('a', 0, 0))]).map((n) => n.id)).toEqual(['a']);
  });

  it('leaves out selected agents whose container is also selected', () => {
    const nodes = [
      selected(frame('F', 0, 0, 300, 300)),
      selected(inside('F', frame('G', 20, 52, 200, 200))),
      selected(inside('G', agentNode('a', 20, 52))),
      selected(agentNode('b', 400, 0)),
    ];
    expect(groupMembers(nodes).map((n) => n.id)).toEqual(['F', 'b']);
  });

  it('is empty when the selected agents are in different containers', () => {
    const nodes = [frame('F', 0, 0, 300, 300), selected(inside('F', agentNode('a', 20, 52)))];
    expect(groupMembers([...nodes, selected(agentNode('b', 400, 0))])).toEqual([]);
  });
});

describe('groupSelection', () => {
  it('frames top-level nodes without moving them on screen', () => {
    const g = graphOf(
      [
        agentNode('x', 900, 900),
        selected(agentNode('a', 100, 100)),
        selected(agentNode('b', 300, 200)),
      ],
      [edge('a', 'b', { selected: true })],
    );
    const result = groupSelection(g, 'frame', 'F');
    expect(result.nodes.map((n) => n.id)).toEqual(['F', 'x', 'a', 'b']);
    expect(get(result, 'F')).toEqual({
      id: 'F',
      type: 'frame',
      position: { x: 80, y: 48 },
      data: { label: 'Group 1', color: 0 },
      width: 340,
      height: 212,
      measured: { width: 340, height: 212 },
      selected: true,
    });
    expect(get(result, 'a')).toMatchObject({
      parentId: 'F',
      position: { x: 20, y: 52 },
      selected: false,
    });
    expect(abs(result, 'b')).toEqual({ x: 300, y: 200 });
    expect(get(result, 'x')).toBe(g.nodes[0]);
    expect(result.edges[0]?.selected).toBe(false);
    expectValid(result);
  });

  it('creates a connectable parent node for the "item" kind', () => {
    const g = graphOf([
      selected(agentNode('a', 0, 0, { data: { label: 'Agent 1' } })),
      selected(agentNode('b', 0, 100, { data: { label: 'Agent 2' } })),
    ]);
    const result = groupSelection(g, 'agent', 'P');
    expect(get(result, 'P')).toMatchObject({
      type: 'agent',
      data: {
        label: 'Agent 3',
        agent: AgentType.Claude,
        queue: [{ id: 'P/message', message: '' }],
      },
      selected: true,
      position: { x: -20, y: -69 }, // the card sits above the box's top border, at y = 17
      width: 140,
      height: 229,
    });
    expect(absAll(result, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(result);
  });

  it('groups a single node', () => {
    const result = groupSelection(graphOf([selected(agentNode('a', 0, 0))]), 'frame', 'F');
    expect(get(result, 'a').parentId).toBe('F');
  });

  it('nests the new container in the shared parent, growing it so nothing moves', () => {
    const g = graphOf(
      autosize([
        frame('C', 100, 100, 0, 0),
        selected(inside('C', agentNode('a', 20, 52))),
        selected(inside('C', agentNode('b', 200, 52))),
        inside('C', agentNode('c', 20, 200)),
      ]),
    );
    const before = absAll(g, ['a', 'b', 'c']);
    const result = groupSelection(g, 'agent', 'N');
    expect(result.nodes.map((n) => n.id)).toEqual(['C', 'N', 'a', 'b', 'c']);
    expect(get(result, 'N')).toMatchObject({ parentId: 'C', position: { x: 20, y: 52 } });
    // C grows up and left around N, whose card sits above the old members.
    expect(get(result, 'C').position).toEqual({ x: 80, y: 31 });
    expect(absAll(result, ['a', 'b', 'c'])).toEqual(before);
    expectValid(result);
  });

  it('moves a container with its contents, even when some of them are selected too', () => {
    // A marquee around a container selects the container and everything inside it.
    const g = graphOf([
      selected(frame('F', 100, 100, 300, 200)),
      selected(inside('F', agentNode('a', 20, 52))),
      selected(agentNode('b', 500, 100)),
    ]);
    const result = groupSelection(g, 'frame', 'G');
    expect(get(result, 'F').parentId).toBe('G');
    expect(get(result, 'a')).toEqual({ ...g.nodes[1], selected: false });
    expect(abs(result, 'a')).toEqual({ x: 120, y: 152 });
    expect(selectedIds(result)).toEqual(['G']);
    expectValid(result);
  });

  it('returns the same graph when the selection cannot be grouped', () => {
    const g = graphOf([frame('F', 0, 0, 300, 300), selected(inside('F', agentNode('a', 20, 52)))]);
    const mixed = graphOf([...g.nodes, selected(agentNode('b', 400, 0))]);
    expect(groupSelection(mixed, 'frame', 'G')).toBe(mixed);
    expect(groupSelection(graphOf([agentNode('a', 0, 0)]), 'frame', 'G').nodes).toHaveLength(1);
  });
});

describe('addParent', () => {
  it('turns a frame into a parent node over the same children, without moving them', () => {
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', agentNode('a', 20, 52)),
        inside('F', agentNode('b', 200, 52)),
        agentNode('n', 0, 0, { data: { label: 'Agent 4' }, selected: true }),
      ]),
    );
    const result = addParent(g, 'F');
    expect(get(result, 'F')).toMatchObject({
      type: 'agent',
      data: {
        label: 'Agent 5',
        agent: AgentType.Claude,
        queue: [{ id: 'F/message', message: '' }],
      },
      selected: true,
    });
    expect(selectedIds(result)).toEqual(['F']);
    expect(absAll(result, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(result);
  });

  it("keeps the group's top border where it was, so the card appears where the '+' was", () => {
    const g = graphOf(autosize([frame('F', 100, 100, 0, 0), inside('F', agentNode('a', 20, 52))]));
    const parent = get(addParent(g, 'F'), 'F');
    expect(parent.position.y + CARD_SIZE.height / 2).toBe(100);
    expect(parent.position.x).toBe(100);
  });

  it('returns the same graph for anything but a frame', () => {
    const g = graphOf([agentNode('a', 0, 0)]);
    expect(addParent(g, 'a')).toBe(g);
    expect(addParent(g, 'missing')).toBe(g);
  });
});

describe('group colours', () => {
  const pair = (x: number, ids: [string, string]) =>
    ids.map((id, i) => selected(agentNode(id, x, i * 100)));
  const group = (g: Graph, id: string) => groupSelection(g, 'frame', id);
  const deselected = (g: Graph) => graphOf(g.nodes.map((n) => ({ ...n, selected: false })));

  it('gives each new group the next colour, reusing the least used one', () => {
    const one = group(graphOf(pair(0, ['a', 'b'])), 'F');
    const two = group(graphOf([...deselected(one).nodes, ...pair(400, ['c', 'd'])]), 'G');
    expect(get(two, 'F').data.color).toBe(0);
    expect(get(two, 'G').data.color).toBe(1);
    // With F gone, its colour is free again.
    const withoutF = deleteSelection(
      graphOf(deselected(two).nodes.map((n) => (n.id === 'F' ? { ...n, selected: true } : n))),
    );
    const three = group(graphOf([...withoutF.nodes, ...pair(800, ['e', 'f'])]), 'H');
    expect(get(three, 'H').data.color).toBe(0);
  });

  it('cycles through the palette once every colour is taken', () => {
    let g = graphOf([]);
    for (let i = 0; i <= GROUP_COLORS; i++) {
      g = group(
        graphOf([...deselected(g).nodes, ...pair(i * 400, [`a${String(i)}`, `b${String(i)}`])]),
        `G${String(i)}`,
      );
    }
    expect(get(g, `G${String(GROUP_COLORS)}`).data.color).toBe(0);
  });

  it("colours a group's nodes with its colour, and nested groups with their own", () => {
    const nodes = [
      { ...frame('F', 0, 0, 400, 400), data: { label: 'F', color: 2 } },
      inside('F', agentNode('a', 20, 52)),
      inside('F', { ...frame('G', 20, 120, 200, 200), data: { label: 'G', color: 5 } }),
      inside('G', agentNode('b', 20, 52)),
      agentNode('c', 600, 0),
    ];
    expect(Object.fromEntries(groupColors(nodes))).toEqual({ F: 2, a: 2, G: 5, b: 5 });
  });

  it('keeps the colour when a group gets a parent node', () => {
    const g = group(graphOf(pair(0, ['a', 'b'])), 'F');
    expect(get(addParent(g, 'F'), 'F').data.color).toBe(get(g, 'F').data.color);
  });
});

describe('ungroupSelection', () => {
  it('removes a frame and selects its children, in place', () => {
    const g = graphOf([
      selected(frame('F', 100, 100, 300, 200)),
      inside('F', agentNode('a', 20, 52)),
      inside('F', agentNode('b', 150, 60)),
    ]);
    const result = ungroupSelection(g);
    expect(result.nodes).toEqual([
      selected(agentNode('a', 120, 152)),
      selected(agentNode('b', 250, 160)),
    ]);
  });

  it('keeps a parent node and its edges, back as a plain node where its card was', () => {
    const parent: GraphNode = selected({ ...agentNode('p', 100, 100), width: 300, height: 200 });
    const g = graphOf(
      [parent, inside('p', agentNode('a', 20, 54)), agentNode('b', 500, 0)],
      [edge('p', 'b')],
    );
    const result = ungroupSelection(g);
    expect(get(result, 'p')).toEqual(agentNode('p', 175, 100, { selected: false }));
    expect(get(result, 'a')).toEqual(selected(agentNode('a', 120, 154)));
    expect(result.edges).toEqual(g.edges);
  });

  it('moves children of a nested container into the outer one', () => {
    const g = graphOf([
      frame('F', 100, 100, 400, 300),
      selected(inside('F', frame('G', 20, 52, 200, 150))),
      inside('G', agentNode('a', 20, 52)),
    ]);
    const result = ungroupSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['F', 'a']);
    expect(get(result, 'a').parentId).toBe('F');
    expect(abs(result, 'a')).toEqual(abs(g, 'a'));
    expectValid(result);
  });

  it('ungroups only the outermost of nested selected containers', () => {
    const g = graphOf([
      selected(frame('F', 100, 100, 400, 300)),
      selected(inside('F', frame('G', 20, 52, 200, 150))),
      inside('G', agentNode('a', 20, 52)),
    ]);
    const result = ungroupSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['G', 'a']);
    expect(get(result, 'a').parentId).toBe('G');
    expect(abs(result, 'a')).toEqual(abs(g, 'a'));
  });

  it('moves a selected child out of its container', () => {
    const g = graphOf([
      frame('F', 100, 100, 400, 300),
      selected(inside('F', agentNode('a', 20, 52))),
      inside('F', agentNode('b', 200, 52)),
    ]);
    const result = ungroupSelection(g);
    expect(get(result, 'a')).toEqual(selected(agentNode('a', 120, 152)));
    expect(get(result, 'b').parentId).toBe('F');
    expectValid(result);
  });

  it('shrinks a parent node whose last child moves out', () => {
    const g = graphOf([
      { ...agentNode('p', 0, 0), width: 300, height: 200 },
      selected(inside('p', agentNode('a', 20, 52))),
    ]);
    expect(get(ungroupSelection(g), 'p').width).toBeUndefined();
  });

  it('removes a selected empty frame', () => {
    expect(ungroupSelection(graphOf([selected(frame('F', 0, 0, 100, 100))])).nodes).toEqual([]);
  });

  it('does nothing for a top-level node', () => {
    const g = graphOf([selected(agentNode('a', 0, 0))]);
    expect(canUngroup(g.nodes)).toBe(false);
    expect(ungroupSelection(g)).toBe(g);
  });
});

describe('autosize', () => {
  it('grows every container around a child dragged past their right and bottom', () => {
    const before = nested();
    expect(before.map((n) => [n.id, n.width, n.height])).toEqual([
      ['H', 220, 316],
      ['G', 180, 244],
      ['F', 140, 172],
      ['c', undefined, undefined],
      ['d', undefined, undefined],
    ]);
    const dragged = moved(before, 'd', { x: 300, y: 200 });
    const result = autosize(dragged);
    expect(result.map((n) => [n.id, n.position, n.width, n.height])).toEqual([
      ['H', { x: 0, y: 0 }, 500, 404],
      ['G', { x: 20, y: 52 }, 460, 332],
      ['F', { x: 20, y: 52 }, 420, 260],
      ['c', { x: 20, y: 52 }, undefined, undefined],
      ['d', { x: 300, y: 200 }, undefined, undefined],
    ]);
    expect(result[3]).toBe(dragged[3]);
    expectValid(graphOf(result));
  });

  it('grows containers left and up for a child dragged past their top-left, moving nothing on screen', () => {
    const before = graphOf(nested());
    const dragged = graphOf(moved(before.nodes, 'c', { x: -60, y: -90 }));
    const result = graphOf(autosize(dragged.nodes));
    expect(absAll(result, ['c', 'd'])).toEqual(absAll(dragged, ['c', 'd']));
    expect(get(result, 'c').position).toEqual({ x: 20, y: 52 });
    // Each container grew only left and up: its right and bottom edges stay where they were.
    for (const id of ['H', 'G', 'F']) {
      const was = get(before, id);
      const now = get(result, id);
      expect(abs(result, id).x + (now.width ?? 0), id).toBe(abs(before, id).x + (was.width ?? 0));
      expect(abs(result, id).y + (now.height ?? 0), id).toBe(abs(before, id).y + (was.height ?? 0));
    }
    expectValid(result);
  });

  it('shrinks every container around a child dragged back inward', () => {
    const grown = autosize(moved(nested(), 'd', { x: 300, y: 200 }));
    const result = autosize(moved(grown, 'd', { x: 20, y: 112 }));
    expect(result).toEqual(nested());
  });

  it('keeps the top-left corner of containers around a dragged node until the drag ends', () => {
    // React Flow only reports a drag move when the node's position in its container changes, so a
    // container that moved along with the node would swallow moves.
    const before = graphOf(nested());
    const dragging = (nodes: GraphNode[], value: boolean) =>
      nodes.map((n) => (n.id === 'c' ? { ...n, dragging: value } : n));
    const out = autosize(dragging(moved(before.nodes, 'c', { x: -60, y: 300 }), true));
    for (const id of ['H', 'G', 'F']) {
      expect(get(graphOf(out), id).position, id).toEqual(get(before, id).position);
    }
    // The right and bottom edges still follow: F now reaches down to c.
    expect(get(graphOf(out), 'F').height).toBe(300 + 40 + PADDING);
    const dropped = graphOf(autosize(dragging(out, false)));
    expect(absAll(dropped, ['c', 'd'])).toEqual(absAll(graphOf(out), ['c', 'd']));
    expectValid(dropped);
  });

  it('shrinks a childless frame to EMPTY_FRAME and turns a childless parent node into its card', () => {
    const result = autosize([
      frame('F', 100, 100, 400, 300),
      { ...agentNode('p', 0, 0), width: 300, height: 200 },
    ]);
    expect(result[0]).toMatchObject({ position: { x: 100, y: 100 }, ...EMPTY_FRAME });
    expect(result[1]).toEqual(agentNode('p', 75, 0));
  });

  it('returns the same array when every container fits', () => {
    const nodes = graphOf([...nested(), agentNode('z', -500, -500)]).nodes;
    expect(autosize(nodes)).toBe(nodes);
    expect(autosize([])).toEqual([]);
  });
});

describe('containerAt', () => {
  const nodes = [
    frame('F', 0, 0, 500, 400),
    inside('F', frame('G', 20, 52, 200, 200)),
    frame('H', 400, 300, 300, 300),
    agentNode('p', 1000, 0, { width: 200, height: 200, measured: { width: 200, height: 200 } }),
    inside('p', agentNode('c', 20, 52)),
    agentNode('leaf', 1000, 500),
  ];

  it('finds the innermost container under the point', () => {
    expect(containerAt(nodes, { x: 50, y: 100 })?.id).toBe('G');
    expect(containerAt(nodes, { x: 300, y: 100 })?.id).toBe('F');
    expect(containerAt(nodes, { x: 450, y: 350 })?.id).toBe('H');
    expect(containerAt(nodes, { x: 1100, y: 150 })?.id).toBe('p');
  });

  it('ignores items without children and empty canvas', () => {
    expect(containerAt(nodes, { x: 1050, y: 510 })).toBeUndefined();
    expect(containerAt(nodes, { x: 900, y: 900 })).toBeUndefined();
  });
});
