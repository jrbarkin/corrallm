import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OPS } from '../../../shared/api/registry';
import { SURFACE } from '../../../shared/api/surface';
import { MAX_INITIAL_QUEUE_ITEMS, MAX_MESSAGE_BYTES } from '../../../shared/api/limits';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { findItem, isIf, isRepeat } from '../../../shared/model/queue';
import type { QueueChange, QueueItem } from '../../../shared/model/queue';
import { itemKey, nodeKey } from '../../../shared/model/rows';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { FakeConnector } from '../../sessions/fake';
import { createDispatcher } from '../call';
import type { Dispatcher, OpContext } from '../call';
import { createCore } from '../core';
import type { Core } from '../core';
import { keepCanvases, readOnDisk } from '../store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP, testRegistry } from '../test-registry';
import { agentOps } from './agent';

const KEY = `canvas:${CANVAS}`;
const OLD = 'outside:old' as const;
const document = (): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        label: 'A',
        adapter: 'codex',
        connection: 'codex.app-server',
        role: 'Reviews',
        settings: { codex: { mode: 'auto', model: 'default', effort: 'low' } },
        queue: [
          { id: 'm', message: 'Old', by: OLD },
          { id: 's', action: 'exec_command', instruction: 'Old instruction', by: OLD },
          {
            id: 'branch',
            if: { kind: 'succeeded' },
            then: [{ id: 'nested', message: 'Inner', by: OLD }],
            by: OLD,
          },
          {
            id: 'loop',
            repeat: [{ id: 'repeated', message: 'Loop', by: OLD }],
            until: { kind: 'succeeded' },
            rounds: 3,
            otherwise: 'ask',
            by: OLD,
          },
          { id: 'wait', waitFor: [{ agent: 'b' }], by: OLD },
          { id: 'delay', delay: { seconds: 1 }, by: OLD },
          { id: 'ok', approve: 'Go', by: OLD },
        ],
      },
    },
    {
      id: 'b',
      type: 'agent',
      position: { x: 300, y: 0 },
      data: { label: 'B', adapter: 'codex', queue: [{ id: 'other', message: 'B' }] },
    },
    { id: 'G', type: 'frame', position: { x: 1000, y: 1000 }, data: { label: 'Group' } },
  ],
  links: [],
});
let core: Core;
let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-agent-queue-ops-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(file, toFile(document()));
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  core = await createCore(
    {
      profile,
      app: { name: 'test', version: '1' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
});
afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});
const doc = () => {
  const open = core.engines.canvas(CANVAS);
  if (!open) throw new Error('The canvas is not open.');
  return open.document;
};
const node = (id: string) => {
  const found = doc().nodes.find((one) => one.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};
const rows = () =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare(
        'SELECT rev, entity, rev_before, after_data FROM change WHERE canvas_id = ? AND rev > 1 ORDER BY rev, entity',
      )
      .all(CANVAS),
  );
async function edit(name: string, args: object): Promise<Record<string, unknown>> {
  const result = await (core as Dispatcher).call(name, { canvas: CANVAS, ...args }, CALLERS.you);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value as Record<string, unknown>;
}
function committed(name: string, result: Record<string, unknown>, keys: string[]) {
  expect(result.revs).toEqual({ [KEY]: 2 });
  expect(
    rows()
      .map((row) => row.entity)
      .sort(),
  ).toEqual(keys.sort());
  expect(
    readOnDisk(profile, (disk) =>
      disk
        .prepare('SELECT rev, op, by_party FROM revision WHERE canvas_id = ? AND rev > 1')
        .all(CANVAS),
    ),
  ).toEqual([{ rev: 2, op: name, by_party: 'you' }]);
}

const agent = () => {
  const found = node('a');
  if (found.type !== 'agent') throw new Error('No agent');
  return found.data;
};
const queue = () => agent().queue ?? [];
const item = (id: string): QueueItem => {
  const found = findItem(queue(), id)?.item;
  if (!found) throw new Error(`No item ${id}`);
  return found;
};

