import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CanvasMemory } from './memory';

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
  it('remembers a canvas file’s project folder and sessions, across instances', async () => {
    const memory = new CanvasMemory(file);
    expect(await memory.get('/work/team.corral')).toEqual({ sessions: {} });
    await memory.update('/work/team.corral', (m) => ({ ...m, project: '/work/app' }));
    await memory.update('/work/team.corral', (m) => ({ ...m, sessions: { a: 'id-a' } }));

    const again = new CanvasMemory(file);
    expect(await again.get('/work/team.corral')).toEqual({
      project: '/work/app',
      sessions: { a: 'id-a' },
    });
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['canvases.json']);
  });

  it('remembers the model and mode each agent was given', async () => {
    const memory = new CanvasMemory(file);
    await memory.update('/work/team.corral', (m) => ({
      ...m,
      sessions: { a: 'id-a' },
      chosen: { a: { model: 'haiku', mode: 'plan' }, b: { mode: 'acceptEdits' } },
    }));
    expect(await new CanvasMemory(file).get('/work/team.corral')).toEqual({
      sessions: { a: 'id-a' },
      chosen: { a: { model: 'haiku', mode: 'plan' }, b: { mode: 'acceptEdits' } },
    });
  });

  it('applies updates made together in order, losing none', async () => {
    const memory = new CanvasMemory(file);
    await Promise.all(
      ['a', 'b', 'c'].map((agent) =>
        memory.update('/c.corral', (m) => ({
          ...m,
          sessions: { ...m.sessions, [agent]: `id-${agent}` },
        })),
      ),
    );
    expect((await new CanvasMemory(file).get('/c.corral')).sessions).toEqual({
      a: 'id-a',
      b: 'id-b',
      c: 'id-c',
    });
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
    await writeFile(file, 'not json');
    expect(await new CanvasMemory(file).get('/x.corral')).toEqual({ sessions: {} });

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        canvases: {
          '/good.corral': {
            project: '/p',
            sessions: { a: 'id', b: 42 },
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
      sessions: { a: 'id' },
      chosen: { a: { model: 'haiku' }, b: { mode: 'plan' } },
    });
    expect(await memory.get('/bad.corral')).toEqual({ sessions: {} });
    expect(await memory.get('/worse.corral')).toEqual({ sessions: {} });
    await memory.update('/good.corral', (m) => m);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      canvases: {
        '/good.corral': {
          project: '/p',
          sessions: { a: 'id' },
          chosen: { a: { model: 'haiku' }, b: { mode: 'plan' } },
        },
      },
    });
  });
});
