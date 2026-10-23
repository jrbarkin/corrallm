import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BrowserWindow, dialog } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  owner: null as BrowserWindow | null,
  save: vi.fn<typeof dialog.showSaveDialog>(),
  confirm: vi.fn<typeof dialog.showMessageBox>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => native.owner },
  webContents: { fromId: () => (native.owner === null ? undefined : {}) },
  dialog: { showSaveDialog: native.save, showMessageBox: native.confirm },
}));

import { saveCanvasDialog } from './dialogs';

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-save-dialog-'));
  vi.clearAllMocks();
  native.owner = null;
  native.save.mockResolvedValue({ canceled: true, filePath: '' });
  native.confirm.mockResolvedValue({ response: 1, checkboxChecked: false });
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('the canvas Save dialog', () => {
  it.each(['parented', 'unparented'] as const)(
    'asks the native %s dialog to confirm an existing filename',
    async (kind) => {
      if (kind === 'parented') native.owner = {} as BrowserWindow;
      const file = path.join(folder, 'plan.corral');
      native.save.mockResolvedValue({ canceled: false, filePath: file });
      expect(await saveCanvasDialog(1, file)).toBe(file);
      const options = {
        filters: [{ name: 'corrallm canvas', extensions: ['corral'] }],
        defaultPath: file,
        properties: ['showOverwriteConfirmation'],
      };
      if (native.owner) expect(native.save).toHaveBeenCalledExactlyOnceWith(native.owner, options);
      else expect(native.save).toHaveBeenCalledExactlyOnceWith(options);
      expect(native.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(['parented', 'unparented'] as const)(
    'keeps the extended target on decline in a %s dialog',
    async (kind) => {
      if (kind === 'parented') native.owner = {} as BrowserWindow;
      const file = path.join(folder, 'plan.corral');
      await writeFile(file, 'Someone else’s canvas');
      native.save.mockResolvedValue({ canceled: false, filePath: path.join(folder, 'plan') });
      expect(await saveCanvasDialog(1, 'Untitled.corral')).toBeNull();
      expect(native.confirm).toHaveBeenCalledOnce();
      expect(native.confirm.mock.lastCall?.at(-1)).toMatchObject({
        type: 'warning',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: expect.stringContaining('plan.corral') as string,
      });
      if (native.owner) expect(native.confirm.mock.lastCall?.[0]).toBe(native.owner);
      expect(await readFile(file, 'utf8')).toBe('Someone else’s canvas');
    },
  );

  it('returns the extended target only after Replace is chosen', async () => {
    const file = path.join(folder, 'plan.corral');
    await writeFile(file, 'Old canvas');
    native.save.mockResolvedValue({ canceled: false, filePath: path.join(folder, 'plan') });
    native.confirm.mockResolvedValue({ response: 0, checkboxChecked: false });
    expect(await saveCanvasDialog(1, 'Untitled.corral')).toBe(file);
    expect(native.confirm).toHaveBeenCalledOnce();
  });

  it('adds the extension without another prompt for a new target, and preserves cancellation', async () => {
    const file = path.join(folder, 'new');
    native.save.mockResolvedValueOnce({ canceled: false, filePath: file });
    expect(await saveCanvasDialog(1, 'Untitled.corral')).toBe(`${file}.corral`);
    expect(await saveCanvasDialog(1, 'Untitled.corral')).toBeNull();
    expect(native.confirm).not.toHaveBeenCalled();
  });
});
