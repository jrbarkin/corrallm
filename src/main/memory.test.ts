import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasMemory, writeWhole } from './memory';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-memory-'));
  file = path.join(dir, 'canvases.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CanvasMemory', () => {
  it('reads only role fingerprints that belong to valid conversation ids, for each CLI', async () => {
    const id = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    const fingerprint = 'a'.repeat(64);
    const roles = {
      role: fingerprint,
      absent: 'none',
      text: 'Review changes',
      short: 'abc',
      upper: 'A'.repeat(64),
      wrongType: 42,
      orphan: fingerprint,
      badId: fingerprint,
    };
    const ids = Object.fromEntries(Object.keys(roles).map((agent) => [agent, id]));
    delete ids.orphan;
    ids.badId = '--resume';
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        canvases: {
          '/team.corral': { sessions: ids, threads: ids, sessionRoles: roles, threadRoles: roles },
        },
      }),
    );
    const remembered = await new CanvasMemory(file).get('/team.corral');
    expect(remembered.sessionRoles).toEqual({ role: fingerprint, absent: 'none' });
    expect(remembered.threadRoles).toEqual({ role: fingerprint, absent: 'none' });
  });

  it('drops hostile and malformed session ids read from canvases.json for either CLI', async () => {
    const valid = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    const ids = {
      valid,
      flag: '--dangerously-skip-permissions',
      malformed: 'session-1',
      path: '../session',
      newline: `${valid}\n`,
      space: ` ${valid}`,
      control: `${valid}\0`,
      wrongType: 42,
    };
    await writeFile(
      file,
      JSON.stringify({ version: 1, canvases: { '/team.corral': { sessions: ids, threads: ids } } }),
    );
    expect(await new CanvasMemory(file).get('/team.corral')).toEqual({
      sessions: { valid },
      threads: { valid },
    });
  });

  it('remembers a canvas file’s project folder and sessions, across instances', async () => {
    const memory = new CanvasMemory(file);
    expect(await memory.get('/work/team.corral')).toEqual({ sessions: {} });
    await memory.update('/work/team.corral', (m) => ({ ...m, project: '/work/app' }));
    await memory.update('/work/team.corral', (m) => ({
      ...m,
      sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
    }));

    const again = new CanvasMemory(file);
    expect(await again.get('/work/team.corral')).toEqual({
      project: '/work/app',
      sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
    });
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['canvases.json']);
  });

  it('remembers agents’ Codex threads apart from their Claude Code sessions', async () => {
    const memory = new CanvasMemory(file);
    await memory.update('/work/team.corral', (m) => ({
      ...m,
      sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
      threads: { a: '0199a3f0-1234-7000-8000-123456789abc' },
    }));
    expect(await new CanvasMemory(file).get('/work/team.corral')).toEqual({
      sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
      threads: { a: '0199a3f0-1234-7000-8000-123456789abc' },
    });
  });

  it('applies updates made together in order, losing none', async () => {
    const memory = new CanvasMemory(file);
    await Promise.all(
      ['a', 'b', 'c'].map((agent, index) =>
        memory.update('/c.corral', (m) => ({
          ...m,
          sessions: {
            ...m.sessions,
            [agent]: `0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e1${String(index + 1)}`,
          },
        })),
      ),
    );
    expect((await new CanvasMemory(file).get('/c.corral')).sessions).toEqual({
      a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11',
      b: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12',
      c: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13',
    });
  });

  it('rejects flush after a write failure until a later metadata write succeeds', async () => {
    await writeFile(file, 'blocks the metadata directory');
    const nested = path.join(file, 'canvases.json');
    const memory = new CanvasMemory(nested);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Ordinary metadata updates remain nonfatal; shutdown must still see their failed write.
      await memory.update('/work/team.corral', () => ({
        sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
      }));
      expect(logged).toHaveBeenCalledOnce();
      await expect(memory.flush()).rejects.toThrow();

      await rm(file);
      await mkdir(file);
      await memory.update('/work/team.corral', (current) => current);
      await expect(memory.flush()).resolves.toBeUndefined();
      expect((await new CanvasMemory(nested).get('/work/team.corral')).sessions).toEqual({
        a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11',
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps only the canvases used most recently', async () => {
    const memory = new CanvasMemory(file, 2);
    await memory.update('/one.corral', (m) => ({ ...m, project: '/1' }));
    await memory.update('/two.corral', (m) => ({ ...m, project: '/2' }));
    await memory.update('/one.corral', (m) => m);
    await memory.update('/three.corral', (m) => ({ ...m, project: '/3' }));
    const saved = new CanvasMemory(file, 2);
    expect(await saved.get('/two.corral')).toEqual({ sessions: {} });
    expect((await saved.get('/one.corral')).project).toBe('/1');
    expect((await saved.get('/three.corral')).project).toBe('/3');
  });

  it('starts afresh from a file it cannot read, and ignores entries that are not right', async () => {
    // (What agents were given, which main once kept here, is in the canvas's file now: left out.)
    await writeFile(file, 'not json');
    expect(await new CanvasMemory(file).get('/x.corral')).toEqual({ sessions: {} });

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        canvases: {
          '/good.corral': {
            project: '/p',
            sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11', b: 42 },
            chosen: {
              a: { model: 'haiku', mode: 'yolo' },
              b: { model: 'rm -rf /', mode: 'plan' },
              c: 'fast',
            },
          },
          '/bad.corral': { project: 7 },
          '/worse.corral': 'nope',
        },
      }),
    );
    const memory = new CanvasMemory(file);
    expect(await memory.get('/good.corral')).toEqual({
      project: '/p',
      sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
    });
    expect(await memory.get('/bad.corral')).toEqual({ sessions: {} });
    expect(await memory.get('/worse.corral')).toEqual({ sessions: {} });
    await memory.update('/good.corral', (m) => m);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      canvases: {
        '/good.corral': { project: '/p', sessions: { a: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' } },
      },
    });
  });
});

describe('writeWhole', () => {
  it('writes a file whole while other writes of it are under way, each beside it on its own', async () => {
    const texts = ['one', 'two', 'three', 'four', 'five'].map((word) => `${word}\n`);
    await Promise.all(texts.map((text) => writeWhole(file, text)));
    expect(texts).toContain(await readFile(file, 'utf8'));
    // Nothing is left beside it.
    expect(await readdir(dir)).toEqual(['canvases.json']);
  });
});
