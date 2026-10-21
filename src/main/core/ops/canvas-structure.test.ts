import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPS } from '../../../shared/api/registry';
import { SURFACE } from '../../../shared/api/surface';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { itemKey, linkKey, nodeKey } from '../../../shared/model/rows';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { FakeConnector } from '../../sessions/fake';
import { createDispatcher } from '../call';
import type { Dispatcher, OpContext } from '../call';
import * as changes from '../canvas/change';
import { createCore } from '../core';
import type { Core } from '../core';
import { keepCanvases, readOnDisk } from '../store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP, testRegistry } from '../test-registry';
import { canvasOps } from './canvas';

const KEY = `canvas:${CANVAS}`;
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
        settings: { codex: { mode: 'auto', model: 'default' } },
        queue: [{ id: 'task', message: 'Work' }],
      },
    },
    {
      id: 'b',
      type: 'agent',
      position: { x: 300, y: 0 },
      data: {
        label: 'B',
        adapter: 'codex',
        queue: [{ id: 'wait', waitFor: [{ agent: 'a', item: 'task' }] }],
      },
    },
    { id: 'c', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'C', adapter: 'codex' } },
    { id: 'G', type: 'frame', position: { x: 1000, y: 1000 }, data: { label: 'Group' } },
  ],
  links: [{ source: 'b', target: 'c' }],
});
let core: Core;
let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-structure-ops-'));
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
function created(result: Record<string, unknown>): string {
  expect(result.id).toEqual(expect.any(String));
  return String(result.id);
}
function initialItem(id: string): string {
  const found = node(id);
  if (found.type !== 'agent' || !found.data.queue?.[0]) throw new Error('No initial item');
  return itemKey(id, found.data.queue[0].id);
}

