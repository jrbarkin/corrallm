import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));

import type { RunCheckpoint } from '../shared/run';
import { associateCanvas, canvasFile, forgetCanvas, saveCanvas } from './canvas';
import { CanvasMemory } from './memory';
import { RunJournal } from './run-journal';

const checkpoint: RunCheckpoint = {
  version: 1,
  workflow: '{"nodes":[]}',
  state: '{"paused":true}',
  messages: '[]',
  updatedAt: 123,
};
const contents = () => ({}) as Electron.WebContents;
let directory: string;
let memory: CanvasMemory;
let restored: ReturnType<typeof vi.fn<(contents: Electron.WebContents) => Promise<void>>>;
function journal() {
  return new RunJournal(path.join(directory, 'runs'), {
    memory,
    projectOf: () => '/work/project',
    restored,
  });
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'corrallm-runs-'));
  memory = new CanvasMemory(path.join(directory, 'memory.json'));
  restored = vi.fn().mockResolvedValue(undefined);
});
afterEach(async () => {
  await memory.flush();
  await rm(directory, { recursive: true, force: true });
});

describe('RunJournal', () => {
  it('persists an unsaved draft and native IDs across a new window and journal instance', async () => {
    const first = journal();
    const window = contents();
    const context = await first.get(window);
    expect(context).toMatchObject({ checkpoint: null, name: null });
    const identity = first.identity(window);
    if (identity === undefined) throw new Error('No draft identity');
    await memory.update(identity, () => ({
      sessions: { a: '11111111-1111-4111-8111-111111111111' },
      project: '/work/project',
    }));
    await first.save(window, context.token, checkpoint);
    expect(await first.get(window)).toMatchObject({ checkpoint, token: context.token });
    const second = journal();
    const reopened = contents();
    expect(await second.get(reopened)).toMatchObject({
      checkpoint,
      name: null,
      project: { path: '/work/project' },
    });
    expect(canvasFile(reopened)).toBeUndefined();
    expect(second.identity(reopened)).toBe(identity);
    expect((await memory.get(identity)).sessions.a).toBe('11111111-1111-4111-8111-111111111111');
    expect(restored).toHaveBeenCalledTimes(2);
    expect(
      (await readdir(path.join(directory, 'runs'))).some((name) => name.endsWith('.partial')),
    ).toBe(false);
  });

  it('restores named association and saved text while keeping checkpoint edits separate', async () => {
    const file = path.join(directory, 'team.corral');
    await writeFile(file, '{"saved":true}');
    const runs = journal();
    const window = contents();
    associateCanvas(window, file);
    await runs.opened(window);
    const { token } = await runs.get(window);
    await runs.save(window, token, checkpoint);
    const next = contents();
    expect(await journal().get(next)).toMatchObject({
      checkpoint,
      name: 'team.corral',
      savedText: '{"saved":true}',
    });
    expect(canvasFile(next)).toBe(file);
  });

  it.each([
    {
      change: 'the project changed',
      current: { project: '/work/other', sessions: {} },
    },
    {
      change: 'a conversation was explicitly cleared',
      current: {
        project: '/work/project',
        sessions: {},
        threads: { b: '22222222-2222-4222-8222-222222222222' },
      },
    },
  ])('does not resurrect backed-up native IDs after $change', async ({ current }) => {
    const runs = journal();
    const window = contents();
    const { token } = await runs.get(window);
    const identity = runs.identity(window);
    if (identity === undefined) throw new Error('No draft identity');
    await memory.update(identity, () => ({
      project: '/work/project',
      sessions: { a: '11111111-1111-4111-8111-111111111111' },
      threads: { a: '11111111-1111-4111-8111-111111111111' },
    }));
    await runs.save(window, token, checkpoint);

    // Native metadata can change without the queue checkpoint changing (and being written again).
    await memory.update(identity, () => current);
    memory = new CanvasMemory(path.join(directory, 'memory.json'));
    await journal().get(contents());
    expect(await memory.get(identity)).toEqual(current);
  });

  it('recovers backed-up native IDs when the canvas memory record is absent', async () => {
    const runs = journal();
    const window = contents();
    const { token } = await runs.get(window);
    const identity = runs.identity(window);
    if (identity === undefined) throw new Error('No draft identity');
    const remembered = {
      project: '/work/project',
      sessions: { a: '11111111-1111-4111-8111-111111111111' },
      threads: { b: '22222222-2222-4222-8222-222222222222' },
    };
    await memory.update(identity, () => remembered);
    await runs.save(window, token, checkpoint);
    await rm(path.join(directory, 'memory.json'));
    memory = new CanvasMemory(path.join(directory, 'memory.json'));

    await journal().get(contents());
    expect(await memory.get(identity)).toEqual(remembered);
  });

  it('copies checkpoints on Save As and rejects the previous generation', async () => {
    const runs = journal();
    const window = contents();
    const before = await runs.get(window);
    await runs.save(window, before.token, checkpoint);
    const target = path.join(directory, 'copy.corral');
    await writeFile(target, '{}');
    associateCanvas(window, target);
    await runs.saved(window);
    const after = await runs.get(window);
    expect(after.checkpoint).toEqual(checkpoint);
    expect(after.token).not.toBe(before.token);
    await expect(runs.save(window, before.token, { ...checkpoint, state: '{}' })).rejects.toThrow(
      /earlier canvas/,
    );
    expect((await runs.get(window)).checkpoint).toEqual(checkpoint);
  });

  it.each(
    [false, true].flatMap((named) =>
      ['copy', 'last'].map((step) => ({ canvas: named ? 'named' : 'draft', named, step })),
    ),
  )('rolls back $canvas Save As when the $step journal write fails', async ({ named, step }) => {
    const runs = journal();
    const window = contents();
    const original = path.join(directory, 'original.corral');
    if (named) {
      await writeFile(original, '{"original":true}');
      associateCanvas(window, original);
    }
    const before = await runs.get(window);
    const identity = runs.identity(window);
    await runs.save(window, before.token, checkpoint);
    const target = path.join(directory, 'copy.corral');
    await writeFile(target, '{"copy":true}');
    // canvas:save has already written the new file and switched its main association.
    associateCanvas(window, target);
    const blocked = path.join(
      directory,
      'runs',
      step === 'copy' ? `${createHash('sha256').update(target).digest('hex')}.json` : 'last.json',
    );
    if (step === 'last') await rm(blocked);
    await mkdir(blocked);

    await expect(runs.saved(window)).rejects.toThrow();
    expect(canvasFile(window)).toBe(named ? original : undefined);
    expect(runs.identity(window)).toBe(identity);
    await rm(blocked, { recursive: true });
    expect(await runs.get(window)).toMatchObject({ token: before.token, checkpoint });
    const next = { ...checkpoint, state: '{"paused":true,"retry":true}' };
    await runs.save(window, before.token, next);
    expect((await runs.get(window)).checkpoint).toEqual(next);
    if (named) {
      await saveCanvas(window, '{"original":false}', false);
      expect(await readFile(original, 'utf8')).toBe('{"original":false}');
    }
    expect(await readFile(target, 'utf8')).toBe('{"copy":true}');
  });

  it('rejects a save already queued when New changes the canvas generation', async () => {
    const runs = journal();
    const window = contents();
    const before = await runs.get(window);
    const stale = expect(runs.save(window, before.token, checkpoint)).rejects.toThrow(
      /earlier canvas/,
    );
    await runs.forgotten(window);
    await stale;
    expect((await runs.get(window)).checkpoint).toBeNull();
  });

  it('waits for old native sessions before restoring after reload', async () => {
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = new RunJournal(path.join(directory, 'runs'), {
      memory,
      projectOf: () => undefined,
      restored,
      settled: () => closed,
    });
    const context = runs.get(contents());
    let returned = false;
    void context.then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    release?.();
    await context;
    expect(returned).toBe(true);
  });

  it('New rotates identity and prevents a delayed old save from overwriting the new draft', async () => {
    const runs = journal();
    const window = contents();
    const before = await runs.get(window);
    await runs.save(window, before.token, checkpoint);
    forgetCanvas(window);
    await runs.forgotten(window);
    await expect(runs.save(window, before.token, checkpoint)).rejects.toThrow(/earlier canvas/);
    expect((await runs.get(window)).checkpoint).toBeNull();
  });

  it('restores a removed named canvas as a draft, preserving its checkpoint', async () => {
    const runs = journal();
    const window = contents();
    const file = path.join(directory, 'gone.corral');
    await writeFile(file, '{}');
    associateCanvas(window, file);
    await runs.opened(window);
    await runs.save(window, (await runs.get(window)).token, checkpoint);
    await rm(file);
    const next = contents();
    const context = await journal().get(next);
    expect(context).toMatchObject({
      checkpoint,
      name: null,
    });
    expect(context.warning).toContain('missing');
    expect(canvasFile(next)).toBeUndefined();
  });

  it('surfaces write failure and allows a later retry instead of swallowing it', async () => {
    const runs = journal();
    const window = contents();
    const { token } = await runs.get(window);
    await rm(path.join(directory, 'runs'), { recursive: true });
    await writeFile(path.join(directory, 'runs'), 'blocks directory');
    await expect(runs.save(window, token, checkpoint)).rejects.toThrow();
    await expect(runs.flush()).rejects.toThrow();
    await rm(path.join(directory, 'runs'));
    await runs.save(window, token, checkpoint);
    expect((await runs.get(window)).checkpoint).toEqual(checkpoint);
    expect(
      JSON.parse(await readFile(path.join(directory, 'runs', 'last.json'), 'utf8')),
    ).toHaveProperty('version', 1);
  });

  it('keeps an unreadable journal unchanged when New starts a fresh draft', async () => {
    const runs = journal();
    const window = contents();
    const context = await runs.get(window);
    await runs.save(window, context.token, checkpoint);
    const folder = path.join(directory, 'runs');
    const file = (await readdir(folder)).find((name) => name !== 'last.json');
    if (!file) throw new Error('No journal file');
    const rejected = '{unreadable journal';
    await writeFile(path.join(folder, file), rejected);
    const next = journal();
    const reopened = contents();
    await expect(next.get(reopened)).rejects.toThrow();
    await next.forgotten(reopened);
    const recovered = await next.get(reopened);
    await next.save(reopened, recovered.token, checkpoint);
    expect(await readFile(path.join(folder, file), 'utf8')).toBe(rejected);
  });

  it('preserves malformed last-canvas metadata before New replaces it', async () => {
    const folder = path.join(directory, 'runs');
    await mkdir(folder, { recursive: true });
    const rejected = '{malformed last canvas';
    await writeFile(path.join(folder, 'last.json'), rejected);
    const runs = journal();
    const window = contents();
    await expect(runs.get(window)).rejects.toThrow();
    await runs.forgotten(window);
    expect((await runs.get(window)).checkpoint).toBeNull();
    const preserved = (await readdir(folder)).filter((name) => name !== 'last.json');
    expect(preserved).toHaveLength(1);
    const [preservedFile] = preserved;
    if (!preservedFile) throw new Error('Rejected last-canvas metadata was not preserved');
    expect(await readFile(path.join(folder, preservedFile), 'utf8')).toBe(rejected);
  });
});
