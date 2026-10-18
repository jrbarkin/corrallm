import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { MAX_RUN_BYTES } from '../shared/run';
import type { RunCheckpoint } from '../shared/run';
import { mintTrustedPath } from './core/host';
import * as canvasMemory from './memory';
import { CanvasMemory } from './memory';
import { RunJournal } from './run-journal';

const checkpoint: RunCheckpoint = {
  version: 2,
  workflow: '{"nodes":[]}',
  state: '{"paused":true}',
  messages: '[]',
  updatedAt: 123,
};
const SESSION = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';

let directory: string;
let memory: CanvasMemory;
function journal() {
  return new RunJournal(path.join(directory, 'runs'), {
    memory,
    projectOf: () => '/work/project',
  });
}
/** A canvas kept in file `name`, which holds `text`. */
async function named(name: string, text = '{"saved":true}'): Promise<[CanvasId, string]> {
  const canvas = newCanvasId();
  const file = path.join(directory, name);
  await writeFile(file, text);
  await memory.setFile(canvas, mintTrustedPath(file));
  return [canvas, file];
}
const record = (canvas: CanvasId) => path.join(directory, 'runs', canvas, 'record.json');
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'corrallm-runs-'));
  memory = new CanvasMemory(path.join(directory, 'memory.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await memory.flush();
  await rm(directory, { recursive: true, force: true });
});

