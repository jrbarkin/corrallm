import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { MAX_CANVAS_BYTES } from '../shared/ipc';
import { CanvasFiles } from './canvas';
import { mintTrustedPath } from './core/host';
import type { HostServices } from './core/host';
import type { Store } from './core/store/store';
import { openTestStore } from './core/store/test-store';
import { CanvasMemory } from './memory';

const WINDOW = 3;

let dir: string;
/** The profile, beside `dir`: what the core keeps is never among the canvas files. */
let profile: string;
let store: Store;
let memory: CanvasMemory;
let pickCanvasToOpen: ReturnType<typeof vi.fn<HostServices['pickCanvasToOpen']>>;
let pickCanvasToSave: ReturnType<typeof vi.fn<HostServices['pickCanvasToSave']>>;
let canvases: CanvasFiles;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-canvas-'));
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-profile-'));
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
  pickCanvasToOpen = vi.fn<HostServices['pickCanvasToOpen']>();
  pickCanvasToSave = vi.fn<HostServices['pickCanvasToSave']>();
  canvases = new CanvasFiles({ host: { pickCanvasToOpen, pickCanvasToSave }, memory });
});
afterEach(async () => {
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
});

/** A canvas's file's text: a version 2 canvas with id `id`. */
const text = (id: CanvasId, label = 'Agent 1') =>
  `${JSON.stringify({ format: 'corrallm', version: 2, id, nodes: [{ label }], links: [] })}\n`;
/** Answers the next Open dialog with `file`, and the next Save dialog with `saveAs`. */
const picks = ({ open, save }: { open?: string; save?: string }) => {
  if (open !== undefined) pickCanvasToOpen.mockResolvedValueOnce(mintTrustedPath(open));
  if (save !== undefined) pickCanvasToSave.mockResolvedValueOnce(mintTrustedPath(save));
};

