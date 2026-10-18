import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../shared/canvas';
import { mintTrustedPath as at } from './core/host';
import { CanvasMemory, writeWhole } from './memory';

const TEAM = '11111111-1111-4111-8111-111111111111' as CanvasId;
const OTHER = '22222222-2222-4222-8222-222222222222' as CanvasId;
const THIRD = '33333333-3333-4333-8333-333333333333' as CanvasId;
const SESSION = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
const THREAD = '0199a3f0-1234-7000-8000-123456789abc';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-memory-'));
  file = path.join(dir, 'canvases.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const saved = async (canvases: Record<string, unknown>) =>
  writeFile(file, JSON.stringify({ version: 2, canvases }));

describe('CanvasMemory', () => {
  it('remembers a canvas’s file, project folder and conversations by its id, across instances', async () => {
    const memory = new CanvasMemory(file);
    expect(await memory.get(TEAM)).toEqual({ conversations: {} });
    await memory.update(TEAM, (m) => ({ ...m, project: at('/work/app') }));
    await memory.update(TEAM, (m) => ({
      ...m,
      conversations: {
        'claude-code': { a: { id: SESSION, role: 'none' } },
        codex: { a: { id: THREAD } },
      },
    }));
    await memory.setFile(TEAM, at('/work/team.corral'));

    expect(await new CanvasMemory(file).get(TEAM)).toEqual({
      file: '/work/team.corral',
      project: '/work/app',
      conversations: {
        'claude-code': { a: { id: SESSION, role: 'none' } },
        codex: { a: { id: THREAD } },
      },
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 2,
      canvases: { [TEAM]: { file: '/work/team.corral' } },
    });
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['canvases.json']);
  });

  it('finds the canvas a file belongs to, which only one canvas does', async () => {
    const memory = new CanvasMemory(file);
    await memory.setFile(TEAM, at('/work/team.corral'));
    await memory.setFile(OTHER, at('/work/other.corral'));
    expect(await memory.canvasWithFile('/work/team.corral')).toBe(TEAM);
    expect(await memory.canvasWithFile('/work/missing.corral')).toBeUndefined();

    // Saved over another canvas's file: that canvas no longer has it.
    await memory.setFile(OTHER, at('/work/team.corral'));
    expect(await memory.canvasWithFile('/work/team.corral')).toBe(OTHER);
    expect((await memory.get(TEAM)).file).toBeUndefined();
    // Nothing named: none.
    await memory.setFile(OTHER, undefined);
    expect(await memory.canvasWithFile('/work/team.corral')).toBeUndefined();
  });

  it('reads only role fingerprints that are fingerprints, and conversations with valid ids', async () => {
    const fingerprint = 'a'.repeat(64);
    const conversations = {
      role: { id: SESSION, role: fingerprint },
      absent: { id: SESSION, role: 'none' },
      unknown: { id: SESSION },
      text: { id: SESSION, role: 'Review changes' },
      upper: { id: SESSION, role: 'A'.repeat(64) },
      flag: { id: '--dangerously-skip-permissions', role: fingerprint },
      malformed: { id: 'session-1' },
      path: { id: '../session' },
      newline: { id: `${SESSION}\n` },
      wrongType: { id: 42 },
      bare: SESSION,
    };
    await saved({
      [TEAM]: { conversations: { 'claude-code': conversations, codex: conversations } },
    });
    const expected = {
      role: { id: SESSION, role: fingerprint },
      absent: { id: SESSION, role: 'none' },
      unknown: { id: SESSION },
      text: { id: SESSION },
      upper: { id: SESSION },
    };
    expect(await new CanvasMemory(file).get(TEAM)).toEqual({
      conversations: { 'claude-code': expected, codex: expected },
    });
  });

  it('applies updates made together in order, losing none', async () => {
    const memory = new CanvasMemory(file);
    await Promise.all(
      ['a', 'b', 'c'].map((agent, index) =>
        memory.update(TEAM, (m) => ({
          ...m,
          conversations: {
            'claude-code': {
              ...m.conversations['claude-code'],
              [agent]: { id: `0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e1${String(index + 1)}` },
            },
          },
        })),
      ),
    );
    expect((await new CanvasMemory(file).get(TEAM)).conversations['claude-code']).toEqual({
      a: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
      b: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12' },
      c: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13' },
    });
  });

  it('reads what an update just changed, though it is still being written', async () => {
    const memory = new CanvasMemory(file);
    void memory.update(TEAM, () => ({ conversations: { 'claude-code': { a: { id: SESSION } } } }));
    expect((await memory.get(TEAM)).conversations['claude-code']).toEqual({ a: { id: SESSION } });
  });

  it('rejects flush after a write failure until a later write succeeds', async () => {
    await writeFile(file, 'blocks the metadata directory');
    const nested = path.join(file, 'canvases.json');
    const memory = new CanvasMemory(nested);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Ordinary updates remain nonfatal; shutdown must still see their failed write.
      await memory.update(TEAM, () => ({
        conversations: { 'claude-code': { a: { id: SESSION } } },
      }));
      expect(logged).toHaveBeenCalledOnce();
      await expect(memory.flush()).rejects.toThrow();

      await rm(file);
      await mkdir(file);
      await memory.update(TEAM, (current) => current);
      await expect(memory.flush()).resolves.toBeUndefined();
      expect((await new CanvasMemory(nested).get(TEAM)).conversations).toEqual({
        'claude-code': { a: { id: SESSION } },
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps only the canvases used most recently', async () => {
    const memory = new CanvasMemory(file, 2);
    await memory.setFile(TEAM, at('/1.corral'));
    await memory.setFile(OTHER, at('/2.corral'));
    await memory.update(TEAM, (m) => m);
    await memory.setFile(THIRD, at('/3.corral'));
    const again = new CanvasMemory(file, 2);
    expect(await again.get(OTHER)).toEqual({ conversations: {} });
    expect((await again.get(TEAM)).file).toBe('/1.corral');
    expect((await again.get(THIRD)).file).toBe('/3.corral');
  });

  it('reads a canvas with none of the fields later versions add', async () => {
    await saved({
      [TEAM]: { conversations: {} },
      [OTHER]: { file: '/o.corral', conversations: {} },
    });
    const memory = new CanvasMemory(file);
    expect(await memory.get(TEAM)).toEqual({ conversations: {} });
    expect(await memory.get(OTHER)).toEqual({ file: '/o.corral', conversations: {} });
  });

  it('reads a version 1 file as empty, and starts afresh from one it cannot read', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        canvases: { '/team.corral': { project: '/p', sessions: { a: SESSION } } },
      }),
    );
    const memory = new CanvasMemory(file);
    expect(await memory.canvasWithFile('/team.corral')).toBeUndefined();
    await memory.update(TEAM, (m) => m);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 2,
      canvases: { [TEAM]: { conversations: {} } },
    });

    await writeFile(file, 'not json');
    expect(await new CanvasMemory(file).get(TEAM)).toEqual({ conversations: {} });
  });

  it('ignores entries that are not right', async () => {
    await saved({
      [TEAM]: {
        file: '/t.corral',
        project: '/p',
        conversations: { 'claude-code': { a: { id: SESSION } } },
      },
      [OTHER]: { project: 7, conversations: {} },
      [THIRD]: 'nope',
      '/old/path.corral': { conversations: {} },
      '44444444-4444-4444-8444-444444444444': { file: 'relative.corral', conversations: {} },
    });
    const memory = new CanvasMemory(file);
    expect(await memory.get(TEAM)).toEqual({
      file: '/t.corral',
      project: '/p',
      conversations: { 'claude-code': { a: { id: SESSION } } },
    });
    expect(await memory.get(OTHER)).toEqual({ conversations: {} });
    expect(await memory.get(THIRD)).toEqual({ conversations: {} });
    await memory.update(TEAM, (m) => m);
    expect(
      Object.keys((JSON.parse(await readFile(file, 'utf8')) as { canvases: object }).canvases),
    ).toEqual([TEAM]);
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
