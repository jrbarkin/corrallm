import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SURFACE } from '../../../shared/api/surface';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { findItem } from '../../../shared/model/queue';
import { FakeConnector } from '../../sessions/fake';
import { drainsOf } from '../call';
import { createCore } from '../core';
import type { Core } from '../core';
import { keepCanvases, readOnDisk } from '../store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from '../test-registry';

/*
 * canvas.batch (Core Server §4 B, B9 Design §5): several document edits as one commit, at one
 * revision, all or nothing, each built over what the ones before it left; each inner op checked as
 * a call of its own (bypass.test.ts tries every rule through it, as a token).
 */

const document = (): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'A', adapter: 'codex', queue: [{ id: 'task', message: 'Work' }] },
    },
    { id: 'b', type: 'agent', position: { x: 300, y: 0 }, data: { label: 'B', adapter: 'codex' } },
    { id: 'c', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'C', adapter: 'codex' } },
  ],
  links: [{ source: 'a', target: 'b' }],
});

let core: Core;
let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-batch-'));
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
const node = (id: string) => doc().nodes.find((one) => one.id === id);
const revision = () =>
  Number(
    readOnDisk(profile, (disk) =>
      disk.prepare('SELECT rev FROM document WHERE canvas_id = ?').get(CANVAS),
    )?.rev,
  );

function batch(ops: object[], more: object = {}) {
  return core.call('canvas.batch', { canvas: CANVAS, ops, ...more }, CALLERS.you);
}

describe('canvas.batch', () => {
  it('applies its edits in order as one change at one revision, returning each one’s result', async () => {
    const before = revision();
    const done = await batch([
      { op: 'canvas.addAgent', args: { at: { x: 1500, y: 0 }, adapter: 'codex', role: 'Tests' } },
      { op: 'queue.add', args: { agent: 'b', entry: { message: 'Review it' } } },
      { op: 'canvas.rename', args: { node: 'c', label: 'Checker' } },
    ]);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    const { results, revs } = done.value as {
      results: [{ id: string }, { id: string }, object];
      revs: Record<string, number>;
    };
    expect(revision()).toBe(before + 1);
    expect(revs).toMatchObject({ [`canvas:${CANVAS}`]: revision() });
    expect(node(results[0].id)?.data).toMatchObject({ adapter: 'codex', role: 'Tests' });
    const b = node('b');
    expect(b?.type === 'agent' && findItem(b.data.queue ?? [], results[1].id)?.item).toEqual({
      id: results[1].id,
      message: 'Review it',
    });
    expect(results[2]).toEqual({});
    expect(node('c')?.data.label).toBe('Checker');
    expect(
      readOnDisk(profile, (disk) =>
        disk
          .prepare('SELECT op, by_party FROM revision WHERE canvas_id = ? AND rev = ?')
          .get(CANVAS, revision()),
      ),
    ).toEqual({ op: 'canvas.batch', by_party: 'you' });
  });

  it('builds each edit over what the ones before it left', async () => {
    const done = await batch([
      { op: 'canvas.link', args: { a: 'a', b: 'c' } },
      { op: 'canvas.rename', args: { node: 'c', label: 'Gone soon' } },
      { op: 'canvas.delete', args: { nodes: ['c'] } },
    ]);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(node('c')).toBeUndefined();
    expect(doc().links).toEqual([{ source: 'a', target: 'b' }]);
  });

  it('applies none of it when one edit fails, saying which', async () => {
    const before = doc();
    expect(
      await batch([
        { op: 'canvas.rename', args: { node: 'b', label: 'Builder' } },
        { op: 'queue.remove', args: { agent: 'a', item: 'missing' } },
      ]),
    ).toEqual({
      ok: false,
      error: {
        code: 'not-found',
        sentence: 'ops[1] (queue.remove): There is no queue item missing on this agent.',
      },
    });
    expect(doc()).toBe(before);
    // Or one whose build refuses it (a connection its adapter lacks).
    expect(
      await batch([
        { op: 'canvas.rename', args: { node: 'b', label: 'Builder' } },
        { op: 'agent.setConnection', args: { agent: 'b', connection: 'codex.nowhere' } },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'invalid', sentence: /^ops\[1\]/ } });
    expect(doc()).toBe(before);
  });

  it('is a conflict as a whole when an entity it expects has another revision', async () => {
    const before = doc();
    expect(
      await batch([{ op: 'canvas.rename', args: { node: 'b', label: 'Builder' } }], {
        expect: { 'node/b': 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(doc()).toBe(before);
  });

  it('commits nothing, at no revision, when its edits change nothing', async () => {
    const before = revision();
    expect(await batch([{ op: 'canvas.rename', args: { node: 'b', label: 'B' } }])).toEqual({
      ok: true,
      value: { results: [{}], revs: {} },
    });
    expect(revision()).toBe(before);
  });

  it('holds only document edits, never another batch', async () => {
    for (const op of [
      { op: 'run.pause', args: { target: { agent: 'a' } } },
      { op: 'canvas.batch', args: { ops: [] } },
      { op: 'canvas.save', args: {} },
    ]) {
      expect(await batch([op])).toMatchObject({ ok: false, error: { code: 'invalid' } });
    }
    expect(await batch([])).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('drains the lanes of the agents its edits would remove or switch', () => {
    expect(
      drainsOf(
        SURFACE['canvas.batch'],
        {
          canvas: CANVAS,
          ops: [
            { op: 'canvas.rename', args: { node: 'b', label: 'Builder' } },
            { op: 'canvas.delete', args: { nodes: ['a'] } },
            { op: 'agent.setConnection', args: { agent: 'c', connection: 'codex.terminal' } },
          ],
        },
        SURFACE,
      ),
    ).toEqual([
      ['app', CANVAS, 'a'],
      ['app', CANVAS, 'c'],
    ]);
  });
});
