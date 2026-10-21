import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { MAX_CANVAS_BYTES } from '../shared/ipc';
import { toFile } from '../shared/model/file';
import { CanvasFiles } from './canvas';
import { Documents } from './core/canvas/documents';
import { commitDocument } from './core/canvas/test-documents';
import { mintTrustedPath } from './core/host';
import type { HostServices } from './core/host';
import type { Store } from './core/store/store';
import { openTestStore } from './core/store/test-store';
import { CanvasMemory } from './memory';
import { CATALOG, DEFAULT_ADAPTER } from './sessions/adapters';

const WINDOW = 3;

let dir: string;
/** The profile, beside `dir`: what the core keeps is never among the canvas files. */
let profile: string;
let store: Store;
let memory: CanvasMemory;
let documents: Documents;
let pickCanvasToOpen: ReturnType<typeof vi.fn<HostServices['pickCanvasToOpen']>>;
let pickCanvasToSave: ReturnType<typeof vi.fn<HostServices['pickCanvasToSave']>>;
let canvases: CanvasFiles;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-canvas-'));
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-profile-'));
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
  documents = new Documents({ store, memory, catalog: CATALOG, defaultAdapter: DEFAULT_ADAPTER });
  pickCanvasToOpen = vi.fn<HostServices['pickCanvasToOpen']>();
  pickCanvasToSave = vi.fn<HostServices['pickCanvasToSave']>();
  canvases = new CanvasFiles({ host: { pickCanvasToOpen, pickCanvasToSave }, memory, documents });
});
afterEach(async () => {
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
});

/** A canvas's file's text: a canvas with id `id`, of one agent, `label`. */
const text = (id: CanvasId, label = 'Agent 1') =>
  toFile({
    id,
    arrange: false,
    nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label } }],
    links: [],
  });
/** Answers the next Open dialog with `file`, and the next Save dialog with `saveAs`. */
const picks = ({ open, save }: { open?: string; save?: string }) => {
  if (open !== undefined) pickCanvasToOpen.mockResolvedValueOnce(mintTrustedPath(open));
  if (save !== undefined) pickCanvasToSave.mockResolvedValueOnce(mintTrustedPath(save));
};
/** Canvas `id`'s document as its file's text. */
const textOf = async (id: CanvasId) => toFile((await documents.load(id)).document);
/** Saves canvas `id` as you pick in the Save dialog, `label` its agent's, as an op made it. */
async function saves(id: CanvasId, label: string): Promise<string | null> {
  await commitDocument(documents, id, documents.read(text(id, label)));
  return canvases.saveAs(WINDOW, id);
}

describe('canvas files', () => {
  it('opens the file picked in the Open dialog as its canvas, its document read from it', async () => {
    const file = path.join(dir, 'team.corral');
    const id = newCanvasId();
    await writeFile(file, text(id));
    picks({ open: file });

    await expect(canvases.open(WINDOW)).resolves.toEqual({ id, name: 'team.corral' });
    expect(pickCanvasToOpen).toHaveBeenCalledWith(WINDOW);
    expect((await memory.get(id)).file).toBe(file);
    expect(await textOf(id)).toBe(text(id));
  });

  it('saves where you pick, starting at the canvas’s file, which the file picked becomes, keeping its id', async () => {
    const id = newCanvasId();
    picks({ save: path.join(dir, 'plan.corral') });
    await expect(saves(id, 'one')).resolves.toBe('plan.corral');
    expect(pickCanvasToSave).toHaveBeenLastCalledWith(WINDOW, 'Untitled.corral');
    picks({ save: path.join(dir, 'copy.corral') });
    await expect(saves(id, 'two')).resolves.toBe('copy.corral');
    expect(pickCanvasToSave).toHaveBeenLastCalledWith(WINDOW, path.join(dir, 'plan.corral'));
    expect(await readFile(path.join(dir, 'plan.corral'), 'utf8')).toBe(text(id, 'one'));
    expect(await readFile(path.join(dir, 'copy.corral'), 'utf8')).toBe(text(id, 'two'));
    // The copy is the canvas's file now, under the same id.
    expect((await memory.get(id)).file).toBe(path.join(dir, 'copy.corral'));
    // Written whole: nothing is left beside them.
    expect((await readdir(dir)).sort()).toEqual(['copy.corral', 'plan.corral']);
  });

  it('opens the original after Save As as a copy, with an id of its own it keeps', async () => {
    const id = newCanvasId();
    const original = path.join(dir, 'team.corral');
    const saved = path.join(dir, 'team v2.corral');
    await writeFile(original, text(id));
    picks({ open: original, save: saved });
    await canvases.open(WINDOW);
    await canvases.saveAs(WINDOW, id);

    picks({ open: original });
    const copy = await canvases.open(WINDOW);
    expect(copy).toMatchObject({ name: 'team.corral' });
    expect(copy?.id).not.toBe(id);
    expect(copy?.copy).toBe(
      'team.corral is a copy of a canvas saved as team v2.corral: it opened as a canvas of its own.',
    );
    if (!copy) throw new Error('Not opened');
    // Its document is the file's, under its own id.
    expect(await textOf(copy.id)).toBe(text(copy.id));
    expect((await memory.get(id)).file).toBe(saved);
    // Opened again, it is the same copy: its conversations are its own.
    picks({ open: original });
    expect((await canvases.open(WINDOW))?.id).toBe(copy.id);
    // Saved over its file, it holds its own id.
    picks({ save: original });
    await canvases.saveAs(WINDOW, copy.id);
    expect(await readFile(original, 'utf8')).toBe(text(copy.id));
    picks({ open: original });
    expect(await canvases.open(WINDOW)).toEqual({ id: copy.id, name: 'team.corral' });
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
    expect(await canvases.open(WINDOW)).toEqual({ id, name: 'renamed.corral' });
    expect((await memory.get(id)).file).toBe(after);
  });

  it.each([
    [
      'a version 1 canvas',
      JSON.stringify({ format: 'corrallm', version: 1, nodes: [] }),
      'old.corral: This canvas is from an older version of corrallm',
    ],
    ['what isn’t a canvas', 'Remember the milk', 'notes.corral: This is not a corrallm canvas'],
    [
      'a canvas this corrallm can’t read',
      text(newCanvasId()).replace('"label": "Agent 1"', '"label": 7'),
      'broken.corral: nodes[0].label must be text',
    ],
  ])('refuses %s, no canvas taking it as its file', async (_label, bytes, error) => {
    const file = path.join(dir, error.split(':')[0] ?? 'x');
    await writeFile(file, bytes);
    picks({ open: file });
    await expect(canvases.open(WINDOW)).rejects.toThrow(error);
    expect(await memory.canvasWithFile(file)).toBeUndefined();
  });

  it('resolves with null when a dialog is cancelled, writing nothing', async () => {
    pickCanvasToOpen.mockResolvedValue(null);
    pickCanvasToSave.mockResolvedValue(null);
    const id = newCanvasId();
    await expect(canvases.open(WINDOW)).resolves.toBeNull();
    await expect(saves(id, 'Agent 1')).resolves.toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses to open a file too large to be a canvas', async () => {
    const file = path.join(dir, 'huge.corral');
    await writeFile(file, Buffer.alloc(MAX_CANVAS_BYTES + 1));
    picks({ open: file });
    await expect(canvases.open(WINDOW)).rejects.toThrow('huge.corral is too large to be a canvas');
  });
});