describe('canvas files', () => {
  it('opens the file picked in the Open dialog as its canvas, then saves back to it without asking', async () => {
    const file = path.join(dir, 'team.corral');
    const id = newCanvasId();
    await writeFile(file, text(id));
    picks({ open: file });

    await expect(canvases.open(WINDOW)).resolves.toEqual({
      id,
      name: 'team.corral',
      text: text(id),
    });
    expect(pickCanvasToOpen).toHaveBeenCalledWith(WINDOW);
    expect((await memory.get(id)).file).toBe(file);
    await expect(canvases.save(WINDOW, id, text(id, 'Changed'), false)).resolves.toBe(
      'team.corral',
    );
    expect(pickCanvasToSave).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(text(id, 'Changed'));
    // Written whole: nothing is left beside it.
    expect((await readdir(dir)).filter((name) => name.endsWith('.corral'))).toEqual([
      'team.corral',
    ]);
  });

  it('asks where to save a canvas without a file, and on Save As, which keeps its id', async () => {
    const id = newCanvasId();
    picks({ save: path.join(dir, 'plan.corral') });
    await expect(canvases.save(WINDOW, id, text(id, 'one'), false)).resolves.toBe('plan.corral');
    expect(pickCanvasToSave).toHaveBeenLastCalledWith(WINDOW, 'Untitled.corral');
    picks({ save: path.join(dir, 'copy.corral') });
    await expect(canvases.save(WINDOW, id, text(id, 'two'), true)).resolves.toBe('copy.corral');
    expect(pickCanvasToSave).toHaveBeenLastCalledWith(WINDOW, path.join(dir, 'plan.corral'));
    // The copy is the canvas's file now, under the same id.
    await expect(canvases.save(WINDOW, id, text(id, 'three'), false)).resolves.toBe('copy.corral');
    expect(pickCanvasToSave).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(dir, 'plan.corral'), 'utf8')).toBe(text(id, 'one'));
    expect(await readFile(path.join(dir, 'copy.corral'), 'utf8')).toBe(text(id, 'three'));
    expect((await memory.get(id)).file).toBe(path.join(dir, 'copy.corral'));
  });

  it('opens the original after Save As as a copy, with an id of its own it keeps', async () => {
    const id = newCanvasId();
    const original = path.join(dir, 'team.corral');
    const saved = path.join(dir, 'team v2.corral');
    await writeFile(original, text(id));
    picks({ open: original, save: saved });
    await canvases.open(WINDOW);
    await canvases.save(WINDOW, id, text(id), true);

    picks({ open: original });
    const copy = await canvases.open(WINDOW);
    expect(copy).toMatchObject({ name: 'team.corral', text: text(id) });
    expect(copy?.id).not.toBe(id);
    expect(copy?.copy).toBe(
      'team.corral is a copy of a canvas saved as team v2.corral: it opened as a canvas of its own.',
    );
    expect((await memory.get(id)).file).toBe(saved);
    // Opened again, it is the same copy: its conversations are its own.
    picks({ open: original });
    expect((await canvases.open(WINDOW))?.id).toBe(copy?.id);
    // Saved, it holds its own id.
    if (copy) await canvases.save(WINDOW, copy.id, text(copy.id), false);
    picks({ open: original });
    expect(await canvases.open(WINDOW)).toEqual({
      id: copy?.id,
      name: 'team.corral',
      text: text(copy?.id ?? id),
    });
  });

  it('opens a copy made in the Finder as a canvas of its own', async () => {
    const id = newCanvasId();
    const file = path.join(dir, 'team.corral');
    await writeFile(file, text(id));
    picks({ open: file });
    await canvases.open(WINDOW);
    await writeFile(path.join(dir, 'team copy.corral'), text(id));
    picks({ open: path.join(dir, 'team copy.corral') });
    const copy = await canvases.open(WINDOW);
    expect(copy?.id).not.toBe(id);
    expect(copy?.copy).toContain('team copy.corral is a copy of a canvas saved as team.corral');
  });

  it('keeps a moved or renamed file’s canvas, and the record follows it', async () => {
    const id = newCanvasId();
    const before = path.join(dir, 'team.corral');
    const after = path.join(dir, 'renamed.corral');
    await writeFile(before, text(id));
    picks({ open: before });
    await canvases.open(WINDOW);
    await rename(before, after);

    picks({ open: after });
    expect(await canvases.open(WINDOW)).toEqual({ id, name: 'renamed.corral', text: text(id) });
    expect((await memory.get(id)).file).toBe(after);
  });

  it('refuses a version 1 canvas, remembering nothing', async () => {
    const file = path.join(dir, 'old.corral');
    await writeFile(file, JSON.stringify({ format: 'corrallm', version: 1, nodes: [] }));
    picks({ open: file });
    await expect(canvases.open(WINDOW)).rejects.toThrow(
      'This canvas is from an older version of corrallm',
    );
    expect(await memory.canvasWithFile(file)).toBeUndefined();
  });

  it('refuses to save text that is another canvas’s', async () => {
    const id = newCanvasId();
    picks({ save: path.join(dir, 'plan.corral') });
    await expect(canvases.save(WINDOW, id, text(newCanvasId()), false)).rejects.toThrow(
      'This canvas’s text is another canvas’s',
    );
    expect(pickCanvasToSave).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('resolves with null when a dialog is cancelled, writing nothing', async () => {
    pickCanvasToOpen.mockResolvedValue(null);
    pickCanvasToSave.mockResolvedValue(null);
    const id = newCanvasId();
    await expect(canvases.open(WINDOW)).resolves.toBeNull();
    await expect(canvases.save(WINDOW, id, text(id), false)).resolves.toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses to open a file too large to be a canvas', async () => {
    const file = path.join(dir, 'huge.corral');
    await writeFile(file, Buffer.alloc(MAX_CANVAS_BYTES + 1));
    picks({ open: file });
    await expect(canvases.open(WINDOW)).rejects.toThrow('huge.corral is too large to be a canvas');
  });
});