describe('RunJournal', () => {
  it('persists an unsaved draft under its id, with its conversations, across journal instances', async () => {
    const first = journal();
    const canvas = await first.last();
    const context = await first.get(canvas);
    expect(context).toMatchObject({ id: canvas, checkpoint: null, name: null });
    await memory.update(canvas, () => ({
      project: mintTrustedPath('/work/project'),
      conversations: { 'claude-code': { a: { id: SESSION } } },
    }));
    await first.save(canvas, context.token, checkpoint);
    expect(await first.get(canvas)).toMatchObject({ checkpoint, token: context.token });

    const second = journal();
    expect(await second.last()).toBe(canvas);
    expect(await second.get(canvas)).toMatchObject({
      id: canvas,
      checkpoint,
      name: null,
      project: { path: '/work/project' },
    });
    expect((await memory.get(canvas)).conversations['claude-code']?.a?.id).toBe(SESSION);
    expect(
      (await readdir(path.join(directory, 'runs', canvas))).some((name) =>
        name.endsWith('.partial'),
      ),
    ).toBe(false);
  });

  it('keeps one record per canvas, naming its file, and the canvas the profile had last', async () => {
    const [canvas, file] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    expect(JSON.parse(await readFile(record(canvas), 'utf8'))).toEqual({
      version: 2,
      id: canvas,
      file,
      checkpoint,
      remembered: { conversations: {} },
    });
    expect(JSON.parse(await readFile(path.join(directory, 'runs', 'last.json'), 'utf8'))).toEqual({
      version: 2,
      canvas,
    });
  });

  it('restores a named canvas and its saved text, keeping checkpoint edits separate', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    const next = journal();
    expect(await next.last()).toBe(canvas);
    expect(await next.get(canvas)).toMatchObject({
      checkpoint,
      name: 'team.corral',
      savedText: '{"saved":true}',
    });
  });

  it('reads a record with none of the fields later versions add', async () => {
    const canvas = newCanvasId();
    await mkdir(path.dirname(record(canvas)), { recursive: true });
    await writeFile(record(canvas), JSON.stringify({ version: 2, id: canvas, checkpoint }));
    expect(await journal().get(canvas)).toMatchObject({ id: canvas, checkpoint, name: null });
  });

  it.each([
    {
      change: 'the project changed',
      current: { project: mintTrustedPath('/work/other'), conversations: {} },
    },
    {
      change: 'a conversation was explicitly cleared',
      current: {
        project: mintTrustedPath('/work/project'),
        conversations: { codex: { b: { id: THREAD } } },
      },
    },
  ])('does not resurrect backed-up conversations after $change', async ({ current }) => {
    const runs = journal();
    const canvas = await runs.last();
    const { token } = await runs.get(canvas);
    await memory.update(canvas, () => ({
      project: mintTrustedPath('/work/project'),
      conversations: {
        'claude-code': { a: { id: SESSION, role: 'a'.repeat(64) } },
        codex: { a: { id: SESSION, role: 'none' } },
      },
    }));
    await runs.save(canvas, token, checkpoint);

    // Native metadata can change without the queue checkpoint changing (and being written again).
    await memory.update(canvas, () => current);
    memory = new CanvasMemory(path.join(directory, 'memory.json'));
    await journal().last();
    expect(await memory.get(canvas)).toEqual(current);
  });

  it('recovers a canvas’s file, folder and conversations when canvas memory lost them', async () => {
    const [canvas, file] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    const { token } = await runs.get(canvas);
    const remembered = {
      file: mintTrustedPath(file),
      project: mintTrustedPath('/work/project'),
      conversations: {
        'claude-code': { a: { id: SESSION, role: 'a'.repeat(64) } },
        codex: { b: { id: THREAD, role: 'none' } },
      },
    };
    await memory.update(canvas, () => remembered);
    await runs.save(canvas, token, checkpoint);
    await memory.flush();
    await rm(path.join(directory, 'memory.json'));
    memory = new CanvasMemory(path.join(directory, 'memory.json'));

    const again = journal();
    expect(await again.last()).toBe(canvas);
    expect(await memory.get(canvas)).toEqual(remembered);
    expect(await again.get(canvas)).toMatchObject({ name: 'team.corral', checkpoint });
  });

  it('keeps the canvas’s run and token through Save As: its record names the new file', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    const before = await runs.get(canvas);
    await runs.save(canvas, before.token, checkpoint);
    const target = path.join(directory, 'team v2.corral');
    await writeFile(target, '{"copy":true}');
    // canvas:save has written the new file, and memory has it as the canvas's.
    await memory.setFile(canvas, mintTrustedPath(target));
    await runs.saved(canvas);

    expect(await runs.get(canvas)).toMatchObject({
      token: before.token,
      checkpoint,
      name: 'team v2.corral',
      savedText: '{"copy":true}',
    });
    expect(JSON.parse(await readFile(record(canvas), 'utf8'))).toMatchObject({ file: target });
  });

  it('refuses a save of the canvas a window showed before it opened or began another', async () => {
    const runs = journal();
    const first = await runs.last();
    const before = await runs.get(first);
    await runs.save(first, before.token, checkpoint);
    const next = await runs.draft();
    expect(next).not.toBe(first);
    // The window's canvas is the new one: the old token is an earlier canvas's.
    await expect(runs.save(next, before.token, checkpoint)).rejects.toThrow(/earlier canvas/);
    expect((await runs.get(next)).checkpoint).toBeNull();
    expect(await journal().last()).toBe(next);

    const [opened] = await named('team.corral');
    await runs.opened(opened);
    await expect(runs.save(opened, before.token, checkpoint)).rejects.toThrow(/earlier canvas/);
    // Opened again, a canvas's earlier token is stale too.
    const { token } = await runs.get(opened);
    await runs.opened(opened);
    await expect(runs.save(opened, token, checkpoint)).rejects.toThrow(/earlier canvas/);
  });

  it('says once it opens why a canvas opened as a copy', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas, 'team.corral is a copy of a canvas saved as other.corral.');
    expect((await runs.get(canvas)).warning).toBe(
      'team.corral is a copy of a canvas saved as other.corral.',
    );
  });

  it('restores a canvas whose file was removed as unsaved, keeping its id and checkpoint', async () => {
    const [canvas, file] = await named('gone.corral', '{}');
    const runs = journal();
    await runs.opened(canvas);
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    await rm(file);

    const next = journal();
    expect(await next.last()).toBe(canvas);
    const context = await next.get(canvas);
    expect(context).toMatchObject({ id: canvas, checkpoint, name: null });
    expect(context.warning).toContain('missing');
    expect((await memory.get(canvas)).file).toBeUndefined();
    // The same canvas: its token still saves.
    await next.save(canvas, context.token, checkpoint);
    // The window that had it open keeps saving it, as unsaved.
    await runs.save(canvas, token, checkpoint);
    expect((await runs.get(canvas)).name).toBeNull();
  });

  it('reports a failed write without blocking reads or the next save', async () => {
    const runs = journal();
    const canvas = await runs.last();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    const writing = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    vi.spyOn(canvasMemory, 'writeWhole').mockImplementationOnce(async () => {
      writing.resolve(undefined);
      await release.promise;
      throw new Error('Disk full');
    });
    const failed = runs
      .save(canvas, token, { ...checkpoint, updatedAt: 456 })
      .catch((error: unknown) => error);
    await writing.promise;
    const context = runs.get(canvas);
    release.resolve(undefined);
    expect(await failed).toEqual(new Error('Disk full'));
    expect(await context).toMatchObject({ token, checkpoint });
    const next = { ...checkpoint, updatedAt: 789 };
    await runs.save(canvas, token, next);
    expect((await runs.get(canvas)).checkpoint).toEqual(next);
  });

  it('surfaces write failure and allows a later retry', async () => {
    const runs = journal();
    const canvas = await runs.last();
    const { token } = await runs.get(canvas);
    await rm(path.join(directory, 'runs'), { recursive: true });
    await writeFile(path.join(directory, 'runs'), 'blocks directory');
    await expect(runs.save(canvas, token, checkpoint)).rejects.toThrow();
    await expect(runs.flush()).resolves.toBeUndefined();
    await rm(path.join(directory, 'runs'));
    await runs.save(canvas, token, checkpoint);
    expect((await runs.get(canvas)).checkpoint).toEqual(checkpoint);
    expect(
      JSON.parse(await readFile(path.join(directory, 'runs', 'last.json'), 'utf8')),
    ).toHaveProperty('version', 2);
  });

  it.each([
    { reason: 'malformed JSON', text: '{unreadable journal' },
    { reason: 'version 1', text: JSON.stringify({ version: 1, checkpoint }) },
    {
      reason: 'another canvas’s id',
      text: JSON.stringify({ version: 2, id: newCanvasId(), checkpoint }),
    },
    {
      reason: 'an invalid checkpoint',
      text: (canvas: CanvasId) =>
        JSON.stringify({ version: 2, id: canvas, checkpoint: { ...checkpoint, state: 'invalid' } }),
    },
    { reason: 'an oversized record', text: 'too large', size: MAX_RUN_BYTES * 2 + 1 },
  ])('sets aside a record with $reason and opens without progress', async ({ text, size }) => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    const written = typeof text === 'string' ? text : text(canvas);
    await writeFile(record(canvas), written);
    if (size !== undefined) await truncate(record(canvas), size);
    const next = journal();
    const context = await next.get(canvas);
    expect(context).toMatchObject({
      checkpoint: null,
      name: 'team.corral',
      savedText: '{"saved":true}',
    });
    const folder = path.dirname(record(canvas));
    const preserved = (await readdir(folder)).filter((name) => name.includes('.rejected-'));
    expect(preserved).toHaveLength(1);
    const rejected = path.join(folder, preserved[0] ?? '');
    expect(context.warning).toMatch(/progress.*not.*restored/i);
    expect(context.warning).toContain(rejected);
    expect((await stat(rejected)).size).toBe(size ?? Buffer.byteLength(written));
    await expect(stat(record(canvas))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await next.get(canvas)).checkpoint).toBeNull();
    await next.save(canvas, context.token, checkpoint);
    expect((await stat(rejected)).size).toBe(size ?? Buffer.byteLength(written));
  });

  it('leaves a record it could not read for another reason where it is, and says why', async () => {
    // Only a record that can't be parsed or checked is set aside: a read that fails (here, the
    // record's path is a folder) may work next time.
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    await rm(record(canvas));
    await mkdir(record(canvas));
    await expect(journal().get(canvas)).rejects.toMatchObject({ code: 'EISDIR' });
    const folder = path.dirname(record(canvas));
    expect((await readdir(folder)).filter((name) => name.includes('.rejected-'))).toEqual([]);
    expect((await stat(record(canvas))).isDirectory()).toBe(true);
  });

  it('reads a version 1 last canvas as none: a new draft', async () => {
    const folder = path.join(directory, 'runs');
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, 'last.json'),
      JSON.stringify({ version: 1, identity: '/work/team.corral', canvas: '/work/team.corral' }),
    );
    const canvas = await journal().last();
    expect((await journal().get(canvas)).name).toBeNull();
    expect(JSON.parse(await readFile(path.join(folder, 'last.json'), 'utf8'))).toEqual({
      version: 2,
      canvas,
    });
  });

  it('preserves malformed last-canvas metadata before New replaces it', async () => {
    const folder = path.join(directory, 'runs');
    await mkdir(folder, { recursive: true });
    const rejected = '{malformed last canvas';
    await writeFile(path.join(folder, 'last.json'), rejected);
    const runs = journal();
    await expect(runs.last()).rejects.toThrow();
    const canvas = await runs.draft();
    expect((await runs.get(canvas)).checkpoint).toBeNull();
    const preserved = (await readdir(folder)).filter((name) => name.startsWith('last.rejected-'));
    expect(preserved).toHaveLength(1);
    expect(await readFile(path.join(folder, preserved[0] ?? ''), 'utf8')).toBe(rejected);
  });
});
