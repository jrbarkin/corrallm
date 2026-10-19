import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../shared/canvas';
import { mintTrustedPath as at } from './core/host';
import { unopened } from './core/store/store';
import type { Store } from './core/store/store';
import { onDisk, openTestStore } from './core/store/test-store';
import type { Connection } from './core/store/sqlite';
import { CanvasMemory } from './memory';

/*
 * What the core remembers of each canvas, in the profile's database (Core Database §5): its file,
 * its project folder and its agents' conversations, in `canvas` and `conversation`, the canvases
 * used least recently forgotten first.
 */

const TEAM = '11111111-1111-4111-8111-111111111111' as CanvasId;
const OTHER = '22222222-2222-4222-8222-222222222222' as CanvasId;
const THIRD = '33333333-3333-4333-8333-333333333333' as CanvasId;
const SESSION = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
const THREAD = '0199a3f0-1234-7000-8000-123456789abc';

let profile: string;
let store: Store;
/** A second connection, which only reads: what is on disk. */
let reader: Connection;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-memory-'));
  store = await openTestStore(profile);
  reader = onDisk(profile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  reader.close();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

/** Closes the store and opens it again, as the core does when it starts again. */
async function reopen(): Promise<void> {
  await store.close();
  store = await openTestStore(profile);
}

describe('CanvasMemory', () => {
  it('remembers a canvas’s file, project folder and conversations by its id, across restarts', async () => {
    const memory = new CanvasMemory(store);
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

    await reopen();
    expect(await new CanvasMemory(store).get(TEAM)).toEqual({
      file: '/work/team.corral',
      project: '/work/app',
      conversations: {
        'claude-code': { a: { id: SESSION, role: 'none' } },
        codex: { a: { id: THREAD } },
      },
    });
  });

  it('has each change on disk once it resolves', async () => {
    const memory = new CanvasMemory(store);
    let seen: unknown;
    await memory
      .update(TEAM, () => ({
        project: at('/work/app'),
        conversations: { codex: { a: { id: THREAD, role: 'none' } } },
      }))
      .then(() => {
        seen = {
          canvas: reader.prepare('SELECT file, project FROM canvas WHERE id = ?').get(TEAM),
          conversations: reader
            .prepare('SELECT adapter, agent_id, native_id, role_fingerprint FROM conversation')
            .all(),
        };
      });
    expect(seen).toEqual({
      canvas: { file: null, project: '/work/app' },
      conversations: [
        { adapter: 'codex', agent_id: 'a', native_id: THREAD, role_fingerprint: 'none' },
      ],
    });
  });

  it('finds the canvas a file belongs to, which only one canvas does', async () => {
    const memory = new CanvasMemory(store);
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

  it('forgets a conversation, and only that one, keeping the rest of the canvas', async () => {
    const memory = new CanvasMemory(store);
    await memory.update(TEAM, () => ({
      project: at('/work/app'),
      conversations: { codex: { a: { id: THREAD }, b: { id: SESSION, role: 'none' } } },
    }));
    await memory.update(TEAM, (m) => ({ ...m, conversations: { codex: { b: { id: SESSION } } } }));
    expect(await memory.get(TEAM)).toEqual({
      project: '/work/app',
      conversations: { codex: { b: { id: SESSION } } },
    });
    expect(reader.prepare('SELECT count(*) AS kept FROM conversation').get()).toEqual({ kept: 1 });
  });

  it('reads only absolute paths, role fingerprints that are fingerprints, and conversations with valid ids', async () => {
    const fingerprint = 'a'.repeat(64);
    const conversations: [agent: string, id: string, role: string | null][] = [
      ['role', SESSION, fingerprint],
      ['absent', SESSION, 'none'],
      ['unknown', SESSION, null],
      ['text', SESSION, 'Review changes'],
      ['upper', SESSION, 'A'.repeat(64)],
      ['flag', '--dangerously-skip-permissions', fingerprint],
      ['malformed', 'session-1', null],
      ['path', '../session', null],
      ['newline', `${SESSION}\n`, null],
      ['__proto__', SESSION, null],
    ];
    store.exec(`INSERT INTO canvas (id, file, project, used_at)
      VALUES ('${TEAM}', 'relative.corral', '/p', 1), ('${OTHER}', '/o.corral', 'p', 2)`);
    const add = store.prepare(
      `INSERT INTO conversation (canvas_id, adapter, agent_id, native_id, role_fingerprint)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const adapter of ['claude-code', 'codex', 'not an adapter']) {
      for (const [agent, id, role] of conversations) add.run(TEAM, adapter, agent, id, role);
    }
    const expected = Object.fromEntries([
      ['role', { id: SESSION, role: fingerprint }],
      ['absent', { id: SESSION, role: 'none' }],
      ['unknown', { id: SESSION }],
      ['text', { id: SESSION }],
      ['upper', { id: SESSION }],
      ['__proto__', { id: SESSION }],
    ]);
    const memory = new CanvasMemory(store);
    const team = await memory.get(TEAM);
    expect(team).toEqual({
      project: '/p',
      conversations: { 'claude-code': expected, codex: expected },
    });
    // An agent whose id is __proto__ is the canvas's own, never the object's.
    expect(Object.hasOwn(team.conversations.codex ?? {}, '__proto__')).toBe(true);
    expect(await memory.get(OTHER)).toEqual({ file: '/o.corral', conversations: {} });
  });

  it('applies updates made together in order, losing none', async () => {
    const memory = new CanvasMemory(store);
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
    expect((await new CanvasMemory(store).get(TEAM)).conversations['claude-code']).toEqual({
      a: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
      b: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12' },
      c: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13' },
    });
  });

  it('reads what an update just changed, though it is still being written', async () => {
    const memory = new CanvasMemory(store);
    void memory.update(TEAM, () => ({ conversations: { 'claude-code': { a: { id: SESSION } } } }));
    expect((await memory.get(TEAM)).conversations['claude-code']).toEqual({ a: { id: SESSION } });
  });

  it('rejects flush after a write failure until a later write succeeds', async () => {
    const memory = new CanvasMemory(store);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.exec(`CREATE TRIGGER refuse BEFORE INSERT ON conversation
      BEGIN SELECT RAISE(ABORT, 'The disk is full'); END`);
    // Ordinary updates remain nonfatal; shutdown must still see their failed write.
    await memory.update(TEAM, () => ({ conversations: { 'claude-code': { a: { id: SESSION } } } }));
    expect(logged).toHaveBeenCalledOnce();
    await expect(memory.flush()).rejects.toThrow('The disk is full');
    // Nothing of the update that failed was kept.
    expect(await memory.get(TEAM)).toEqual({ conversations: {} });

    store.exec('DROP TRIGGER refuse');
    await memory.update(TEAM, () => ({ conversations: { 'claude-code': { a: { id: SESSION } } } }));
    await expect(memory.flush()).resolves.toBeUndefined();
    expect((await new CanvasMemory(store).get(TEAM)).conversations).toEqual({
      'claude-code': { a: { id: SESSION } },
    });
  });

  it('keeps only the canvases used most recently, across restarts, with everything kept of them', async () => {
    const memory = new CanvasMemory(store, 2);
    await memory.setFile(TEAM, at('/1.corral'));
    await memory.update(OTHER, () => ({
      file: at('/2.corral'),
      conversations: { codex: { a: { id: THREAD } } },
    }));
    // Used again: the one used least recently is OTHER now, even within one millisecond.
    await memory.update(TEAM, (m) => m);
    await reopen();
    const again = new CanvasMemory(store, 2);
    await again.setFile(THIRD, at('/3.corral'));
    expect(await again.get(OTHER)).toEqual({ conversations: {} });
    expect(await again.canvasWithFile('/2.corral')).toBeUndefined();
    expect((await again.get(TEAM)).file).toBe('/1.corral');
    expect((await again.get(THIRD)).file).toBe('/3.corral');
    // Its conversations went with it.
    expect(reader.prepare('SELECT count(*) AS kept FROM conversation').get()).toEqual({ kept: 0 });
  });

  it('keeps a row for a canvas only its run refers to, as the one used most recently', async () => {
    const memory = new CanvasMemory(store, 2);
    await memory.setFile(TEAM, at('/1.corral'));
    await memory.setFile(OTHER, at('/2.corral'));
    // A draft's run, journaled: its canvas has a row now, and nothing else kept.
    await store.write(() => {
      memory.ensure(THIRD);
    });
    expect(await memory.get(THIRD)).toEqual({ conversations: {} });
    expect(await memory.get(TEAM)).toEqual({ conversations: {} });
    expect((await memory.get(OTHER)).file).toBe('/2.corral');
    // A canvas that has a row keeps all it had.
    await store.write(() => {
      memory.ensure(OTHER);
    });
    expect((await memory.get(OTHER)).file).toBe('/2.corral');
  });

  it('fails every read and write, saying why, when the database couldn’t be opened', async () => {
    const why = 'The core’s database could not be opened (disk I/O error).';
    const memory = new CanvasMemory(unopened(why));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(memory.get(TEAM)).rejects.toThrow(why);
    await expect(memory.canvasWithFile('/work/team.corral')).rejects.toThrow(why);
    await memory.setFile(TEAM, at('/work/team.corral'));
    expect(logged).toHaveBeenCalledOnce();
    await expect(memory.flush()).rejects.toThrow(why);
  });
});
