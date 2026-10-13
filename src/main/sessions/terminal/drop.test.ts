import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { droppedPaste, quotePath } from './drop';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-drop-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('files dropped on a terminal', () => {
  it('are pasted as their paths, quoted where a shell needs it', () => {
    expect(quotePath('/Users/me/shot.png', 'darwin')).toBe('/Users/me/shot.png');
    expect(quotePath('/Users/me/Screen Shot 1.png', 'darwin')).toBe(
      "'/Users/me/Screen Shot 1.png'",
    );
    expect(quotePath("/Users/me/it's $HOME;.txt", 'linux')).toBe("'/Users/me/it'\\''s $HOME;.txt'");
    expect(quotePath('C:\\Users\\me\\shot.png', 'win32')).toBe('C:\\Users\\me\\shot.png');
    expect(quotePath('C:\\Users\\me\\Screen Shot.png', 'win32')).toBe(
      '"C:\\Users\\me\\Screen Shot.png"',
    );
  });

  it('paste only the files that are there, each followed by a space, as a terminal does', async () => {
    const shot = path.join(dir, 'Screen Shot.png');
    const notes = path.join(dir, 'notes.txt');
    await writeFile(shot, 'png');
    await writeFile(notes, 'notes');
    await expect(
      droppedPaste([shot, path.join(dir, 'gone.txt'), notes], process.platform),
    ).resolves.toBe(`${quotePath(shot)} ${quotePath(notes)} `);
    await expect(droppedPaste([path.join(dir, 'gone.txt')])).resolves.toBe('');
  });
});
