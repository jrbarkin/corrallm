import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { mintTrustedPath } from './host';
import { exportHandoff } from './handoff-file';
import type { ExportFs } from './handoff-file';
import type { WorkingDirectory } from './workspaces/resolver';

/*
 * The handoff's Markdown copy (B11a C10), on a real file system: exactly the handoff's text, at a
 * bounded relative path in the agent's checkout, never through a symlink, through a temporary
 * file created exclusively beside it, replacing only a missing file or this agent's own last copy,
 * so it never overwrites your edit or another agent's file in a shared tree, races included.
 */

const CANVAS = '6e5d4c3b-2a19-4f08-8e7d-6c5b4a392817' as CanvasId;
const TEXT = 'The task: the parser.\nDone: its grammar.\nLeft: its tests.\n';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let folder: string;
let checkout: string;
let outside: string;

beforeEach(async () => {
  folder = await realpath(await mkdtemp(path.join(tmpdir(), 'corrallm-handoff-file-')));
  checkout = path.join(folder, 'checkout');
  outside = path.join(folder, 'outside');
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  await mkdir(outside);
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const READY: () => WorkingDirectory = () => ({
  state: 'ready',
  cwd: mintTrustedPath(checkout),
  workspace: null,
  generation: 0,
  branch: null,
});

/** The exporter over the checkout, its file system the real one but for what `fs` replaces. */
function exporter(fs: Partial<ExportFs> = {}, directory = READY) {
  return exportHandoff({
    directory: () => Promise.resolve(directory()),
    fs: { ...fsp, ...fs },
  });
}

const write = (
  file: string,
  last?: { path: string; sha256: string },
  run = exporter(),
  text = TEXT,
) => run({ canvas: CANVAS, agent: 'worker', path: file, text, last });

/** Every name in a folder, temporary files included. */
const names = (at: string) => readdir(at);

describe('the Markdown copy of a handoff', () => {
  it('writes exactly its text to a missing file in a folder that exists, saying its hash', async () => {
    expect(await write('docs/HANDOFF.md')).toEqual({ ok: true, sha256: sha256(TEXT) });
    expect(await readFile(path.join(checkout, 'docs', 'HANDOFF.md'), 'utf8')).toBe(TEXT);
    expect(await names(path.join(checkout, 'docs'))).toEqual(['HANDOFF.md']);
  });

  it('replaces only its own last copy, never your edit of it', async () => {
    const first = await write('HANDOFF.md');
    if (!first.ok) throw new Error(first.sentence);
    const last = { path: 'HANDOFF.md', sha256: first.sha256 };
    expect(await write('HANDOFF.md', last, exporter(), 'Newer.')).toEqual({
      ok: true,
      sha256: sha256('Newer.'),
    });
    expect(await readFile(path.join(checkout, 'HANDOFF.md'), 'utf8')).toBe('Newer.');
    // You edited it since: never replaced.
    await writeFile(path.join(checkout, 'HANDOFF.md'), 'Your notes.');
    expect(await write('HANDOFF.md', { path: 'HANDOFF.md', sha256: sha256('Newer.') })).toEqual({
      ok: false,
      why: 'refused',
      sentence: expect.stringMatching(/didn’t write/) as unknown,
    });
    expect(await readFile(path.join(checkout, 'HANDOFF.md'), 'utf8')).toBe('Your notes.');
    expect(await names(checkout)).toEqual(['HANDOFF.md', 'docs']);
  });

  it('never replaces another agent’s copy in a shared tree, nor one at a path it last wrote elsewhere', async () => {
    // Another agent of the same workspace wrote its own there.
    await writeFile(path.join(checkout, 'HANDOFF.md'), 'Another agent’s handoff.');
    expect(await write('HANDOFF.md')).toMatchObject({ ok: false, why: 'refused' });
    expect(
      await write('HANDOFF.md', {
        path: 'docs/HANDOFF.md',
        sha256: sha256('Another agent’s handoff.'),
      }),
    ).toMatchObject({ ok: false, why: 'refused' });
    expect(await readFile(path.join(checkout, 'HANDOFF.md'), 'utf8')).toBe(
      'Another agent’s handoff.',
    );
  });

  it('refuses a folder that doesn’t exist, making none', async () => {
    expect(await write('notes/HANDOFF.md')).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'its folder notes doesn’t exist.',
    });
    expect(await names(checkout)).toEqual(['docs']);
  });

  it('never follows a symlink: in a folder of its path, or at the file', async () => {
    await symlink(outside, path.join(checkout, 'linked'));
    await writeFile(path.join(outside, 'kept.md'), 'Outside.');
    await symlink(path.join(outside, 'kept.md'), path.join(checkout, 'docs', 'link.md'));
    expect(await write('linked/HANDOFF.md')).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'linked is a symlink.',
    });
    expect(await write('docs/link.md')).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'docs/link.md is a symlink.',
    });
    expect(await names(outside)).toEqual(['kept.md']);
    expect(await readFile(path.join(outside, 'kept.md'), 'utf8')).toBe('Outside.');
  });

  it('refuses a folder at its path', async () => {
    await mkdir(path.join(checkout, 'folder.md'));
    expect(await write('folder.md')).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'folder.md isn’t a file.',
    });
  });

  it('refuses a path it doesn’t write: outside, Git’s, an option, or not Markdown', async () => {
    for (const file of [
      '../HANDOFF.md',
      '.git/HANDOFF.md',
      '-HANDOFF.md',
      'HANDOFF.txt',
      '/HANDOFF.md',
    ])
      expect(await write(file), file).toEqual({
        ok: false,
        why: 'refused',
        sentence: 'its path isn’t a relative Markdown path corrallm writes.',
      });
    expect(await names(path.dirname(checkout))).toEqual(['checkout', 'outside']);
  });

  it('says it failed, not that it refused, where the file system says no', async () => {
    await chmod(path.join(checkout, 'docs'), 0o555);
    try {
      expect(await write('docs/HANDOFF.md')).toEqual({
        ok: false,
        why: 'failed',
        sentence: expect.stringMatching(/^it couldn’t be written \(.*EACCES/) as unknown,
      });
    } finally {
      await chmod(path.join(checkout, 'docs'), 0o755);
    }
    expect(await names(path.join(checkout, 'docs'))).toEqual([]);
  });

  it('writes nothing while the agent’s workspace isn’t ready, saying why', async () => {
    const held = exporter({}, () => ({
      state: 'held',
      reason: 'creating',
      sentence: 'Its worktree is being made.',
    }));
    expect(await write('HANDOFF.md', undefined, held)).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'its workspace isn’t ready: Its worktree is being made.',
    });
    expect(await names(checkout)).toEqual(['docs']);
  });
});

