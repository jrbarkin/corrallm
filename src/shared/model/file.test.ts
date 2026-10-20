import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import { TEST_CATALOG, TEST_ENGINE } from '../engine/test-engine';
import { MAX_NODE_ID } from './canvas';
import type { AgentData, AgentNode, CanvasDocument } from './canvas';
import { fromFile, toFile } from './file';
import type { QueueItem } from './queue';

/** The canvas's id, which its file holds. */
const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;

/** A file's canvas, read as the app reads it: an agent naming no adapter runs Claude Code. */
const read = (text: string) => fromFile(text, TEST_CATALOG, 'claude-code');

/** What canvas `canvas`'s agent `id` is, if it has one by that id. */
const agentData = (canvas: CanvasDocument, id: string): AgentData | undefined =>
  canvas.nodes.find((n): n is AgentNode => n.id === id && n.type === 'agent')?.data;

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
      data: { label: 'Coder', adapter: 'codex', queue },
    },
    { id: 'b', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'Reviewer' } },
  ],
  links: [{ source: 'a', target: 'b', dots: ['bottom', 'top'] }],
};

/** The canvas with agent `a`'s queue `items`. */
const withQueue = (items: QueueItem[]): CanvasDocument => ({
  ...canvas,
  nodes: canvas.nodes.map((n) =>
    n.id === 'a' && n.type === 'agent' ? { ...n, data: { ...n.data, queue: items } } : n,
  ),
});

/** The file `canvas` saves as, parsed. */
const saved = {
  format: 'corrallm',
  version: 2,
  id: ID,
  nodes: [
    { id: 'G', kind: 'group', label: 'Team', position: { x: 0, y: 0 }, color: 2 },
    {
      id: 'a',
      kind: 'agent',
      label: 'Coder',
      position: { x: 20, y: 52 },
      parent: 'G',
      adapter: 'codex',
      queue,
    },
    { id: 'b', kind: 'agent', label: 'Reviewer', position: { x: 600, y: 0 } },
  ],
  links: [{ agents: ['a', 'b'], dots: ['bottom', 'top'] }],
};

describe('toFile', () => {
  it('round-trips arrangement and writes it only when on', () => {
    const on = { ...canvas, arrange: true };
    expect(JSON.parse(toFile(on))).toHaveProperty('arrange', true);
    expect(read(toFile(on))).toEqual(on);
    expect(JSON.parse(toFile({ ...canvas, arrange: false }))).not.toHaveProperty('arrange');
  });

  it('reads an old file without arrangement as off and writes it back unchanged', () => {
    const text = `${JSON.stringify(saved, null, 2)}\n`;
    const loaded = read(text);
    expect(loaded).toHaveProperty('arrange', false);
    expect(toFile(loaded)).toBe(text);
  });

  it.each([null, 'true', 1, {}])('refuses a non-boolean arrange: %j', (arrange) => {
    expect(() => read(JSON.stringify({ ...saved, arrange }))).toThrow('arrange must be a boolean');
  });

  it('writes a canvas the same whatever order its fields were set in, as it reads them', () => {
    /** `value` with its objects' fields set in the reverse order, at every depth. */
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, one]) => [key, reversed(one)]),
            )
          : value;
    const settings = {
      codex: { model: 'gpt-6-luna', effort: 'low', mode: 'read-only' },
      'claude-code': { model: 'opus', mode: 'plan' },
    };
    const everything: QueueItem[] = [
      ...queue,
      { id: 's2', action: 'Bash', target: 'b', instruction: 'npm test', expect: 'fails' },
      { id: 'd', delay: { resets: 'weekly', backend: 'codex' } },
      { id: 'ok', approve: 'the spec' },
      {
        id: 'r',
        repeat: [{ id: 'w2', waitFor: [{ agent: 'b', item: 'x' }], timeout: { at: '09:00' } }],
        until: { kind: 'outputContains', text: 'DONE', wholeLine: true },
        rounds: 2,
        otherwise: 'goOn',
      },
      {
        id: 'u',
        if: { kind: 'usageAbove', backend: 'codex', window: 'weekly', percent: 80 },
        then: [],
      },
    ];
    const set = (items: unknown, all: unknown) =>
      canvas.nodes.map((n) =>
        n.id === 'a' && n.type === 'agent'
          ? { ...n, data: { ...n.data, queue: items, settings: all } }
          : n,
      ) as CanvasDocument['nodes'];
    const text = toFile({ ...canvas, nodes: set(everything, settings) });

    expect(toFile({ ...canvas, nodes: set(reversed(everything), reversed(settings)) })).toBe(text);
    expect(toFile(read(text))).toBe(text);
  });

  it('writes an empty queue as none, and reads one so', () => {
    const empty = withQueue([]);
    expect((JSON.parse(toFile(empty)) as typeof saved).nodes[1]).not.toHaveProperty('queue');
    const file = structuredClone(saved);
    Object.assign(file.nodes[2] ?? {}, { queue: [] });
    expect(agentData(read(JSON.stringify(file)), 'b')).toEqual({ label: 'Reviewer' });
  });

  it('writes the canvas as readable JSON', () => {
    const text = toFile(canvas);
    expect(JSON.parse(text)).toEqual(saved);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'format',
      'version',
      'id',
      'nodes',
      'links',
    ]);
    expect(text).toMatch(/^\{\n {2}"format": "corrallm",\n/);
    expect(text.endsWith('}\n')).toBe(true);
  });
});