describe('agent and queue commits through core.call', () => {
  it('switches adapter and translates steps in one revision', async () => {
    const result = await edit('agent.setType', { agent: 'a', adapter: 'claude-code' });
    expect(agent().adapter).toBe('claude-code');
    expect(agent().connection).toBeUndefined();
    expect(item('s')).toMatchObject({ action: 'Bash', by: OLD });
    committed('agent.setType', result, [nodeKey('a'), itemKey('a', 's')]);
  });
  it('can select the new adapter’s connection in that same revision', async () => {
    const result = await edit('agent.setType', {
      agent: 'a',
      adapter: 'claude-code',
      connection: 'claude-code.sdk',
    });
    expect(agent()).toMatchObject({ adapter: 'claude-code', connection: 'claude-code.sdk' });
    committed('agent.setType', result, [nodeKey('a'), itemKey('a', 's')]);
  });
  it('sets your fallback chain, its connections resolved, in one revision; null removes it', async () => {
    const result = await edit('agent.setFallback', {
      agent: 'a',
      fallback: {
        to: [{ adapter: 'claude-code' }, { adapter: 'codex', connection: 'codex.terminal' }],
        back: 'return',
      },
    });
    expect(result.changed).toBe(true);
    expect(agent().fallback).toEqual({
      to: [
        { adapter: 'claude-code', connection: 'claude-code.terminal' },
        { adapter: 'codex', connection: 'codex.terminal' },
      ],
      back: 'return',
    });
    committed('agent.setFallback', result, [nodeKey('a')]);
    // The same chain again changes nothing.
    const again = await edit('agent.setFallback', {
      agent: 'a',
      fallback: {
        to: [
          { adapter: 'claude-code', connection: 'claude-code.terminal' },
          { adapter: 'codex', connection: 'codex.terminal' },
        ],
        back: 'return',
      },
    });
    expect(again).toMatchObject({ changed: false, revs: {} });
    expect((await edit('agent.setFallback', { agent: 'a', fallback: null })).changed).toBe(true);
    expect(agent().fallback).toBeUndefined();
  });
  it.each([
    ['an adapter the catalog lacks', { to: [{ adapter: 'zed' }] }],
    [
      'a connection of another adapter',
      { to: [{ adapter: 'codex', connection: 'claude-code.sdk' }] },
    ],
    // A's own endpoint: codex.app-server, its model and effort as its settings have them.
    [
      'the agent’s own endpoint',
      {
        to: [{ adapter: 'codex', connection: 'codex.app-server', model: 'default', effort: 'low' }],
      },
    ],
    ['a step twice', { to: [{ adapter: 'claude-code' }, { adapter: 'claude-code' }] }],
  ])('refuses a chain naming %s, changing nothing', async (_what, fallback) => {
    const before = doc();
    const result = await (core as Dispatcher).call(
      'agent.setFallback',
      { canvas: CANVAS, agent: 'a', fallback },
      CALLERS.you,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(doc()).toBe(before);
  });
  it('sets when your agent is asked for its handoff, and its file, in one revision; null is the defaults', async () => {
    const result = await edit('agent.setHandoff', {
      agent: 'a',
      handoff: { at: 80, file: 'docs/HANDOFF.md' },
    });
    expect(result.changed).toBe(true);
    expect(agent().handoff).toEqual({ at: 80, file: 'docs/HANDOFF.md' });
    committed('agent.setHandoff', result, [nodeKey('a')]);
    // The same settings again change nothing; a null file is none, as are absent fields.
    expect(
      await edit('agent.setHandoff', { agent: 'a', handoff: { file: 'docs/HANDOFF.md', at: 80 } }),
    ).toMatchObject({ changed: false, revs: {} });
    await edit('agent.setHandoff', { agent: 'a', handoff: { off: true, file: null } });
    expect(agent().handoff).toEqual({ off: true });
    expect((await edit('agent.setHandoff', { agent: 'a', handoff: null })).changed).toBe(true);
    expect(agent().handoff).toBeUndefined();
  });
  it.each([
    ['a share under 10', { at: 9 }],
    ['a share over 95', { at: 96 }],
    ['a share that isn’t whole', { at: 50.5 }],
    ['a path outside its checkout', { file: '../HANDOFF.md' }],
    ['a file that isn’t Markdown', { file: 'HANDOFF.txt' }],
    ['a path in Git’s folder', { file: '.git/HANDOFF.md' }],
    ['off as false', { off: false }],
  ])('refuses handoff settings with %s, changing nothing', async (_what, handoff) => {
    const before = doc();
    const result = await (core as Dispatcher).call(
      'agent.setHandoff',
      { canvas: CANVAS, agent: 'a', handoff },
      CALLERS.you,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(doc()).toBe(before);
  });
  it('switches connection and drops only an incompatible saved mode', async () => {
    const result = await edit('agent.setConnection', { agent: 'a', connection: 'codex.terminal' });
    expect(agent()).toMatchObject({
      connection: 'codex.terminal',
      settings: { codex: { model: 'default', effort: 'low' } },
    });
    expect(agent().settings?.codex?.mode).toBeUndefined();
    committed('agent.setConnection', result, [nodeKey('a')]);
  });
  it('merges settings, retaining omitted fields', async () => {
    const result = await edit('agent.setSettings', {
      agent: 'a',
      adapter: 'codex',
      settings: { model: 'new-model' },
    });
    expect(agent().settings?.codex).toEqual({ model: 'new-model', mode: 'auto', effort: 'low' });
    committed('agent.setSettings', result, [nodeKey('a')]);
  });
  it('unsets only fields explicitly set to null', async () => {
    await edit('agent.setSettings', { agent: 'a', adapter: 'codex', settings: { model: null } });
    expect(agent().settings?.codex).toEqual({ mode: 'auto', effort: 'low' });
  });
  it('sets a trimmed role in one revision', async () => {
    const result = await edit('agent.setRole', { agent: 'a', role: '  New role\n' });
    expect(agent().role).toBe('New role');
    committed('agent.setRole', result, [nodeKey('a')]);
  });
  it('clears a blank role', async () => {
    await edit('agent.setRole', { agent: 'a', role: '  ' });
    expect(agent().role).toBeUndefined();
  });
  it('returns the added item’s id, its text yours: no one else’s, so no author', async () => {
    const result = await edit('queue.add', { agent: 'a', entry: { message: 'New' } });
    expect(result.id).toEqual(expect.any(String));
    expect(item(String(result.id))).toEqual({ id: result.id, message: 'New' });
    committed('queue.add', result, [itemKey('a', String(result.id))]);
  });
  it('authors a container and each child, minting distinct ids', async () => {
    const result = await edit('queue.add', {
      agent: 'a',
      entry: {
        if: { kind: 'freeText', text: 'Ready?' },
        then: [{ message: 'Child' }, { action: 'exec_command' }],
      },
    });
    const added = item(String(result.id));
    expect(isIf(added)).toBe(true);
    if (!isIf(added)) throw new Error('Not an If');
    expect([added, ...added.then].map((one) => one.by)).toEqual([undefined, undefined, undefined]);
    expect(new Set([added, ...added.then].map((one) => one.id)).size).toBe(3);
    committed(
      'queue.add',
      result,
      [added, ...added.then].map((one) => itemKey('a', one.id)),
    );
  });
  it.each(['branch', 'loop'])('adds into %s and returns its child’s id', async (into) => {
    const result = await edit('queue.add', { agent: 'a', into, entry: { message: 'Child' } });
    const container = item(into);
    const children = isIf(container) ? container.then : isRepeat(container) ? container.repeat : [];
    expect(children.at(-1)).toEqual({ id: result.id, message: 'Child' });
    committed('queue.add', result, [itemKey('a', String(result.id))]);
  });
  it.each(['m', 'nested', 'repeated'])('removes %s with its change row', async (id) => {
    const result = await edit('queue.remove', { agent: 'a', item: id });
    expect(findItem(queue(), id)).toBeUndefined();
    committed('queue.remove', result, [itemKey('a', id)]);
    expect(rows()[0]?.after_data).toBeNull();
  });
  it('moves by a neighbour without changing text authorship', async () => {
    const result = await edit('queue.move', { agent: 'a', item: 's', before: 'm' });
    expect(
      queue()
        .slice(0, 2)
        .map((one) => one.id),
    ).toEqual(['s', 'm']);
    expect(item('s').by).toBe(OLD);
    expect(result.revs).toEqual({ [KEY]: 2 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.entity).toMatch(/^item\/a\//);
  });
  it('moves after a neighbour, or to the end with null', async () => {
    await edit('queue.move', { agent: 'a', item: 'm', after: 'delay' });
    expect(queue().at(-2)?.id).toBe('m');
    await edit('queue.move', { agent: 'a', item: 'm', before: null });
    expect(queue().at(-1)?.id).toBe('m');
  });
  const updates: [string, QueueChange, object, boolean][] = [
    ['m', { kind: 'message', message: 'New' }, { message: 'New' }, true],
    ['s', { kind: 'action', action: 'apply_patch' }, { action: 'apply_patch' }, true],
    ['s', { kind: 'instruction', instruction: 'New' }, { instruction: 'New' }, true],
    ['s', { kind: 'expect', expect: 'fails' }, { expect: 'fails' }, false],
    ['m', { kind: 'target', target: 'b' }, { target: 'b' }, false],
    [
      'branch',
      { kind: 'condition', condition: { kind: 'freeText', text: 'Ready?' } },
      { if: { kind: 'freeText', text: 'Ready?' } },
      true,
    ],
    [
      'wait',
      { kind: 'waitFor', waitFor: [{ agent: 'b', item: 'other' }] },
      { waitFor: [{ agent: 'b', item: 'other' }] },
      false,
    ],
    ['wait', { kind: 'time', time: { at: '12:30' } }, { timeout: { at: '12:30' } }, false],
    ['delay', { kind: 'time', time: { seconds: 30 } }, { delay: { seconds: 30 } }, false],
    ['ok', { kind: 'approve', approve: 'Check tests' }, { approve: 'Check tests' }, true],
    [
      'loop',
      { kind: 'repeat', rounds: 5, otherwise: 'goOn', until: { kind: 'freeText', text: 'Done?' } },
      { rounds: 5, otherwise: 'goOn', until: { kind: 'freeText', text: 'Done?' } },
      true,
    ],
    ['nested', { kind: 'message', message: 'New inner' }, { message: 'New inner' }, true],
  ];
  it.each(updates)(
    'updates %s (%j) with one row and the correct author',
    async (id, change, expected, text) => {
      const result = await edit('queue.update', { agent: 'a', item: id, change });
      // Your words make the text yours, with no author; anything else keeps its author.
      expect(item(id)).toMatchObject(expected);
      expect(item(id).by).toBe(text ? undefined : OLD);
      committed('queue.update', result, [itemKey('a', id)]);
    },
  );
  it.each([
    ['agent.setType', { adapter: 'codex' }],
    ['agent.setConnection', { connection: 'codex.app-server' }],
    ['agent.setSettings', { adapter: 'codex', settings: { model: 'default' } }],
    ['agent.setRole', { role: 'Reviews' }],
    ['queue.move', { item: 's', before: 'branch' }],
    ['queue.update', { item: 'm', change: { kind: 'message', message: 'Old' } }],
  ])('%s returns empty revs for an unchanged document', async (name, args) => {
    const result = await edit(name, { agent: 'a', ...(args as object) });
    expect(result.revs).toEqual({});
    expect(rows()).toEqual([]);
  });
  // Every operation resolves its agent through requireAgent; one agent-document and one queue
  // operation cover its two refusals (the matrix of all eight repeated one code path).
  it.each([
    ['agent.setRole', { role: '', agent: 'ghost' }, 'not-found'],
    ['agent.setRole', { role: '', agent: 'G' }, 'invalid'],
    ['queue.remove', { item: 'm', agent: 'ghost' }, 'not-found'],
  ])('%s refuses missing and wrong-kind agents (%j)', async (name, args, code) => {
    const before = doc();
    expect(
      await (core as Dispatcher).call(name, { canvas: CANVAS, ...args }, CALLERS.you),
    ).toMatchObject({ ok: false, error: { code } });
    expect(doc()).toBe(before);
    expect(rows()).toEqual([]);
  });
  it.each([
    ['agent.setType', { adapter: 'unknown' }, 'invalid'],
    ['agent.setType', { adapter: 'claude-code', connection: 'codex.terminal' }, 'invalid'],
    ['agent.setConnection', { connection: 'claude-code.terminal' }, 'invalid'],
    ['agent.setSettings', { adapter: 'codex', settings: { mode: 'full' } }, 'invalid'],
    ['agent.setRole', { role: 'bad\u0001role' }, 'invalid'],
    ['queue.remove', { item: 'ghost' }, 'not-found'],
    ['queue.remove', { item: 'other' }, 'not-found'],
    ['queue.move', { item: 'ghost', before: null }, 'not-found'],
    ['queue.move', { item: 'm', before: 'ghost' }, 'not-found'],
    ['queue.move', { item: 'm', before: 'nested' }, 'invalid'],
    ['queue.move', { item: 'm' }, 'invalid'],
    ['queue.move', { item: 'm', before: null, after: null }, 'invalid'],
    ['queue.update', { item: 'ghost', change: { kind: 'message', message: '' } }, 'not-found'],
    ['queue.add', { into: 'ghost', entry: { message: '' } }, 'not-found'],
    ['queue.add', { into: 'nested', entry: { message: '' } }, 'invalid'],
    ['queue.add', { into: 'm', entry: { message: '' } }, 'invalid'],
    ['queue.add', { into: 'branch', entry: { delay: { seconds: 2 } } }, 'invalid'],
    ['queue.add', { into: 'loop', entry: { approve: '' } }, 'invalid'],
    ['queue.add', { entry: { message: '', by: 'you' } }, 'invalid'],
    ['queue.add', { entry: { message: '😀'.repeat(MAX_MESSAGE_BYTES / 4 + 1) } }, 'invalid'],
    ['queue.update', { item: 'm', change: { kind: 'message', message: '', by: 'you' } }, 'invalid'],
    ['queue.update', { item: 'delay', change: { kind: 'time', time: null } }, 'invalid'],
    ...(
      [
        'message',
        'action',
        'instruction',
        'expect',
        'target',
        'condition',
        'waitFor',
        'time',
        'approve',
        'repeat',
      ] as const
    )
      .map((kind) => {
        const change = updates.find(([, change]) => change.kind === kind)?.[1];
        return [
          'queue.update',
          { item: kind === 'message' ? 's' : 'm', change },
          'invalid',
        ] satisfies [string, object, string];
      })
      .filter(([, args]) => (args as { change: QueueChange }).change.kind !== 'target'),
  ])('%s refuses invalid or absent items (%j)', async (name, args, code) => {
    const before = doc();
    expect(
      await (core as Dispatcher).call(
        name,
        { canvas: CANVAS, agent: 'a', ...(args as object) },
        CALLERS.you,
      ),
    ).toMatchObject({ ok: false, error: { code } });
    expect(doc()).toBe(before);
    expect(rows()).toEqual([]);
  });
});

describe('switching agent lanes', () => {
  it.each([
    ['agent.setType', { adapter: 'claude-code' }],
    ['agent.setConnection', { connection: 'codex.terminal' }],
  ] as const)('%s aborts and awaits the agent’s active lane', async (name, args) => {
    const registry = testRegistry();
    const order: string[] = [];
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let end!: () => void;
    const unwinding = new Promise<void>((resolve) => {
      end = resolve;
    });
    let aborted!: () => void;
    const stopping = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let current = document();
    const dispatch = createDispatcher(
      {
        surface: { ...registry.surface, [name]: SURFACE[name] },
        ops: { ...registry.ops, [name]: OPS[name] },
        implementations: {
          ...registry.implementations,
          ...agentOps({ catalog: CATALOG, defaultAdapter: DEFAULT_ADAPTER }),
          'test.hold': (_args, { signal }: OpContext) =>
            new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  order.push('aborted');
                  aborted();
                  void unwinding.then(() => {
                    order.push('unwound');
                    resolve({ stopped: true });
                  });
                },
                { once: true },
              );
              began();
            }),
        },
        rules: {},
      },
      {
        check: true,
        openCanvases: () => [CANVAS],
        commit: (_canvas, build, call) => {
          order.push('committed');
          call.noReturn();
          const built = build(current);
          current = built.next;
          return Promise.resolve({ result: built.result, rev: 2 });
        },
      },
    );
    const held = dispatch.call('test.hold', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
    await started;
    const switched = dispatch.call(name, { canvas: CANVAS, agent: 'a', ...args }, CALLERS.you);
    try {
      await stopping;
      expect(order).toEqual(['aborted']);
    } finally {
      end();
    }
    expect(await held).toEqual({ ok: true, value: { stopped: true } });
    expect(await switched).toEqual({ ok: true, value: { revs: { [KEY]: 2 } } });
    expect(order).toEqual(['aborted', 'unwound', 'committed']);
  });
});

describe('authorship and queue input boundaries', () => {
  it('keeps a token’s model-only merge deliverable without losing the saved mode', async () => {
    const result = await core.call(
      'agent.setSettings',
      { canvas: CANVAS, agent: 'a', adapter: 'codex', settings: { model: 'other-model' } },
      CALLERS['outside-write'],
    );
    expect(result).toMatchObject({ ok: true, value: { revs: { [KEY]: 2 } } });
    expect(agent().settings?.codex).toEqual({ mode: 'auto', model: 'other-model', effort: 'low' });
  });
  it('records the actual token party on additions and textual updates', async () => {
    const added = await core.call(
      'queue.add',
      { canvas: CANVAS, agent: 'a', entry: { message: 'Token text' } },
      CALLERS['outside-write'],
    );
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.error.sentence);
    expect(item(added.value.id).by).toBe('outside:orchestrator');
    const changed = await core.call(
      'queue.update',
      { canvas: CANVAS, agent: 'a', item: 'm', change: { kind: 'message', message: 'Token edit' } },
      CALLERS['outside-write'],
    );
    expect(changed.ok).toBe(true);
    expect(item('m').by).toBe('outside:orchestrator');
  });
  it.each([
    { action: 'exec_command', instruction: 'Work', target: 'b', expect: 'fails' },
    { waitFor: [{ agent: 'b', item: 'other' }], timeout: { resets: 'fiveHour', backend: 'codex' } },
    { delay: { seconds: 10 } },
    { approve: 'Check results' },
    {
      repeat: [{ delay: { seconds: 1 } }],
      until: { kind: 'succeeded' },
      rounds: 2,
      otherwise: 'ask',
    },
  ])('adds a complete queue entry (%j)', async (entry) => {
    const result = await edit('queue.add', { agent: 'a', entry });
    expect(item(String(result.id))).toMatchObject({ ...entry, id: result.id });
    expect(item(String(result.id))).not.toHaveProperty('by');
    const added = item(String(result.id));
    const keys = [
      itemKey('a', added.id),
      ...(isRepeat(added) ? added.repeat.map((one) => itemKey('a', one.id)) : []),
    ];
    committed('queue.add', result, keys);
  });
  it('removes a container and its children in one revision', async () => {
    const result = await edit('queue.remove', { agent: 'a', item: 'branch' });
    expect(findItem(queue(), 'branch')).toBeUndefined();
    expect(findItem(queue(), 'nested')).toBeUndefined();
    committed('queue.remove', result, [itemKey('a', 'branch'), itemKey('a', 'nested')]);
  });
  it('accepts a maximum-size UTF-8 message', async () => {
    const message = '😀'.repeat(MAX_MESSAGE_BYTES / 4);
    const result = await edit('queue.add', { agent: 'a', entry: { message } });
    expect(item(String(result.id))).toMatchObject({ message });
  });
  it('bounds initial children and permits growing the container through into', async () => {
    const entry = {
      if: { kind: 'succeeded' },
      then: Array.from({ length: MAX_INITIAL_QUEUE_ITEMS }, () => ({ message: '' })),
    };
    const result = await edit('queue.add', { agent: 'a', entry });
    await edit('queue.add', { agent: 'a', into: result.id, entry: { message: 'Further' } });
    const added = item(String(result.id));
    expect(isIf(added) && added.then.length).toBe(MAX_INITIAL_QUEUE_ITEMS + 1);
    expect(
      await (core as Dispatcher).call(
        'queue.add',
        { canvas: CANVAS, agent: 'a', entry: { ...entry, then: [...entry.then, { message: '' }] } },
        CALLERS.you,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });
  it('omits optional undefined fields before passing parsed entries to the model', async () => {
    const result = await edit('queue.add', {
      agent: 'a',
      entry: {
        if: { kind: 'outputContains', text: 'yes', wholeLine: undefined },
        then: [{ action: 'exec_command', instruction: undefined, target: undefined }],
      },
    });
    const added = item(String(result.id));
    if (!isIf(added)) throw new Error('Not an If');
    expect(Object.hasOwn(added.if, 'wholeLine')).toBe(false);
    expect(Object.hasOwn(added.then[0] ?? {}, 'instruction')).toBe(false);
    expect(Object.hasOwn(added.then[0] ?? {}, 'target')).toBe(false);
  });
  it('refuses changing a target on an item that has none', async () => {
    expect(
      await core.call(
        'queue.update',
        { canvas: CANVAS, agent: 'a', item: 'delay', change: { kind: 'target', target: 'b' } },
        CALLERS.you,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(rows()).toEqual([]);
  });
});
