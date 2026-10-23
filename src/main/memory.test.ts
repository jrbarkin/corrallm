import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../shared/canvas';
import { mintTrustedPath as at } from './core/host';
import { unopened } from './core/store/store';
import type { Store } from './core/store/store';
import { PROJECT_WORKSPACE as PROJECT } from './core/store/migrations';
import { onDisk, openTestStore } from './core/store/test-store';
import type { Connection } from './core/store/sqlite';
import { CanvasMemory, conversationsIn, withConversationsIn } from './memory';
import type { ConversationsByAdapter } from './memory';
import { isConversationId } from './sessions/adapters';

/*
 * What the core remembers of each canvas, in the profile's database (Core Database §5): its file,
 * its project folder and its agents' conversations by the workspace each ran in, in `canvas` and
 * `conversation`, the canvases used least recently forgotten first.
 */

const TEAM = '11111111-1111-4111-8111-111111111111' as CanvasId;
const OTHER = '22222222-2222-4222-8222-222222222222' as CanvasId;
const THIRD = '33333333-3333-4333-8333-333333333333' as CanvasId;
const SESSION = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
const THREAD = '0199a3f0-1234-7000-8000-123456789abc';
/** A workspace of the canvas's own: its key is its id. */
const WORKTREE = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';

/** Conversations whose CLIs ran in the picked project folder itself, as every one did so far. */
const inProject = (byAdapter: ConversationsByAdapter) => ({ [PROJECT]: byAdapter });

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
  it('checks unknown adapters’ saved ids against the platform minimum and reports a refused id', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.exec(`INSERT INTO canvas (id, used_at) VALUES ('${TEAM}', 1)`);
    const add = store.prepare(
      `INSERT INTO conversation (canvas_id, adapter, agent_id, workspace_key, native_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    add.run(TEAM, 'future-agent', 'valid', PROJECT, 'session:one');
    add.run(TEAM, 'future-agent', 'flag', PROJECT, '--resume');
    add.run(TEAM, 'codex', 'not-a-uuid', PROJECT, 'session:one');
    // As strictly in a workspace of its own.
    add.run(TEAM, 'codex', 'not-a-uuid', WORKTREE, 'session:one');
    expect(
      (await new CanvasMemory(store, undefined, undefined, isConversationId).get(TEAM))
        .conversations,
    ).toEqual(inProject({ 'future-agent': { valid: { id: 'session:one' } } }));
    expect(said).toHaveBeenCalledTimes(3);
    expect(said.mock.calls.flat().join(' ')).toContain('will not be resumed');
  });
  it('remembers a canvas’s file, project folder and conversations by its id, across restarts', async () => {
    const memory = new CanvasMemory(store);
    expect(await memory.get(TEAM)).toEqual({ conversations: {} });
    await memory.update(TEAM, (m) => ({ ...m, project: at('/work/app') }));
    await memory.update(TEAM, (m) => ({
      ...m,
      conversations: inProject({
        'claude-code': { a: { id: SESSION, role: 'none' } },
        codex: { a: { id: THREAD } },
      }),
    }));
    await memory.setFile(TEAM, at('/work/team.corral'));

    await reopen();
    expect(await new CanvasMemory(store).get(TEAM)).toEqual({
      file: '/work/team.corral',
      project: '/work/app',
      conversations: inProject({
        'claude-code': { a: { id: SESSION, role: 'none' } },
        codex: { a: { id: THREAD } },
      }),
    });
  });

  it('keeps an agent’s conversations in each workspace it ran in apart, across restarts', async () => {
    const memory = new CanvasMemory(store);
    await memory.update(TEAM, (m) => ({
      ...m,
      project: at('/work/app'),
      conversations: {
        [PROJECT]: { codex: { a: { id: THREAD, role: 'none' } } },
        [WORKTREE]: { codex: { a: { id: SESSION } }, 'claude-code': { b: { id: SESSION } } },
      },
    }));
    await reopen();
    const again = new CanvasMemory(store);
    const kept = await again.get(TEAM);
    expect(conversationsIn(kept, PROJECT)).toEqual({ codex: { a: { id: THREAD, role: 'none' } } });
    expect(conversationsIn(kept, WORKTREE)).toEqual({
      codex: { a: { id: SESSION } },
      'claude-code': { b: { id: SESSION } },
    });
    expect(conversationsIn(kept, 'b6f0a7d2-1111-4111-8111-111111111111')).toEqual({});
    // Forgetting the project folder's leaves the workspace's.
    await again.update(TEAM, (m) => withConversationsIn(m, PROJECT, {}));
    expect((await again.get(TEAM)).conversations).toEqual({
      [WORKTREE]: { codex: { a: { id: SESSION } }, 'claude-code': { b: { id: SESSION } } },
    });
    expect(
      reader.prepare('SELECT workspace_key, agent_id FROM conversation ORDER BY agent_id').all(),
    ).toEqual([
      { workspace_key: WORKTREE, agent_id: 'a' },
      { workspace_key: WORKTREE, agent_id: 'b' },
    ]);
  });

  it('has each change on disk once it resolves', async () => {
    const memory = new CanvasMemory(store);
    let seen: unknown;
    await memory
      .update(TEAM, () => ({
        project: at('/work/app'),
        conversations: inProject({ codex: { a: { id: THREAD, role: 'none' } } }),
      }))
      .then(() => {
        seen = {
          canvas: reader.prepare('SELECT file, project FROM canvas WHERE id = ?').get(TEAM),
          conversations: reader
            .prepare(
              `SELECT adapter, agent_id, workspace_key, native_id, role_fingerprint
               FROM conversation`,
            )
            .all(),
        };
      });
    expect(seen).toEqual({
      canvas: { file: null, project: '/work/app' },
      conversations: [
        {
          adapter: 'codex',
          agent_id: 'a',
          workspace_key: PROJECT,
          native_id: THREAD,
          role_fingerprint: 'none',
        },
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

  it.each(['within', 'after callback'] as const)(
    'rolls back a failed atomic file association (%s), even before a queued unrelated write',
    async (failure) => {
      const memory = new CanvasMemory(store);
      await memory.setFile(TEAM, at('/work/team.corral'));
      await memory.setFile(OTHER, at('/work/other.corral'));
      const changed = vi.fn();
      memory.subscribe(changed);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fault = new Error('The save’s final write failed');
      if (failure === 'after callback') {
        const write = store.write.bind(store);
        vi.spyOn(store, 'write').mockImplementationOnce((run) =>
          write(() => {
            run();
            throw fault;
          }),
        );
      }
      const saving = memory.setFile(TEAM, at('/work/other.corral'), () => {
        if (failure === 'within') throw fault;
      });
      const rejected = expect(saving).rejects.toBe(fault);
      const later = memory.update(THIRD, (m) => ({ ...m, project: at('/work/third') }));
      await rejected;
      expect(memory.fileOf(TEAM)).toBe('/work/team.corral');
      expect(memory.fileOf(OTHER)).toBe('/work/other.corral');
      expect((await memory.get(TEAM)).file).toBe('/work/team.corral');
      expect((await memory.get(OTHER)).file).toBe('/work/other.corral');
      await later;
      expect(changed.mock.calls.flat()).toEqual([THIRD]);
      expect(
        reader.prepare('SELECT id, file FROM canvas WHERE file IS NOT NULL ORDER BY id').all(),
      ).toEqual([
        { id: TEAM, file: '/work/team.corral' },
        { id: OTHER, file: '/work/other.corral' },
      ]);
      await expect(memory.flush()).resolves.toBeUndefined();
    },
  );

  it.each(['delete', 'after callback'] as const)(
    'keeps pending memory and emits no forget notification after a failed %s',
    async (failure) => {
      const memory = new CanvasMemory(store);
      await memory.setFile(TEAM, at('/work/team.corral'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      store.exec(`CREATE TRIGGER refuse_conversation BEFORE INSERT ON conversation
        BEGIN SELECT RAISE(ABORT, 'conversation write failed'); END`);
      await memory.update(TEAM, (m) => ({
        ...m,
        project: at('/work/app'),
        conversations: inProject({ codex: { a: { id: THREAD } } }),
      }));
      const before = await memory.get(TEAM);
      const changed = vi.fn();
      memory.subscribe(changed);
      if (failure === 'delete') {
        store.exec(`CREATE TRIGGER refuse_delete BEFORE DELETE ON canvas
          BEGIN SELECT RAISE(ABORT, 'forget failed'); END`);
      } else {
        const write = store.write.bind(store);
        vi.spyOn(store, 'write').mockImplementationOnce((run) =>
          write(() => {
            run();
            throw new Error('forget failed');
          }),
        );
      }
      await expect(memory.forget(TEAM)).rejects.toThrow('forget failed');
      expect(await memory.get(TEAM)).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
      store.exec('DROP TRIGGER refuse_conversation');
      if (failure === 'delete') store.exec('DROP TRIGGER refuse_delete');
      await memory.update(OTHER, (m) => ({ ...m, project: at('/work/other') }));
      await expect(memory.flush()).resolves.toBeUndefined();
      await reopen();
      expect(await new CanvasMemory(store).get(TEAM)).toEqual(before);
    },
  );

  it('forgets a conversation, and only that one, keeping the rest of the canvas', async () => {
    const memory = new CanvasMemory(store);
    await memory.update(TEAM, () => ({
      project: at('/work/app'),
      conversations: inProject({ codex: { a: { id: THREAD }, b: { id: SESSION, role: 'none' } } }),
    }));
    await memory.update(TEAM, (m) => ({
      ...m,
      conversations: inProject({ codex: { b: { id: SESSION } } }),
    }));
    expect(await memory.get(TEAM)).toEqual({
      project: '/work/app',
      conversations: inProject({ codex: { b: { id: SESSION } } }),
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
      `INSERT INTO conversation
         (canvas_id, adapter, agent_id, workspace_key, native_id, role_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const adapter of ['claude-code', 'codex', 'not an adapter']) {
      for (const [agent, id, role] of conversations) {
        add.run(TEAM, adapter, agent, PROJECT, id, role);
      }
    }
    // A workspace whose key is __proto__ is the canvas's own too.
    add.run(TEAM, 'codex', 'a', '__proto__', SESSION, null);
    const expected = Object.fromEntries([
      ['role', { id: SESSION, role: fingerprint }],
      ['absent', { id: SESSION, role: 'none' }],
      ['unknown', { id: SESSION }],
      ['text', { id: SESSION }],
      ['upper', { id: SESSION }],
      ['__proto__', { id: SESSION }],
    ]);
    const memory = new CanvasMemory(store, undefined, undefined, isConversationId);
    const team = await memory.get(TEAM);
    expect(conversationsIn(team, PROJECT)).toEqual({ 'claude-code': expected, codex: expected });
    expect(team.project).toBe('/p');
    expect(team.file).toBeUndefined();
    // An agent or a workspace whose id is __proto__ is the canvas's own, never the object's.
    expect(Object.hasOwn(conversationsIn(team, PROJECT).codex ?? {}, '__proto__')).toBe(true);
    expect(Object.hasOwn(team.conversations, '__proto__')).toBe(true);
    expect(conversationsIn(team, '__proto__')).toEqual({ codex: { a: { id: SESSION } } });
    expect(Object.keys(team.conversations).sort()).toEqual([PROJECT, '__proto__'].sort());
    expect(await memory.get(OTHER)).toEqual({ file: '/o.corral', conversations: {} });
  });

  it('applies updates made together in order, losing none', async () => {
    const memory = new CanvasMemory(store);
    await Promise.all(
      ['a', 'b', 'c'].map((agent, index) =>
        memory.update(TEAM, (m) =>
          withConversationsIn(m, PROJECT, {
            'claude-code': {
              ...conversationsIn(m, PROJECT)['claude-code'],
              [agent]: { id: `0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e1${String(index + 1)}` },
            },
          }),
        ),
      ),
    );
    const kept = conversationsIn(await new CanvasMemory(store).get(TEAM), PROJECT);
    expect(kept['claude-code']).toEqual({
      a: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' },
      b: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12' },
      c: { id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13' },
    });
  });

  it('reads what an update just changed, though it is still being written', async () => {
    const memory = new CanvasMemory(store);
    void memory.update(TEAM, () => ({
      conversations: inProject({ 'claude-code': { a: { id: SESSION } } }),
    }));
    expect(conversationsIn(await memory.get(TEAM), PROJECT)['claude-code']).toEqual({
      a: { id: SESSION },
    });
  });

  it('keeps a change whose write failed, writes it with the next, and rejects flush until then', async () => {
    const memory = new CanvasMemory(store);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.exec(`CREATE TRIGGER refuse BEFORE INSERT ON conversation WHEN NEW.canvas_id = '${TEAM}'
      BEGIN SELECT RAISE(ABORT, 'The disk is full'); END`);
    // Ordinary updates remain nonfatal; shutdown must still see their failed write.
    await memory.update(TEAM, () => ({
      conversations: inProject({ 'claude-code': { a: { id: SESSION } } }),
    }));
    expect(logged).toHaveBeenCalledOnce();
    await expect(memory.flush()).rejects.toThrow('The disk is full');
    // Still remembered, though not on disk: an agent starting now resumes it.
    expect((await memory.get(TEAM)).conversations).toEqual(
      inProject({ 'claude-code': { a: { id: SESSION } } }),
    );
    expect(await new CanvasMemory(store).get(TEAM)).toEqual({ conversations: {} });

    // Another canvas's change is written only with it.
    await memory.setFile(OTHER, at('/work/other.corral'));
    await expect(memory.flush()).rejects.toThrow('The disk is full');
    expect(await memory.canvasWithFile('/work/other.corral')).toBe(OTHER);

    store.exec('DROP TRIGGER refuse');
    await memory.update(TEAM, (current) => current);
    await expect(memory.flush()).resolves.toBeUndefined();
    await reopen();
    const again = new CanvasMemory(store);
    expect((await again.get(TEAM)).conversations).toEqual(
      inProject({ 'claude-code': { a: { id: SESSION } } }),
    );
    expect(await again.canvasWithFile('/work/other.corral')).toBe(OTHER);
  });

  it('keeps only the canvases used most recently, across restarts, with everything kept of them', async () => {
    const memory = new CanvasMemory(store, 2);
    await memory.setFile(TEAM, at('/1.corral'));
    await memory.update(OTHER, () => ({
      file: at('/2.corral'),
      conversations: inProject({ codex: { a: { id: THREAD } } }),
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

  it('never forgets a canvas open, nor one with edits not saved, however long since it was used', async () => {
    // TEAM is open (a window shows it, or the core holds it); OTHER has edits not saved.
    const memory = new CanvasMemory(store, 1, (canvas) => canvas === OTHER);
    await memory.setFile(TEAM, at('/1.corral'));
    await store.write(() => {
      store.prepare('INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, 1)').run(TEAM);
    });
    await memory.setFile(OTHER, at('/2.corral'));
    await memory.setFile(THIRD, at('/3.corral'));
    const FOURTH = '44444444-4444-4444-8444-444444444444' as CanvasId;
    await memory.setFile(FOURTH, at('/4.corral'));
    // Only one canvas is kept beyond those spared: the one used last.
    expect(await memory.get(THIRD)).toEqual({ conversations: {} });
    expect((await memory.get(FOURTH)).file).toBe('/4.corral');
    expect((await memory.get(TEAM)).file).toBe('/1.corral');
    expect((await memory.get(OTHER)).file).toBe('/2.corral');
    // Drafts too: one with edits not saved is kept, however many come after it.
    const DRAFT = '55555555-5555-4555-8555-555555555555' as CanvasId;
    const drafts = new CanvasMemory(store, 1, (canvas) => canvas === DRAFT || canvas === OTHER);
    await store.write(() => {
      drafts.ensure(DRAFT);
    });
    for (const id of ['66666666-6666-4666-8666-666666666666', THREAD] as CanvasId[]) {
      await store.write(() => {
        drafts.ensure(id);
      });
    }
    const kept = reader
      .prepare('SELECT id FROM canvas WHERE file IS NULL ORDER BY id')
      .all()
      .map(({ id }) => id);
    expect(kept).toEqual([THREAD, DRAFT]);
  });

  it('forgets a canvas when asked, with everything kept of it, at once and across restarts', async () => {
    const memory = new CanvasMemory(store);
    await memory.update(TEAM, () => ({
      file: at('/1.corral'),
      conversations: inProject({ codex: { a: { id: THREAD } } }),
    }));
    await memory.setFile(OTHER, at('/2.corral'));
    // A change not on disk yet is forgotten with it, and never written after.
    void memory.update(TEAM, (kept) => ({ ...kept, project: at('/work') }));
    let forgotten: unknown;
    await expect(
      memory.forget(TEAM).then((forgot) => {
        forgotten = reader.prepare('SELECT id FROM canvas ORDER BY id').all();
        return forgot;
      }),
    ).resolves.toBe(true);
    expect(forgotten).toEqual([{ id: OTHER }]);
    expect(await memory.get(TEAM)).toEqual({ conversations: {} });
    expect(memory.keeps(TEAM)).toBe(false);
    expect(await memory.canvasWithFile('/1.corral')).toBeUndefined();
    await memory.setFile(THIRD, at('/3.corral'));
    await reopen();
    const again = new CanvasMemory(store);
    expect(again.keeps(TEAM)).toBe(false);
    expect(reader.prepare('SELECT count(*) AS kept FROM conversation').get()).toEqual({ kept: 0 });
  });

  /** Gives `canvas` a workspace record in `state`, as the core keeps one for its agents' work. */
  async function ownWorkspace(canvas: CanvasId, id: string, state: string): Promise<void> {
    await store.write(() => {
      store
        .prepare(
          `INSERT INTO repository (id, picked_root, real_root, common_dir, identity, root_kind,
             owned_root, generation)
           VALUES ('r', '/work/app', '/work/app', '/work/app/.git', 'i', 'project', '/work/app/w', 0)
           ON CONFLICT (id) DO NOTHING`,
        )
        .run();
      store
        .prepare(
          `INSERT INTO worktree (id, canvas_id, repository_id, owner_key, path, branch_ref,
             base_checkout, base_oid, state, generation, created_at)
           VALUES (?, ?, 'r', ?, ?, ?, '/work/app', ?, ?, 0, 1)`,
        )
        .run(
          id,
          canvas,
          `agent/${id}`,
          `/work/app/w/${id}`,
          `refs/heads/w/${id}`,
          'a'.repeat(40),
          state,
        );
    });
  }

  it('never forgets a canvas that owns a workspace, in any state, however long since it was used or when asked', async () => {
    const memory = new CanvasMemory(store, 1);
    const states = ['creating', 'setup', 'ready', 'missing', 'error', 'retained', 'removing'];
    await memory.update(TEAM, () => ({
      file: at('/1.corral'),
      project: at('/work/app'),
      conversations: { [PROJECT]: { codex: { a: { id: THREAD } } }, [WORKTREE]: {} },
    }));
    for (const [i, state] of states.entries()) {
      await ownWorkspace(TEAM, `w${String(i)}`, state);
      await store.write(() => {
        if (i > 0) store.prepare('DELETE FROM worktree WHERE id = ?').run(`w${String(i - 1)}`);
      });
      // Used least recently: kept all the same.
      await memory.setFile(OTHER, at(`/other-${String(i)}.corral`));
      expect((await memory.get(TEAM)).file, state).toBe('/1.corral');
      // Asked to forget it: it is kept, with all it has.
      await expect(memory.forget(TEAM), state).resolves.toBe(false);
      expect(memory.keeps(TEAM), state).toBe(true);
      expect(await memory.get(TEAM), state).toEqual({
        file: '/1.corral',
        project: '/work/app',
        conversations: inProject({ codex: { a: { id: THREAD } } }),
      });
    }
    // A draft too, among the drafts used least recently.
    const DRAFT = '55555555-5555-4555-8555-555555555555' as CanvasId;
    await store.write(() => {
      memory.ensure(DRAFT);
    });
    await ownWorkspace(DRAFT, 'draft', 'ready');
    for (const id of ['66666666-6666-4666-8666-666666666666', THIRD] as CanvasId[]) {
      await store.write(() => {
        memory.ensure(id);
      });
    }
    expect(memory.keeps(DRAFT)).toBe(true);
    await reopen();
    // Once its last workspace record is gone, it is forgotten as any other.
    const again = new CanvasMemory(store, 1);
    await store.write(() => {
      store.prepare('DELETE FROM worktree').run();
    });
    await again.setFile(THIRD, at('/3.corral'));
    expect(again.keeps(TEAM)).toBe(false);
    await expect(again.forget(DRAFT)).resolves.toBe(true);
    expect(again.keeps(DRAFT)).toBe(false);
  });

  it('keeps a row for a canvas only its run refers to, a draft, forgetting no other canvas for it', async () => {
    const memory = new CanvasMemory(store, 2);
    await memory.setFile(TEAM, at('/1.corral'));
    await memory.setFile(OTHER, at('/2.corral'));
    // A draft's run, journaled: its canvas has a row now, and nothing else kept.
    await store.write(() => {
      memory.ensure(THIRD);
    });
    expect(reader.prepare('SELECT id FROM canvas WHERE file IS NULL').all()).toEqual([
      { id: THIRD },
    ]);
    expect(await memory.get(THIRD)).toEqual({ conversations: {} });
    expect((await memory.get(TEAM)).file).toBe('/1.corral');
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