describe('a race with the copy', () => {
  it('leaves a file made at its path as it is written, and no temporary file', async () => {
    const target = path.join(checkout, 'HANDOFF.md');
    const raced = exporter({
      // Someone writes the file between the checks and the copy landing.
      link: async (from, to) => {
        await writeFile(target, 'Made meanwhile.');
        return fsp.link(from, to);
      },
    });
    expect(await write('HANDOFF.md', undefined, raced)).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'a file appeared at HANDOFF.md as it was written.',
    });
    expect(await readFile(target, 'utf8')).toBe('Made meanwhile.');
    expect(await names(checkout)).toEqual(['HANDOFF.md', 'docs']);
  });

  it('leaves its own copy edited as it is written, and no temporary file', async () => {
    const target = path.join(checkout, 'HANDOFF.md');
    await writeFile(target, TEXT);
    const raced = exporter({
      // You edit it once it was checked, while its replacement is written.
      open: async (file, flags, mode) => {
        if (String(file).endsWith('.tmp')) await writeFile(target, 'Your edit.');
        return fsp.open(file, flags, mode);
      },
    });
    expect(
      await write('HANDOFF.md', { path: 'HANDOFF.md', sha256: sha256(TEXT) }, raced, 'Newer.'),
    ).toEqual({ ok: false, why: 'refused', sentence: 'HANDOFF.md changed as it was written.' });
    expect(await readFile(target, 'utf8')).toBe('Your edit.');
    expect(await names(checkout)).toEqual(['HANDOFF.md', 'docs']);
  });

  it('notices a folder swapped for a symlink as it is written, writing nothing there', async () => {
    const docs = path.join(checkout, 'docs');
    const raced = exporter({
      open: async (file, flags, mode) => {
        if (String(file).endsWith('.tmp')) {
          const handle = await fsp.open(file, flags, mode);
          // The folder checked is replaced by a symlink to another once the copy is begun.
          await fsp.rename(docs, path.join(checkout, 'moved'));
          await symlink(outside, docs);
          return handle;
        }
        return fsp.open(file, flags, mode);
      },
    });
    expect(await write('docs/HANDOFF.md', undefined, raced)).toEqual({
      ok: false,
      why: 'refused',
      sentence: 'its folder docs changed as it was written.',
    });
    // Nothing reached the folder the symlink names, and the copy never landed.
    expect(await names(outside)).toEqual([]);
    expect(await names(path.join(checkout, 'moved'))).not.toContain('HANDOFF.md');
  });
});
