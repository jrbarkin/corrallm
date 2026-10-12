import { describe, expect, it } from 'vitest';

import { fromFile, toFile } from './file';
import { autosize } from './graph';
import type { Graph, GraphNode } from './graph';
import type { QueueItem } from './queue';

const queue: QueueItem[] = [
  { id: 'w', waitFor: [{ agent: 'b' }, { agent: 'b', item: 'x' }] },
  { id: 'm', message: 'Fix the flaky test', target: 'b' },
  {
    id: 'i',
    if: { kind: 'freeText', text: 'the tests pass' },
    then: [{ id: 's', action: 'Bash', target: 'b' }],
  },
];

/** A group holding an agent, another agent outside it, and a link between the two. */
const graph: Graph = {
  nodes: [
    {
      id: 'G',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { label: 'Team', color: 2 },
      width: 400,
      height: 300,
      selected: true,
    },
    {
      id: 'a',
      type: 'agent',
      parentId: 'G',
      position: { x: 20, y: 52 },
      data: {
        label: 'Coder',
        agent: 'Codex',
        queue,
        questions: [{ id: 'q', text: 'Which branch?' }],
      },
      measured: { width: 150, height: 34 },
    },
    { id: 'b', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'Reviewer' } },
  ],
  edges: [
    {
      id: 'a->b',
      source: 'a',
      target: 'b',
      sourceHandle: 'bottom',
      targetHandle: 'top',
      selected: true,
    },
  ],
};

/** The file `graph` saves as, parsed. */
const saved = {
  format: 'corrallm',
  version: 1,
  nodes: [
    { id: 'G', kind: 'group', label: 'Team', position: { x: 0, y: 0 }, color: 2 },
    {
      id: 'a',
      kind: 'agent',
      label: 'Coder',
      position: { x: 20, y: 52 },
      parent: 'G',
      agent: 'Codex',
      queue,
    },
    { id: 'b', kind: 'agent', label: 'Reviewer', position: { x: 600, y: 0 } },
  ],
  links: [{ agents: ['a', 'b'], dots: ['bottom', 'top'] }],
};

describe('toFile', () => {
  it('writes the canvas as readable JSON, leaving out selection, sizes and questions', () => {
    const text = toFile(graph);
    expect(JSON.parse(text)).toEqual(saved);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'format',
      'version',
      'nodes',
      'links',
    ]);
    expect(text).toMatch(/^\{\n {2}"format": "corrallm",\n/);
    expect(text.endsWith('}\n')).toBe(true);
  });
});

describe('fromFile', () => {
  it('reads back what was saved, with groups sized to fit what they hold', () => {
    const plain = (node: GraphNode): GraphNode => {
      const { id, type, position, parentId } = node;
      const { label, agent, color, queue: items } = node.data;
      return {
        id,
        type,
        position,
        ...(parentId === undefined ? {} : { parentId }),
        data: {
          label,
          ...(agent === undefined ? {} : { agent }),
          ...(color === undefined ? {} : { color }),
          ...(items === undefined ? {} : { queue: items }),
        },
      };
    };
    const loaded = fromFile(toFile(graph));
    expect(loaded).toEqual({
      nodes: autosize(graph.nodes.map(plain)),
      edges: [
        { id: 'a->b', source: 'a', target: 'b', sourceHandle: 'bottom', targetHandle: 'top' },
      ],
    });
    expect(toFile(loaded)).toBe(toFile(graph));
  });

  it('reads a wait for an agent written as just its id', () => {
    const file = structuredClone(saved);
    Object.assign(file.nodes[1] ?? {}, { queue: [{ id: 'w', waitFor: ['b'] }] });
    expect(fromFile(JSON.stringify(file)).nodes[1]?.data.queue).toEqual([
      { id: 'w', waitFor: [{ agent: 'b' }] },
    ]);
  });

  it('puts parents before their children, whatever order the file lists them in', () => {
    const [group, ...rest] = saved.nodes;
    const loaded = fromFile(JSON.stringify({ ...saved, nodes: [...rest, group] }));
    expect(loaded.nodes.map((n) => n.id)).toEqual(['G', 'a', 'b']);
  });

  it('rejects what is not a canvas, and canvases from a newer version', () => {
    expect(() => fromFile('not json')).toThrow('This is not a corrallm canvas');
    expect(() => fromFile('{"format": "other"}')).toThrow('This is not a corrallm canvas');
    expect(() => fromFile(JSON.stringify({ ...saved, version: 2 }))).toThrow(
      'This canvas was made by a newer version of corrallm',
    );
  });

  it.each<[string, (file: typeof saved) => void, RegExp]>([
    [
      'a missing label',
      (f) => {
        Reflect.deleteProperty(f.nodes[0] ?? {}, 'label');
      },
      /^nodes\[0\]\.label must be text$/,
    ],
    [
      'an unknown agent',
      (f) => Object.assign(f.nodes[1] ?? {}, { agent: 'Eliza' }),
      /nodes\[1\]\.agent/,
    ],
    [
      'a repeated id',
      (f) => Object.assign(f.nodes[2] ?? {}, { id: 'a' }),
      /nodes\[2\]\.id: "a" is used twice/,
    ],
    [
      'a missing parent',
      (f) => Object.assign(f.nodes[1] ?? {}, { parent: 'X' }),
      /nodes\[1\]\.parent/,
    ],
    [
      'a node inside itself',
      (f) => Object.assign(f.nodes[0] ?? {}, { parent: 'a' }),
      /nodes\[\d\]\.parent: "\w" is inside itself/,
    ],
    [
      'a broken condition',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'i', if: { kind: 'maybe' }, then: [] }] }),
      /nodes\[1\]\.queue\[0\]\.if/,
    ],
    [
      'a wait inside an if-then',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'i', if: { kind: 'failed' }, then: [{ id: 'w', waitFor: [{ agent: 'b' }] }] },
          ],
        }),
      /nodes\[1\]\.queue\[0\]\.then\[0\]: an if-then cannot hold a wait/,
    ],
    [
      'a wait for nobody',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'w', waitFor: [] }] }),
      /nodes\[1\]\.queue\[0\]\.waitFor must name at least one agent/,
    ],
    [
      'a wait for a step without its agent',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'w', waitFor: [{ item: 's' }] }] }),
      /nodes\[1\]\.queue\[0\]\.waitFor\[0\]\.agent must be non-empty text/,
    ],
    [
      'a link to a missing agent',
      (f) => Object.assign(f, { links: [{ agents: ['a', 'X'] }] }),
      /links\[0\]\.agents/,
    ],
  ])('rejects %s, saying where', (_label, breakIt, message) => {
    const file = structuredClone(saved);
    breakIt(file);
    expect(() => fromFile(JSON.stringify(file))).toThrow(message);
  });
});