describe('canvas structure commits through core.call', () => {
  it('creates an agent on the user’s chosen connection in one revision', async () => {
    const result = await edit('canvas.addAgent', { at: { x: 1500, y: 0 }, adapter: 'claude-code', connection: 'claude-code.sdk' });
    const id = created(result);
    expect(node(id).data).toMatchObject({ adapter: 'claude-code', connection: 'claude-code.sdk' });
    committed('canvas.addAgent', result, [nodeKey(id), initialItem(id)]);
  });
  it('refuses a connection belonging to another adapter without committing', async () => {
    expect(await core.call('canvas.addAgent', { canvas: CANVAS, at: { x: 1500, y: 0 }, adapter: 'codex', connection: 'claude-code.sdk' }, CALLERS.you)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(rows()).toEqual([]);
  });
  it('still refuses a token creating an agent on a connection other than its first', async () => {
    expect(await core.call('canvas.addAgent', { canvas: CANVAS, at: { x: 1500, y: 0 }, adapter: 'claude-code', connection: 'claude-code.sdk', request: '834fb544-702d-461a-9b39-ae7a3d3a4239' }, CALLERS['outside-write'])).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(rows()).toEqual([]);
  });
  it('adds an agent and its initial item in one revision', async () => {
    const result = await edit('canvas.addAgent', { at: { x: 1500, y: 0 }, adapter: 'codex' });
    const id = created(result);
    expect(node(id).data).toMatchObject({ adapter: 'codex', label: 'Agent 1' });
    committed('canvas.addAgent', result, [nodeKey(id), initialItem(id)]);
  });
  it('spawns an exact startup copy and carries its provenance into the change set', async () => {
    const sets = vi.spyOn(changes, 'changeSetOf');
    const source = node('a').data;
    const result = await edit('canvas.spawnAgent', { from: 'a', relation: 'linked' });
    const id = created(result);
    expect(node(id).data).toMatchObject({
      adapter: 'codex',
      connection: 'codex.app-server',
      role: 'Reviews',
    });
    expect(node(id).data).toHaveProperty(
      'settings',
      'settings' in source ? source.settings : undefined,
    );
    expect(node(id).data).toHaveProperty('queue', [
      { id: initialItem(id).split('/').at(-1), message: '' },
    ]);
    const changed = sets.mock.results
      .map((one) => (one.type === 'return' ? one.value : undefined))
      .find((one) => one?.op === 'canvas.spawnAgent');
    expect(changed?.copies).toEqual(new Map([[id, 'a']]));
    committed('canvas.spawnAgent', result, [nodeKey(id), initialItem(id), linkKey('a', id)]);
  });
  it('deletes nodes and clears surviving queue references in the same revision', async () => {
    const result = await edit('canvas.delete', { nodes: ['a'] });
    expect(result.cleared).toEqual([expect.stringMatching(/B.*A/)]);
    expect(doc().nodes.some((one) => one.id === 'a')).toBe(false);
    expect(node('b').data).toHaveProperty('queue', []);
    committed('canvas.delete', result, [nodeKey('a'), itemKey('a', 'task'), itemKey('b', 'wait')]);
  });
  it('deletes a link by its ends in either drawing direction', async () => {
    const result = await edit('canvas.delete', { links: [{ a: 'c', b: 'b' }] });
    expect(result.cleared).toEqual([]);
    expect(doc().links).toEqual([]);
    committed('canvas.delete', result, [linkKey('b', 'c')]);
  });
  it('links agents with the optional drawing direction and dots', async () => {
    const result = await edit('canvas.link', {
      a: 'a',
      b: 'b',
      source: 'b',
      dots: ['top', 'bottom'],
    });
    expect(doc().links).toContainEqual({ source: 'b', target: 'a', dots: ['top', 'bottom'] });
    committed('canvas.link', result, [linkKey('a', 'b')]);
  });
  it('unlinks a link named in reverse', async () => {
    const result = await edit('canvas.unlink', { a: 'c', b: 'b' });
    expect(doc().links).toEqual([]);
    committed('canvas.unlink', result, [linkKey('b', 'c')]);
  });
  it.each(['frame', 'agent'] as const)(
    'groups nodes under a new %s in one revision',
    async (kind) => {
      const result = await edit('canvas.group', { nodes: ['a', 'b'], kind });
      const id = created(result);
      expect(node(id).type).toBe(kind);
      expect([node('a').parentId, node('b').parentId]).toEqual([id, id]);
      if (kind === 'agent') expect(node(id).data).toHaveProperty('adapter', DEFAULT_ADAPTER);
      committed('canvas.group', result, [
        nodeKey(id),
        nodeKey('a'),
        nodeKey('b'),
        ...(kind === 'agent' ? [initialItem(id)] : []),
      ]);
    },
  );
  it('ungroups a frame in one revision', async () => {
    const result = await edit('canvas.ungroup', { nodes: ['G'] });
    expect(doc().nodes.some((one) => one.id === 'G')).toBe(false);
    committed('canvas.ungroup', result, [nodeKey('G')]);
  });
  it('turns a frame into an agent parent, returning its preserved id', async () => {
    const result = await edit('canvas.addParent', { frame: 'G' });
    expect(result.id).toBe('G');
    expect(node('G').type).toBe('agent');
    expect(node('G').data).toHaveProperty('adapter', DEFAULT_ADAPTER);
    committed('canvas.addParent', result, [nodeKey('G'), initialItem('G')]);
  });
  it('moves every named node in one revision', async () => {
    const result = await edit('canvas.move', {
      moves: [
        { node: 'a', position: { x: 20, y: 30 } },
        { node: 'c', position: { x: 650, y: 10 } },
      ],
    });
    expect(node('a').position).toEqual({ x: 20, y: 30 });
    expect(node('c').position).toEqual({ x: 650, y: 10 });
    committed('canvas.move', result, [nodeKey('a'), nodeKey('c')]);
  });

  it.each([
    ['canvas.delete', { nodes: [], links: [] }],
    ['canvas.link', { a: 'c', b: 'b' }],
    ['canvas.ungroup', { nodes: ['c'] }],
    ['canvas.move', { moves: [{ node: 'a', position: { x: 0, y: 0 } }] }],
  ])('%s returns no revisions when nothing changes', async (name, args) => {
    const result = await edit(name, args);
    expect(result.revs).toEqual({});
    expect(rows()).toEqual([]);
  });

  it.each([
    ['canvas.spawnAgent', { from: 'ghost', relation: 'peer' }, 'not-found'],
    ['canvas.spawnAgent', { from: 'G', relation: 'peer' }, 'invalid'],
    ['canvas.delete', { nodes: ['a', 'ghost'] }, 'not-found'],
    ['canvas.delete', { links: [{ a: 'a', b: 'ghost' }] }, 'not-found'],
    ['canvas.delete', { links: [{ a: 'a', b: 'G' }] }, 'invalid'],
    ['canvas.link', { a: 'a', b: 'ghost' }, 'not-found'],
    ['canvas.link', { a: 'G', b: 'a' }, 'invalid'],
    ['canvas.link', { a: 'a', b: 'a' }, 'invalid'],
    ['canvas.link', { a: 'a', b: 'b', source: 'c' }, 'invalid'],
    ['canvas.unlink', { a: 'G', b: 'a' }, 'invalid'],
    ['canvas.unlink', { a: 'a', b: 'ghost' }, 'not-found'],
    ['canvas.group', { nodes: ['a', 'ghost'], kind: 'frame' }, 'not-found'],
    ['canvas.group', { nodes: [], kind: 'frame' }, 'invalid'],
    ['canvas.ungroup', { nodes: ['ghost'] }, 'not-found'],
    ['canvas.addParent', { frame: 'ghost' }, 'not-found'],
    ['canvas.addParent', { frame: 'a' }, 'invalid'],
    ['canvas.move', { moves: [{ node: 'ghost', position: { x: 0, y: 0 } }] }, 'not-found'],
  ])('%s refuses absent nodes and inappropriate kinds (%j)', async (name, args, code) => {
    const before = doc();
    expect(
      await (core as Dispatcher).call(name, { canvas: CANVAS, ...(args as object) }, CALLERS.you),
    ).toMatchObject({ ok: false, error: { code } });
    expect(doc()).toBe(before);
    expect(rows()).toEqual([]);
  });

  it('delete aborts and awaits the removed agent’s active lane', async () => {
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
        surface: { ...registry.surface, 'canvas.delete': SURFACE['canvas.delete'] },
        ops: { ...registry.ops, 'canvas.delete': OPS['canvas.delete'] },
        implementations: {
          ...registry.implementations,
          ...canvasOps({ defaultAdapter: DEFAULT_ADAPTER, catalog: CATALOG }),
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
    const removed = dispatch.call('canvas.delete', { canvas: CANVAS, nodes: ['a'] }, CALLERS.you);
    try {
      await stopping;
      expect(order).toEqual(['aborted']);
    } finally {
      end();
    }
    expect(await held).toEqual({ ok: true, value: { stopped: true } });
    expect(await removed).toMatchObject({
      ok: true,
      value: { cleared: [expect.any(String)], revs: { [KEY]: 2 } },
    });
    expect(order).toEqual(['aborted', 'unwound', 'committed']);
    expect(current.nodes.some((one) => one.id === 'a')).toBe(false);
  });
  it.each([
    ['canvas.delete', { links: [{ a: 'a', b: 'c' }] }, 'not-found'],
    ['canvas.unlink', { a: 'a', b: 'c' }, 'not-found'],
    ['canvas.addAgent', { at: { x: 0, y: 0 }, adapter: 'unknown' }, 'invalid'],
    ['canvas.rename', { node: 'a', label: '' }, 'invalid'],
    ['canvas.rename', { node: 'a', label: ' \n\t' }, 'invalid'],
    ['canvas.addAgent', { at: { x: 1000001, y: 0 }, adapter: 'codex' }, 'invalid'],
    ['canvas.move', { moves: [{ node: 'a', position: { x: 0, y: -1000001 } }] }, 'invalid'],
  ])(
    '%s refuses missing links, unknown adapters and unreachable positions (%j)',
    async (name, args, code) => {
      const before = doc();
      const result = await (core as Dispatcher).call(
        name,
        { canvas: CANVAS, ...(args as object) },
        CALLERS.you,
      );
      expect(result).toMatchObject({ ok: false, error: { code } });
      if (code === 'not-found') {
        if (result.ok) throw new Error('Unexpected success');
        expect(result.error.sentence).toContain('a');
        expect(result.error.sentence).toContain('c');
      }
      expect(doc()).toBe(before);
      expect(rows()).toEqual([]);
    },
  );
  it('refuses a move whose group fitting would produce out-of-bounds positions', async () => {
    await edit('canvas.group', { nodes: ['a', 'b'], kind: 'frame' });
    const before = doc();
    const changes = rows();
    expect(
      await (core as Dispatcher).call(
        'canvas.move',
        {
          canvas: CANVAS,
          moves: [
            { node: 'a', position: { x: -1000000, y: 0 } },
            { node: 'b', position: { x: 1000000, y: 0 } },
          ],
        },
        CALLERS.you,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(doc()).toBe(before);
    expect(rows()).toEqual(changes);
  });
});