describe('fromFile', () => {
  it('preserves whole-line output conditions for Ifs and repeats', () => {
    const wholeLine: QueueItem[] = [
      { id: 'if', if: { kind: 'outputContains', text: 'READY', wholeLine: true }, then: [] },
      {
        id: 'loop',
        repeat: [{ id: 'review', message: 'Review it' }],
        until: { kind: 'outputContains', text: 'APPROVED', wholeLine: true },
        rounds: 3,
        otherwise: 'ask',
      },
    ];
    const saved = toFile(withQueue(wholeLine));
    expect(agentData(read(saved), 'a')?.queue).toEqual(wholeLine);
    expect(toFile(read(saved))).toBe(saved);
  });

  it('reads back what was saved: the canvas, its id and its links', () => {
    expect(read(toFile(canvas))).toEqual(canvas);
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
    const text = toFile(withQueue(timed));
    expect(text).toContain('"delay": {\n');
    expect(agentData(read(text), 'a')?.queue).toEqual(timed);
    expect(toFile(read(text))).toBe(text);
  });

  it('reads back what a step is to do, in the user’s words', () => {
    const told: QueueItem[] = [
      { id: 'tests', action: 'Bash', instruction: 'run npm test' },
      { id: 'look', action: 'Read', target: 'b', instruction: 'its notes' },
    ];
    const text = toFile(withQueue(told));
    expect(text).toContain('"instruction": "run npm test"');
    expect(agentData(read(text), 'a')?.queue).toEqual(told);
    expect(toFile(read(text))).toBe(text);
    // An empty one is none.
    const empty = JSON.stringify({
      ...saved,
      nodes: [{ ...saved.nodes[2], queue: [{ id: 's', action: 'Bash', instruction: '' }] }],
      links: [],
    });
    expect(agentData(read(empty), 'b')?.queue).toEqual([{ id: 's', action: 'Bash' }]);
  });

  it('reads back steps expected to fail, in a repeat and an if-then too', () => {
    const red: QueueItem[] = [
      { id: 'red', action: 'Bash', instruction: 'Run the new tests.', expect: 'fails' },
      {
        id: 'early',
        if: { kind: 'failed' },
        then: [{ id: 'redo', action: 'Edit', expect: 'fails' }],
      },
      {
        id: 'loop',
        repeat: [{ id: 'again', action: 'Bash', expect: 'fails' }],
        until: { kind: 'succeeded' },
        rounds: 3,
        otherwise: 'ask',
      },
    ];
    const text = toFile(withQueue(red));
    expect(text).toContain('"expect": "fails"');
    expect(agentData(read(text), 'a')?.queue).toEqual(red);
    expect(toFile(read(text))).toBe(text);
  });

  it('reads back usage conditions, and delays and time limits until a usage window resets', () => {
    const usage: QueueItem[] = [
      { id: 'reset', delay: { resets: 'fiveHour', backend: 'claude-code' } },
      // A backend this build lacks is kept, and has no reading.
      { id: 'later', delay: { resets: 'weekly', backend: 'gemini' } },
      { id: 'built', waitFor: [{ agent: 'b' }], timeout: { resets: 'weekly', backend: 'codex' } },
      {
        id: 'high',
        if: { kind: 'usageAbove', backend: 'claude-code', window: 'weekly', percent: 80 },
        then: [{ id: 'hand', message: 'Take the mechanical steps.', target: 'b' }],
      },
    ];
    const text = toFile(withQueue(usage));
    expect(agentData(read(text), 'a')?.queue).toEqual(usage);
    expect(toFile(read(text))).toBe(text);
  });

  it('reads back OKs, on what they name or (no words) on the work before them', () => {
    const asked: QueueItem[] = [
      { id: 'spec', message: 'Write SPEC.md' },
      { id: 'spec-ok', approve: 'the spec in SPEC.md' },
      { id: 'ok', approve: '' },
    ];
    const text = toFile(withQueue(asked));
    expect(text).toContain(
      '{\n          "id": "spec-ok",\n          "approve": "the spec in SPEC.md"\n',
    );
    expect(agentData(read(text), 'a')?.queue).toEqual(asked);
    expect(toFile(read(text))).toBe(text);
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
    const text = toFile(withQueue(looped));
    expect(text).toMatch(
      /\{\n {10}"id": "green-loop",\n {10}"repeat": \[[^]*\],\n {10}"until": \{\n {12}"kind": "succeeded"\n {10}\},\n {10}"rounds": 3,\n {10}"otherwise": "ask"\n/,
    );
    expect(agentData(read(text), 'a')?.queue).toEqual(looped);
    expect(toFile(read(text))).toBe(text);
    // A file from before repeats reads just as it did.
    expect(agentData(read(JSON.stringify(saved)), 'a')?.queue).toEqual(queue);
  });

  it('saves how a Claude or Codex agent runs when it is connected, and reads it back', () => {
    const agent = (id: string, x: number, data: AgentData): AgentNode => ({
      id,
      type: 'agent',
      position: { x, y: 0 },
      data,
    });
    const connected: CanvasDocument = {
      id: ID,
      arrange: false,
      nodes: [
        agent('t', 0, { label: 'T', connection: 'claude-code.terminal' }),
        agent('s', 200, { label: 'S', adapter: 'claude-code', connection: 'claude-code.sdk' }),
        agent('c', 400, { label: 'C', adapter: 'codex', connection: 'codex.terminal' }),
        agent('x', 600, { label: 'X', adapter: 'codex', connection: 'codex.app-server' }),
      ],
      links: [],
    };
    const file = JSON.parse(toFile(connected)) as typeof saved;
    const ways = ['claude-code.terminal', 'claude-code.sdk', 'codex.terminal', 'codex.app-server'];
    expect(file.nodes.map((n) => ('connection' in n ? n.connection : undefined))).toEqual(ways);
    const loaded = read(toFile(connected));
    expect(loaded.nodes.map((n) => agentData(loaded, n.id)?.connection)).toEqual(ways);
    expect(loaded).toEqual(connected);
  });

  it('saves what an agent is set to run with by each adapter, and reads it back', () => {
    const settings = {
      'claude-code': { model: 'haiku', effort: 'low', mode: 'plan' },
      // What it was set to when it ran Codex is kept too: a mode one of its connections starts in.
      codex: { model: 'gpt-6-luna', mode: 'plan' },
    } as const;
    const set: CanvasDocument = {
      id: ID,
      arrange: false,
      nodes: [
        {
          id: 't',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: { label: 'T', connection: 'claude-code.terminal', settings },
        },
      ],
      links: [],
    };
    const text = toFile(set);
    expect((JSON.parse(text) as { nodes: { settings?: unknown }[] }).nodes[0]?.settings).toEqual(
      settings,
    );
    expect(agentData(read(text), 't')?.settings).toEqual(settings);
    expect(toFile(read(text))).toBe(text);
    // Nothing set: written as nothing, for an adapter or at all.
    const file = structuredClone(saved);
    Object.assign(file.nodes[2] ?? {}, { settings: { 'claude-code': {}, codex: {} } });
    expect(agentData(read(JSON.stringify(file)), 'b')).toEqual({ label: 'Reviewer' });
  });

  it.each([
    ['toString', undefined],
    ['toString', 'toString.acp'],
    ['constructor', undefined],
    ['constructor', 'constructor'],
  ])(
    'keeps an agent whose adapter is named like what every object inherits (%s, connection %s) as it was',
    (adapter, connection) => {
      const file = structuredClone(saved);
      Object.assign(file.nodes[1] ?? {}, {
        adapter,
        ...(connection === undefined ? {} : { connection }),
        settings: { toString: { model: 'pro', mode: 'yolo' }, constructor: { effort: 'max' } },
      });
      const loaded = read(JSON.stringify(file));
      const data = agentData(loaded, 'a') ?? { label: '' };
      expect(data).toMatchObject({
        adapter,
        settings: { toString: { model: 'pro', mode: 'yolo' }, constructor: { effort: 'max' } },
      });
      // It runs no way this build has.
      expect(TEST_ENGINE.connectionOf(data)).toBe('unavailable');
      expect(JSON.parse(toFile(loaded))).toEqual(file);
    },
  );

  it('refuses a wait for an agent written as just its id', () => {
    const file = structuredClone(saved);
    Object.assign(file.nodes[1] ?? {}, { queue: [{ id: 'w', waitFor: ['b'] }] });
    expect(() => read(JSON.stringify(file))).toThrow('nodes[1].queue[0].waitFor[0]');
  });

  it('puts parents before their children, whatever order the file lists them in', () => {
    const [group, ...rest] = saved.nodes;
    const loaded = read(JSON.stringify({ ...saved, nodes: [...rest, group] }));
    expect(loaded.nodes.map((n) => n.id)).toEqual(['G', 'a', 'b']);
  });

  it('reads an agent naming no adapter as running the one it is told agents run by default', () => {
    const file = structuredClone(saved);
    Object.assign(file.nodes[2] ?? {}, { connection: 'codex.app-server' });
    expect(() => read(JSON.stringify(file))).toThrow(
      'nodes[2].connection: "codex.app-server" is a connection of codex, not of claude-code',
    );
    expect(agentData(fromFile(JSON.stringify(file), TEST_CATALOG, 'codex'), 'b')).toEqual({
      label: 'Reviewer',
      connection: 'codex.app-server',
    });
  });

  it('rejects what is not a canvas, canvases from another version, and one without an id', () => {
    expect(() => read('not json')).toThrow('This is not a corrallm canvas');
    expect(() => read('{"format": "other"}')).toThrow('This is not a corrallm canvas');
    expect(() => read(JSON.stringify({ ...saved, version: 3 }))).toThrow(
      'This canvas was made by a newer version of corrallm',
    );
    expect(() => read(JSON.stringify({ ...saved, version: 1 }))).toThrow(
      'This canvas is from an older version of corrallm',
    );
    expect(() => read(JSON.stringify({ ...saved, id: 'team' }))).toThrow(
      'id must be the canvas’s id',
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
      'an adapter that is no id',
      (f) => Object.assign(f.nodes[1] ?? {}, { adapter: '--yolo' }),
      /^nodes\[1\]\.adapter must be an adapter's id$/,
    ],
    [
      'a connection that is no id',
      (f) => Object.assign(f.nodes[2] ?? {}, { connection: 'ssh://host' }),
      /^nodes\[2\]\.connection must be a connection's id$/,
    ],
    [
      'a connection of another adapter',
      (f) => Object.assign(f.nodes[1] ?? {}, { connection: 'claude-code.terminal' }),
      /^nodes\[1\]\.connection: "claude-code\.terminal" is a connection of claude-code, not of codex$/,
    ],
    [
      'a group with a connection',
      (f) => Object.assign(f.nodes[0] ?? {}, { connection: 'claude-code.sdk' }),
      /^nodes\[0\]\.connection: a group has no connection$/,
    ],
    [
      'a group with settings',
      (f) => Object.assign(f.nodes[0] ?? {}, { settings: { 'claude-code': { model: 'opus' } } }),
      /^nodes\[0\]\.settings: a group has no settings$/,
    ],
    [
      'settings by what is no adapter',
      (f) => Object.assign(f.nodes[2] ?? {}, { settings: { 'no adapter': { model: 'pro' } } }),
      /^nodes\[2\]\.settings\.no adapter: settings are by adapter$/,
    ],
    [
      'a model that reads as a flag',
      (f) =>
        Object.assign(f.nodes[2] ?? {}, {
          settings: { 'claude-code': { model: '--dangerously-skip-permissions' } },
        }),
      /^nodes\[2\]\.settings\.claude-code\.model must be a model's name/,
    ],
    [
      'an effort that is not a word',
      (f) =>
        Object.assign(f.nodes[2] ?? {}, { settings: { 'claude-code': { effort: 'max; rm' } } }),
      /^nodes\[2\]\.settings\.claude-code\.effort must be a reasoning effort/,
    ],
    [
      'a mode of another adapter',
      (f) => Object.assign(f.nodes[2] ?? {}, { settings: { codex: { mode: 'plan-ish' } } }),
      /^nodes\[2\]\.settings\.codex\.mode must be one of: read-only, auto, plan$/,
    ],
    [
      // A file never starts an agent without its asking: that is chosen in its session, each time.
      'a mode that never asks',
      (f) =>
        Object.assign(f.nodes[2] ?? {}, {
          settings: { 'claude-code': { mode: 'bypassPermissions' } },
        }),
      /^nodes\[2\]\.settings\.claude-code\.mode must be one of: manual, acceptEdits, plan, auto$/,
    ],
    [
      // Its Terminal starts in Read only, or the user's own default; Plan is chosen in it.
      'a mode its connection does not start in',
      (f) => Object.assign(f.nodes[1] ?? {}, { settings: { codex: { mode: 'plan' } } }),
      /^nodes\[1\]\.settings\.codex\.mode must be one of: read-only$/,
    ],
    [
      'a mode another connection starts in, for the one it runs',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          connection: 'codex.terminal',
          settings: { codex: { mode: 'auto' } },
        }),
      /^nodes\[1\]\.settings\.codex\.mode must be one of: read-only$/,
    ],
    [
      'something else set',
      (f) =>
        Object.assign(f.nodes[2] ?? {}, { settings: { 'claude-code': { command: 'rm -rf /' } } }),
      /^nodes\[2\]\.settings\.claude-code: only model, effort and mode can be set$/,
    ],
    [
      'a repeated id',
      (f) => Object.assign(f.nodes[2] ?? {}, { id: 'a' }),
      /nodes\[2\]\.id: "a" is used twice/,
    ],
    [
      'an id longer than any agent is named by',
      (f) => Object.assign(f.nodes[2] ?? {}, { id: 'x'.repeat(MAX_NODE_ID + 1) }),
      /^nodes\[2\]\.id must be at most 256 characters$/,
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
      'a step’s instruction that is not text',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 's', action: 'Bash', instruction: 3 }] }),
      /^nodes\[1\]\.queue\[0\]\.instruction must be text$/,
    ],
    [
      'a step expected to do something other than fail',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 's', action: 'Bash', expect: 'passes' }] }),
      /^nodes\[1\]\.queue\[0\]\.expect must be "fails"$/,
    ],
    [
      'a broken condition',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'i', if: { kind: 'maybe' }, then: [] }] }),
      /^nodes\[1\]\.queue\[0\]\.if\.kind must be one of: succeeded, failed, outputContains, timedOut, freeText, usageAbove$/,
    ],
    [
      'an If with a non-boolean whole-line match',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'i', if: { kind: 'outputContains', text: 'READY', wholeLine: 'yes' }, then: [] },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.if\.wholeLine must be true or false$/,
    ],
    [
      'a repeat with a non-boolean whole-line match',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'r',
              repeat: [],
              until: { kind: 'outputContains', text: 'APPROVED', wholeLine: 1 },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.until\.wholeLine must be true or false$/,
    ],
    [
      'a usage condition on what is no backend',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'i',
              if: { kind: 'usageAbove', backend: 'my plan', window: 'weekly', percent: 80 },
              then: [],
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.if\.backend must be a usage backend's id$/,
    ],
    [
      'a usage condition over all of a window',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'i',
              if: { kind: 'usageAbove', backend: 'claude-code', window: 'weekly', percent: 100 },
              then: [],
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.if\.percent must be a whole number from 1 to 99$/,
    ],
    [
      'a usage condition on a window there is none of',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'i',
              if: { kind: 'usageAbove', backend: 'claude-code', window: 'daily', percent: 80 },
              then: [],
            },
          ],
        }),
      /^nodes\[1\]\.queue\[0\]\.if\.window must be one of: fiveHour, weekly$/,
    ],
    [
      'a delay until a window there is none of resets',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'd', delay: { resets: 'monthly', backend: 'claude-code' } }],
        }),
      /^nodes\[1\]\.queue\[0\]\.delay\.resets must be one of: fiveHour, weekly$/,
    ],
    [
      'a delay until the usage of what is no backend resets',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'd', delay: { resets: 'weekly', backend: '' } }],
        }),
      /^nodes\[1\]\.queue\[0\]\.delay\.backend must be a usage backend's id$/,
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
      /^nodes\[1\]\.queue\[0\]\.delay must have one of seconds, at or resets$/,
    ],
    [
      'a time limit that is neither',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'w', waitFor: [{ agent: 'b' }], timeout: {} }],
        }),
      /^nodes\[1\]\.queue\[0\]\.timeout must have one of seconds, at or resets$/,
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
      'a repeat until usage is over a share',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            {
              id: 'r',
              repeat: [],
              until: { kind: 'usageAbove', backend: 'claude-code', window: 'weekly', percent: 80 },
              rounds: 3,
              otherwise: 'ask',
            },
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
      'an id inside an if-then that its queue already uses',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'x', action: 'Read' },
            { id: 'i', if: { kind: 'failed' }, then: [{ id: 'x', message: 'Again' }] },
          ],
        }),
      /^nodes\[1\]\.queue\[1\]\.then\[0\]\.id: "x" is used twice in this queue$/,
    ],
    [
      'an id inside an if-then that another if-then uses',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'i', if: { kind: 'failed' }, then: [{ id: 'x', action: 'Read' }] },
            { id: 'j', if: { kind: 'succeeded' }, then: [{ id: 'x', message: 'Again' }] },
          ],
        }),
      /^nodes\[1\]\.queue\[1\]\.then\[0\]\.id: "x" is used twice in this queue$/,
    ],
    [
      'an id inside a repeat that an if-then before it uses',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'i', if: { kind: 'failed' }, then: [{ id: 'x', action: 'Read' }] },
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
      'an id of the queue inside an if-then before it',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [
            { id: 'i', if: { kind: 'failed' }, then: [{ id: 'x', action: 'Read' }] },
            { id: 'x', message: 'Again' },
          ],
        }),
      /^nodes\[1\]\.queue\[1\]\.id: "x" is used twice in this queue$/,
    ],
    [
      'an if-then holding a step of its own id',
      (f) =>
        Object.assign(f.nodes[1] ?? {}, {
          queue: [{ id: 'i', if: { kind: 'failed' }, then: [{ id: 'i', action: 'Read' }] }],
        }),
      /^nodes\[1\]\.queue\[0\]\.then\[0\]\.id: "i" is used twice in this queue$/,
    ],
    [
      'a link to a missing agent',
      (f) => Object.assign(f, { links: [{ agents: ['a', 'X'] }] }),
      /links\[0\]\.agents/,
    ],
    // Text a database or a key can't keep as it is: a lone surrogate.
    [
      'an id with a broken character',
      (f) => Object.assign(f.nodes[2] ?? {}, { id: 'b\ud800' }),
      /^nodes\[2\]\.id holds a broken character \(a lone surrogate\)$/,
    ],
    [
      'a label with a broken character',
      (f) => Object.assign(f.nodes[0] ?? {}, { label: '\udc00Team' }),
      /^nodes\[0\]\.label holds a broken character \(a lone surrogate\)$/,
    ],
    [
      'a role with a broken character',
      (f) => Object.assign(f.nodes[2] ?? {}, { role: 'Review\ud83d' }),
      /^nodes\[2\]\.role: The role must not hold a broken character \(a lone surrogate\)\.$/,
    ],
    [
      'an item’s text with a broken character',
      (f) => Object.assign(f.nodes[1] ?? {}, { queue: [{ id: 'm', message: 'Fix \ud800 it' }] }),
      /^nodes\[1\]\.queue\[0\]\.message holds a broken character \(a lone surrogate\)$/,
    ],
  ])('rejects %s, saying where', (_label, breakIt, message) => {
    const file = structuredClone(saved);
    breakIt(file);
    expect(() => read(JSON.stringify(file))).toThrow(message);
  });
});
