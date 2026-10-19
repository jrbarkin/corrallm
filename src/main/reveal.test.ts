import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import { FileRevealer, revealTarget } from './reveal';

let root: string;
/** The project folder, with notes.txt and src/app.ts in it, and links out of it. */
let project: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'corrallm-reveal-')));
  project = path.join(root, 'project');
  outside = path.join(root, 'outside');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(project, 'notes.txt'), 'hello\n');
  await writeFile(path.join(project, 'src', 'app.ts'), 'export {};\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(project, 'secret-link.txt'));
  await symlink(outside, path.join(project, 'outside-link'));
  await symlink(project, path.join(root, 'alias'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const link = (file: string) => pathToFileURL(file).href;

describe('a file:// link revealed in the file manager', () => {
  it('is a file or folder in the project folder, or the folder itself, as its real path', async () => {
    await expect(revealTarget(link(path.join(project, 'notes.txt')), project)).resolves.toBe(
      path.join(project, 'notes.txt'),
    );
    await expect(revealTarget(link(path.join(project, 'src')), project)).resolves.toBe(
      path.join(project, 'src'),
    );
    await expect(revealTarget(link(project), project)).resolves.toBe(project);
    // A line or column after it changes nothing.
    await expect(
      revealTarget(`${link(path.join(project, 'notes.txt'))}#L2`, project),
    ).resolves.toBe(path.join(project, 'notes.txt'));
    // The folder reached through a link: the same folder.
    await expect(
      revealTarget(link(path.join(root, 'alias', 'src', 'app.ts')), project),
    ).resolves.toBe(path.join(project, 'src', 'app.ts'));
    await expect(
      revealTarget(link(path.join(project, 'notes.txt')), path.join(root, 'alias')),
    ).resolves.toBe(path.join(project, 'notes.txt'));
  });

  it('stays inert outside the project folder, links resolved: nothing is shown', async () => {
    const inert = [
      link(path.join(outside, 'secret.txt')),
      // A link in the folder to a file outside it is outside it.
      link(path.join(project, 'secret-link.txt')),
      link(path.join(project, 'outside-link', 'secret.txt')),
      link(path.join(project, '..', 'outside', 'secret.txt')),
      `file://${project}/../outside/secret.txt`,
      link(root),
      // Nothing there.
      link(path.join(project, 'missing.txt')),
      // Not a file on this machine.
      `file://server${project}/notes.txt`,
      'https://example.com/notes.txt',
      'notes.txt',
      `file://${'a'.repeat(5000)}`,
    ];
    for (const raw of inert) await expect(revealTarget(raw, project)).resolves.toBeNull();
  });

  it('is shown for the canvas that has the folder, and never otherwise', async () => {
    const show = vi.fn<(file: string) => void>();
    const canvas = newCanvasId();
    const another = newCanvasId();
    const folders = new Map([[canvas, project]]);
    const revealer = new FileRevealer({ folderOf: (of) => folders.get(of), show });
    const notes = link(path.join(project, 'notes.txt'));
    // Another canvas, with no project folder chosen: nothing to reveal.
    await expect(revealer.reveal(another, notes)).resolves.toBe(false);
    await expect(revealer.reveal(canvas, notes)).resolves.toBe(true);
    expect(show).toHaveBeenCalledWith(path.join(project, 'notes.txt'));
    await expect(revealer.reveal(canvas, link(path.join(outside, 'secret.txt')))).resolves.toBe(
      false,
    );
    expect(show).toHaveBeenCalledTimes(1);
  });
});
