import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests never load the real 'electron' module (importing it would download the binary).
const { showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  showSaveDialog: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog, showSaveDialog },
}));

import { MAX_CANVAS_BYTES } from '../shared/ipc';
import { forgetCanvas, openCanvas, saveCanvas } from './canvas';

/** A stand-in for a renderer's web contents: canvas.ts only keys its memory by it. */
const contents = () => ({}) as Electron.WebContents;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-canvas-'));
  showOpenDialog.mockReset();
  showSaveDialog.mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('canvas files', () => {
  it('opens the file picked in the Open dialog, then saves back to it without asking', async () => {
    const file = path.join(dir, 'team.corral');
    await writeFile(file, '{"format":"corrallm"}');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    const window = contents();

    await expect(openCanvas(window)).resolves.toEqual({
      name: 'team.corral',
      text: '{"format":"corrallm"}',
    });
    await expect(saveCanvas(window, 'changed', false)).resolves.toBe('team.corral');
    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('changed');
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['team.corral']);
  });

  it('asks where to save a canvas without a file, or when choosing, adding the extension', async () => {
    const window = contents();
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'plan') });
    await expect(saveCanvas(window, 'one', false)).resolves.toBe('plan.corral');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'copy.corral') });
    await expect(saveCanvas(window, 'two', true)).resolves.toBe('copy.corral');
    // The copy is the canvas's file now.
    await expect(saveCanvas(window, 'three', false)).resolves.toBe('copy.corral');
    expect(showSaveDialog).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(dir, 'plan.corral'), 'utf8')).toBe('one');
    expect(await readFile(path.join(dir, 'copy.corral'), 'utf8')).toBe('three');
  });

  it('resolves with null when a dialog is cancelled, writing nothing', async () => {
    const window = contents();
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    await expect(openCanvas(window)).resolves.toBeNull();
    await expect(saveCanvas(window, 'text', false)).resolves.toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('forgets the file for a new canvas, so the next save asks where', async () => {
    const window = contents();
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'a.corral') });
    await saveCanvas(window, 'one', false);
    forgetCanvas(window);
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'b.corral') });
    await expect(saveCanvas(window, 'two', false)).resolves.toBe('b.corral');
  });

  it('refuses to open a file too large to be a canvas', async () => {
    const file = path.join(dir, 'huge.corral');
    await writeFile(file, Buffer.alloc(MAX_CANVAS_BYTES + 1));
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    await expect(openCanvas(contents())).rejects.toThrow('huge.corral is too large to be a canvas');
  });
});
