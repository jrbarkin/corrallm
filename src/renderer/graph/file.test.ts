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

  it('reads back delays, time limits on waits, and the condition that a wait ran out of time', () => {
    const timed: QueueItem[] = [
      { id: 'cool-off', delay: { seconds: 600 } },
      { id: 'morning', delay: { at: '09:00' } },
      { id: 'built', waitFor: [{ agent: 'b' }], timeout: { seconds: 1800 } },
      { id: 'by-six', waitFor: [{ agent: 'b', item: 'x' }], timeout: { at: '18:00' } },
      {
        id: 'late',
        if: { kind: 'timedOut' },
        then: [{ id: 'nudge', message: 'Wrap up and commit what you have.', target: 'b' }],
      },
    ];
    const withTimes: Graph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'a' ? { ...n, data: { ...n.data, queue: timed } } : n,
      ),
    };
    const text = toFile(withTimes);
    expect(text).toContain('"delay": {\n');
    expect(fromFile(text).nodes.find((n) => n.id === 'a')?.data.queue).toEqual(timed);
    expect(toFile(fromFile(text))).toBe(text);
  });

  it('reads back OKs, on what they name or (no words) on the work before them', () => {
    const asked: QueueItem[] = [
      { id: 'spec', message: 'Write SPEC.md' },
      { id: 'spec-ok', approve: 'the spec in SPEC.md' },
      { id: 'ok', approve: '' },
    ];
    const withOks: Graph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'a' ? { ...n, data: { ...n.data, queue: asked } } : n,
      ),
    };
    const text = toFile(withOks);
    expect(text).toContain(
      '{\n          "id": "spec-ok",\n          "approve": "the spec in SPEC.md"\n',
    );
    expect(fromFile(text).nodes.find((n) => n.id === 'a')?.data.queue).toEqual(asked);
    expect(toFile(fromFile(text))).toBe(text);
  });

  it('reads back repeats, keys in the order the app writes them; older files read as before', () => {
    const looped: QueueItem[] = [
      { id: 'tests-ready', waitFor: [{ agent: 'b' }] },
      {
        id: 'green-loop',
        repeat: [
          { id: 'implement', message: 'Make the tests pass' },
          { id: 'green', action: 'Bash' },
          { id: 'reviewed', waitFor: [{ agent: 'b', item: 'review' }], timeout: { seconds: 600 } },
          { id: 'cool-off', delay: { seconds: 60 } },
        ],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
      {
        id: 'follow',
        repeat: [],
        until: { kind: 'repeatEnds', agent: 'b', item: 'reviewing' },
        rounds: 1,
        otherwise: 'goOn',
      },
      {
        id: 'judged',
        repeat: [{ id: 'judge', message: 'Judge' }],
        until: { kind: 'outputContains', text: 'WINNER' },
        rounds: 20,
        otherwise: 'goOn',
      },
    ];
    const withRepeats: Graph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'a' ? { ...n, data: { ...n.data, queue: looped } } : n,
      ),
    };
    const text = toFile(withRepeats);
    expect(text).toMatch(
      /\{\n {10}"id": "green-loop",\n {10}"repeat": \[[^]*\],\n {10}"until": \{\n {12}"kind": "succeeded"\n {10}\},\n {10}"rounds": 3,\n {10}"otherwise": "ask"\n/,
    );
    expect(fromFile(text).nodes.find((n) => n.id === 'a')?.data.queue).toEqual(looped);
    expect(toFile(fromFile(text))).toBe(text);
    // A file from before repeats reads just as it did.
    expect(fromFile(JSON.stringify(saved)).nodes[1]?.data.queue).toEqual(queue);
  });

  it('saves how a Claude agent runs when it is connected, and reads it back', () => {
    const connected: Graph = {
      nodes: [
        {
          id: 't',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: { label: 'T', connection: 'terminal' },
        },
        {
          id: 's',
          type: 'agent',
          position: { x: 200, y: 0 },
          data: { label: 'S', agent: 'Claude', connection: 'sdk' },
        },
      ],
      edges: [],
    };
    const file = JSON.parse(toFile(connected)) as typeof saved;
    expect(file.nodes.map((n) => ('connection' in n ? n.connection : undefined))).toEqual([
      'terminal',
      'sdk',
    ]);
    expect(fromFile(toFile(connected)).nodes.map((n) => n.data.connection)).toEqual([
      'terminal',
      'sdk',
    ]);
    // Simulated is the default: written, it reads as no connection at all.
    const simulated = structuredClone(saved);
    Object.assign(simulated.nodes[2] ?? {}, { connection: 'simulated' });
    expect(fromFile(JSON.stringify(simulated)).nodes[2]?.data).toEqual({ label: 'Reviewer' });
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
      'an unknown connection',
      (f) => Object.assign(f.nodes[2] ?? {}, { connection: 'ssh' }),
      /^nodes\[2\]\.connection must be one of: simulated, terminal, sdk$/,
    ],
    [
      'a connection its agent type does not offer',
      (f) => Object.assign(f.nodes[1] ?? {}, { connection: 'terminal' }),
      /^nodes\[1\]\.connection: Codex agents can only be simulated$/,
    ],
    [
      'a group with a connection',
      (f) => Object.assign(f.nodes[0] ?? {}, { connection: 'sdk' }),
      /^nodes\[0\]\.connection: a group has no connection$/,
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
      /^nodes\[1\]\.queue\[0\]\.if\.kind must be one of: succeeded, failed, outputContains, timedOut, freeText$/,
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
      'a delay of no time',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'd', delay: { seconds: 0 } }] }),
      /^nodes\[1\]\.queue\[0\]\.delay\.seconds must be a whole number from 1 to 604800$/,
    ],
    [
      'a delay of part of a second',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'd', delay: { seconds: 1.5 } }] }),
      /^nodes\[1\]\.queue\[0\]\.delay\.seconds must be a whole number from 1 to 604800$/,
    ],
    [
      'a delay longer than a week',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'd', delay: { seconds: 604801 } }] }),
      /^nodes\[1\]\.queue\[0\]\.delay\.seconds must be/,
    ],
    [
      'a time of day without its leading zero',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'd', delay: { at: '9:00' } }] }),
      /^nodes\[1\]\.queue\[0\]\.delay\.at must be a time like "09:00"$/,
    ],
    [
      'a time of day past the end of the day',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'd', delay: { at: '24:00' } }] }),
      /^nodes\[1\]\.queue\[0\]\.delay\.at must be a time like "09:00"$/,
    ],
    [
      'a time that is both a length and a time of day',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'd', delay: { seconds: 60, at: '09:00' } }],
        }),
      /^nodes\[1\]\.queue\[0\]\.delay must have seconds or at$/,
    ],
    [
      'a time limit that is neither',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'w', waitFor: [{ agent: 'b' }], timeout: {} }],
        }),
      /^nodes\[1\]\.queue\[0\]\.timeout must have seconds or at$/,
    ],
    [
      'a delay inside an if-then',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'i', if: { kind: 'failed' }, then: [{ id: 'd', delay: { seconds: 60 } }] }],
        }),
      /^nodes\[1\]\.queue\[0\]\.then\[0\]: an if-then cannot hold a delay$/,
    ],
    [
      'an OK whose words are not text',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'ok', approve: true }] }),
      /^nodes\[1\]\.queue\[0\]\.approve must be text$/,
    ],
    [
      'an OK without words',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'ok', approve: null }] }),
      /^nodes\[1\]\.queue\[0\]\.approve must be text$/,
    ],
    [
      'an OK inside an if-then',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'i', if: { kind: 'failed' }, then: [{ id: 'ok', approve: '' }] }],
        }),
      /^nodes\[1\]\.queue\[0\]\.then\[0\]: an if-then cannot hold an OK$/,
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
      'a repeat of no rounds',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'r', repeat: [], until: { kind: 'succeeded' }, rounds: 0, otherwise: 'ask' },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.rounds must be a whole number from 1 to 20$/,
    ],
    [
      'a repeat of too many rounds',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'r', repeat: [], until: { kind: 'succeeded' }, rounds: 21, otherwise: 'ask' },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.rounds must be a whole number from 1 to 20$/,
    ],
    [
      'a repeat of part of a round',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'r', repeat: [], until: { kind: 'succeeded' }, rounds: 2.5, otherwise: 'ask' },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.rounds must be a whole number from 1 to 20$/,
    ],
    [
      'a repeat that does something unknown after its last round',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'r', repeat: [], until: { kind: 'succeeded' }, rounds: 3, otherwise: 'retry' },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.otherwise must be "ask" or "goOn"$/,
    ],
    [
      'a repeat until a wait runs out of time',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'r', repeat: [], until: { kind: 'timedOut' }, rounds: 3, otherwise: 'ask' },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.until\.kind must be one of: succeeded, failed, outputContains, freeText, repeatEnds$/,
    ],
    [
      'a repeat that follows nobody',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'r',
              repeat: [],
              until: { kind: 'repeatEnds', agent: 'b' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.until\.item must be non-empty text$/,
    ],
    [
      'an if-then inside a repeat',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'r',
              repeat: [{ id: 'i', if: { kind: 'failed' }, then: [] }],
              until: { kind: 'succeeded' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.repeat\[0\]: a repeat cannot hold an if-then$/,
    ],
    [
      'a repeat inside a repeat',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'r',
              repeat: [
                { id: 'r2', repeat: [], until: { kind: 'failed' }, rounds: 3, otherwise: 'ask' },
              ],
              until: { kind: 'succeeded' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.repeat\[0\]: a repeat cannot hold a repeat$/,
    ],
    [
      'an OK inside a repeat',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'r',
              repeat: [{ id: 'ok', approve: '' }],
              until: { kind: 'succeeded' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.repeat\[0\]: a repeat cannot hold an OK$/,
    ],
    [
      'a repeat inside an if-then',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'i',
              if: { kind: 'failed' },
              then: [
                { id: 'r', repeat: [], until: { kind: 'succeeded' }, rounds: 3, otherwise: 'ask' },
              ],
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.then\[0\]: an if-then cannot hold a repeat$/,
    ],
    [
      'an id inside a repeat that its queue already uses',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'x', action: 'Read' },
            {
              id: 'r',
              repeat: [{ id: 'x', message: 'Again' }],
              until: { kind: 'succeeded' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        }),
      /^nodes\[1\]\.queue\[1\]\.repeat\[0\]\.id: "x" is used twice in this queue$/,
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
