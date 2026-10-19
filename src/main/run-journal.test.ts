import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import type { RunCheckpoint } from '../shared/run';
import { mintTrustedPath } from './core/host';
import type { Connection } from './core/store/sqlite';
import { unopened } from './core/store/store';
import type { Database, Store } from './core/store/store';
import { onDisk, openTestStore } from './core/store/test-store';
import { CanvasMemory } from './memory';
import { RunJournal } from './run-journal';

/*
 * Each canvas's run, journaled in the profile's database (Core Database §5): its row in `run` (the
 * run's state, and the workflow it runs, written only when it changed), where each party's `wait`
 * has read to in its messages (`read_position`), and the canvas the profile had open last
 * (`open_canvas`). A window saves with its canvas's generation token.
 */

const checkpoint: RunCheckpoint = {
  version: 2,
  workflow: '{"nodes":[]}',
  state: '{"paused":true}',
  messages: '[]',
  updatedAt: 123,
};

let profile: string;
let store: Store;
let memory: CanvasMemory;
/** A second connection, which only reads: what is on disk. */
let reader: Connection;

function journal(database: Database = store, said?: readonly string[]): RunJournal {
  return new RunJournal({
    store: database,
    memory,
    projectOf: () => '/work/project',
    ...(said === undefined ? {} : { said }),
  });
}
/** A canvas kept in file `name`, which holds `text`. */
async function named(name: string, text = '{"saved":true}'): Promise<[CanvasId, string]> {
  const canvas = newCanvasId();
  const file = path.join(profile, name);
  await writeFile(file, text);
  await memory.setFile(canvas, mintTrustedPath(file));
  return [canvas, file];
}
/** The canvas's run, as on disk. */
const ran = (canvas: CanvasId) =>
  reader.prepare('SELECT state, workflow, updated_at FROM run WHERE canvas_id = ?').get(canvas);
/** Where each party has read to in the canvas's messages, as on disk. */
const readTo = (canvas: CanvasId) =>
  reader
    .prepare('SELECT party, seq FROM read_position WHERE canvas_id = ? ORDER BY party')
    .all(canvas);
/** Closes the store and opens it again, as the core does when it starts again. */
async function reopen(): Promise<void> {
  await store.close();
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-runs-'));
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
  reader = onDisk(profile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  reader.close();
  await memory.flush();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

describe('RunJournal', () => {
  it('persists an unsaved draft under its id, across journals and restarts', async () => {
    const first = journal();
    const canvas = await first.last();
    const context = await first.get(canvas);
    expect(context).toMatchObject({ id: canvas, checkpoint: null, name: null });
    await first.save(canvas, context.token, checkpoint);
    expect(await first.get(canvas)).toMatchObject({ checkpoint, token: context.token });

    await reopen();
    const second = journal();
    expect(await second.last()).toBe(canvas);
    expect(await second.get(canvas)).toMatchObject({
      id: canvas,
      checkpoint,
      name: null,
      project: { path: '/work/project' },
    });
  });

  it('has a canvas’s run on disk once its save resolves, one row a canvas, and the canvas the profile had last', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    let seen: unknown;
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint).then(() => {
      seen = ran(canvas);
    });
    expect(seen).toEqual({
      state: '{"version":2,"state":{"paused":true},"messages":[]}',
      workflow: '{"nodes":[]}',
      updated_at: 123,
    });
    await runs.save(canvas, (await runs.get(canvas)).token, { ...checkpoint, updatedAt: 456 });
    expect(reader.prepare('SELECT count(*) AS runs FROM run').get()).toEqual({ runs: 1 });
    expect(reader.prepare('SELECT canvas_id FROM open_canvas').all()).toEqual([
      { canvas_id: canvas },
    ]);

    // Another canvas opened is the one the profile had last now, and the only one.
    const [other] = await named('other.corral');
    await runs.opened(other);
    expect(reader.prepare('SELECT canvas_id FROM open_canvas').all()).toEqual([
      { canvas_id: other },
    ]);
    expect(await journal().last()).toBe(other);
  });

  it('restores a named canvas and its saved text, keeping checkpoint edits separate', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    await reopen();
    const next = journal();
    expect(await next.last()).toBe(canvas);
    expect(await next.get(canvas)).toMatchObject({
      checkpoint,
      name: 'team.corral',
      savedText: '{"saved":true}',
    });
  });

  it('writes the workflow only when it changed, and the run’s state every time', async () => {
    const [canvas] = await named('team.corral');
    store.exec(`CREATE TABLE written (workflow TEXT NOT NULL) STRICT;
      CREATE TRIGGER workflow_made AFTER INSERT ON run
        BEGIN INSERT INTO written VALUES (NEW.workflow); END;
      CREATE TRIGGER workflow_written AFTER UPDATE OF workflow ON run
        BEGIN INSERT INTO written VALUES (NEW.workflow); END;`);
    const written = () => reader.prepare('SELECT workflow FROM written').all();
    const runs = journal();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    await runs.save(canvas, token, { ...checkpoint, state: '{"paused":false}', updatedAt: 456 });
    expect(written()).toEqual([{ workflow: '{"nodes":[]}' }]);
    expect(ran(canvas)).toMatchObject({ state: expect.stringContaining('false') as string });

    const edited = '{"nodes":[{"id":"a"}]}';
    await runs.save(canvas, token, { ...checkpoint, workflow: edited, updatedAt: 789 });
    await runs.save(canvas, token, { ...checkpoint, workflow: edited, updatedAt: 790 });
    expect(written()).toEqual([{ workflow: '{"nodes":[]}' }, { workflow: edited }]);

    // Read back after a restart, the workflow it has is known: written again only once changed.
    await reopen();
    const again = journal();
    const context = await again.get(canvas);
    await again.save(canvas, context.token, { ...checkpoint, workflow: edited, updatedAt: 800 });
    expect(written()).toHaveLength(2);
    expect(await again.get(canvas)).toMatchObject({
      checkpoint: { workflow: edited, updatedAt: 800 },
    });
  });

  it('writes the workflow again after a save of it failed, or its run was forgotten', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    const edited = { ...checkpoint, workflow: '{"nodes":[{"id":"a"}]}', updatedAt: 456 };
    store.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON run
      BEGIN SELECT RAISE(ABORT, 'The disk is full'); END`);
    await expect(runs.save(canvas, token, edited)).rejects.toThrow('The disk is full');
    store.exec('DROP TRIGGER refuse');
    await runs.save(canvas, token, { ...edited, updatedAt: 457 });
    expect(ran(canvas)).toMatchObject({ workflow: edited.workflow, updated_at: 457 });

    // Forgotten with its canvas, as canvas memory forgets the canvases used least recently: its run
    // is written whole again, and its canvas kept again.
    store.prepare('DELETE FROM canvas WHERE id = ?').run(canvas);
    await runs.save(canvas, token, { ...edited, updatedAt: 458 });
    expect(ran(canvas)).toMatchObject({ workflow: edited.workflow, updated_at: 458 });
    // Journaled as none, then again: written whole.
    await runs.save(canvas, token, null);
    expect(ran(canvas)).toBeUndefined();
    await runs.save(canvas, token, edited);
    expect(ran(canvas)).toMatchObject({ workflow: edited.workflow, updated_at: 456 });
  });

  it('keeps the canvas’s run and token through Save As', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    const before = await runs.get(canvas);
    await runs.save(canvas, before.token, checkpoint);
    const target = path.join(profile, 'team v2.corral');
    await writeFile(target, '{"copy":true}');
    // canvas:save has written the new file, and memory has it as the canvas's.
    await memory.setFile(canvas, mintTrustedPath(target));
    await runs.saved(canvas);

    expect(await runs.get(canvas)).toMatchObject({
      token: before.token,
      checkpoint,
      name: 'team v2.corral',
      savedText: '{"copy":true}',
    });
  });

  it('keeps each party’s wait read position, whoever journals the run next, never moving it back', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    const { token } = await runs.get(canvas);
    expect(await runs.reads(canvas)).toEqual({});
    let seen: unknown;
    await store
      .write(() => {
        runs.moveRead(canvas, 'outside:orchestrator', 7);
      })
      .then(() => {
        seen = readTo(canvas);
      });
    // On disk once the write that moved it resolves.
    expect(seen).toEqual([{ party: 'outside:orchestrator', seq: 7 }]);

    // The app journals the run with no read positions of its own: they are kept as they were, and
    // so they are when it journals none.
    const app = journal();
    const context = await app.get(canvas);
    await app.save(canvas, context.token, { ...checkpoint, updatedAt: 456 });
    await app.saved(canvas);
    await app.save(canvas, context.token, null);
    expect(await journal().reads(canvas)).toEqual({ 'outside:orchestrator': 7 });

    // Moved on by the next write that moves one, and never back, writes at once included.
    await Promise.all([
      runs.save(canvas, token, checkpoint),
      store.write(() => {
        runs.moveRead(canvas, 'outside:other', 2);
      }),
      store.write(() => {
        runs.moveRead(canvas, 'outside:orchestrator', 9);
      }),
      store.write(() => {
        runs.moveRead(canvas, 'outside:orchestrator', 8);
      }),
    ]);
    await reopen();
    expect(await journal().reads(canvas)).toEqual({
      'outside:orchestrator': 9,
      'outside:other': 2,
    });
  });

  it('journals a run within another write, landing with what that write keeps, or not at all', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    const { token } = await runs.get(canvas);
    let kept: () => void = () => undefined;
    await store.write(() => {
      kept = runs.keep(canvas, token, checkpoint);
      runs.moveRead(canvas, 'outside:orchestrator', 3);
    });
    kept();
    expect(ran(canvas)).toMatchObject({ updated_at: 123 });
    expect(readTo(canvas)).toEqual([{ party: 'outside:orchestrator', seq: 3 }]);

    // What it was written with failed: neither lands.
    await expect(
      store.write(() => {
        runs.keep(canvas, token, { ...checkpoint, updatedAt: 456 });
        runs.moveRead(canvas, 'outside:orchestrator', 4);
        throw new Error('The message can’t be written');
      }),
    ).rejects.toThrow('The message can’t be written');
    expect(ran(canvas)).toMatchObject({ updated_at: 123 });
    expect(readTo(canvas)).toEqual([{ party: 'outside:orchestrator', seq: 3 }]);

    // An earlier canvas's token writes nothing, failing the write it is in.
    await runs.opened(canvas);
    await expect(
      store.write(() => {
        runs.keep(canvas, token, { ...checkpoint, updatedAt: 789 });
      }),
    ).rejects.toThrow(/earlier canvas/);
    expect(ran(canvas)).toMatchObject({ updated_at: 123 });
  });

  it('refuses a save of the canvas a window showed before it opened or began another', async () => {
    const runs = journal();
    const first = await runs.last();
    const before = await runs.get(first);
    await runs.save(first, before.token, checkpoint);
    const next = await runs.draft();
    expect(next).not.toBe(first);
    // The window's canvas is the new one: the old token is an earlier canvas's.
    await expect(runs.save(next, before.token, checkpoint)).rejects.toThrow(/earlier canvas/);
    expect((await runs.get(next)).checkpoint).toBeNull();
    expect(await journal().last()).toBe(next);

    const [opened] = await named('team.corral');
    await runs.opened(opened);
    await expect(runs.save(opened, before.token, checkpoint)).rejects.toThrow(/earlier canvas/);
    // Opened again, a canvas's earlier token is stale too.
    const { token } = await runs.get(opened);
    await runs.opened(opened);
    await expect(runs.save(opened, token, checkpoint)).rejects.toThrow(/earlier canvas/);
  });

  it('says once it opens why a canvas opened as a copy', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas, 'team.corral is a copy of a canvas saved as other.corral.');
    expect((await runs.get(canvas)).warning).toBe(
      'team.corral is a copy of a canvas saved as other.corral.',
    );
  });

  it('restores a canvas whose file was removed as unsaved, keeping its id and checkpoint', async () => {
    const [canvas, file] = await named('gone.corral', '{}');
    const runs = journal();
    await runs.opened(canvas);
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    await rm(file);

    const next = journal();
    expect(await next.last()).toBe(canvas);
    const context = await next.get(canvas);
    expect(context).toMatchObject({ id: canvas, checkpoint, name: null });
    expect(context.warning).toContain('missing');
    expect((await memory.get(canvas)).file).toBeUndefined();
    // The same canvas: its token still saves.
    await next.save(canvas, context.token, checkpoint);
    // The window that had it open keeps saving it, as unsaved.
    await runs.save(canvas, token, checkpoint);
    expect((await runs.get(canvas)).name).toBeNull();
  });

  it('fails a save that couldn’t be written, keeping the run before it, and saves the next', async () => {
    const runs = journal();
    const canvas = await runs.last();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    store.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON run
      BEGIN SELECT RAISE(ABORT, 'The disk is full'); END`);
    await expect(runs.save(canvas, token, { ...checkpoint, updatedAt: 456 })).rejects.toThrow(
      'The disk is full',
    );
    await expect(runs.flush()).resolves.toBeUndefined();
    expect(await runs.get(canvas)).toMatchObject({ token, checkpoint });
    store.exec('DROP TRIGGER refuse');
    const next = { ...checkpoint, updatedAt: 789 };
    await runs.save(canvas, token, next);
    expect((await runs.get(canvas)).checkpoint).toEqual(next);
  });

  it.each([
    { reason: 'version 1', state: '{"version":1,"state":{},"messages":[]}' },
    { reason: 'its state not JSON', state: '{"version":2,"state":"invalid","messages":[]}' },
    { reason: 'no messages', state: '{"version":2,"state":{}}' },
    { reason: 'its state not an object', state: '[2]' },
    { reason: 'its workflow not JSON', workflow: 'not a workflow' },
  ])(
    'discards a run with $reason, saying so, and opens without progress',
    async ({ state, workflow }) => {
      const [canvas] = await named('team.corral');
      const runs = journal();
      await runs.opened(canvas);
      await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
      store
        .prepare('UPDATE run SET state = coalesce(?, state), workflow = coalesce(?, workflow)')
        .run(state ?? null, workflow ?? null);
      const next = journal();
      const context = await next.get(canvas);
      expect(context).toMatchObject({
        checkpoint: null,
        name: 'team.corral',
        savedText: '{"saved":true}',
      });
      expect(context.warning).toMatch(
        /^The run progress could not be restored, so it was discarded \(.+\)\.$/,
      );
      expect(ran(canvas)).toBeUndefined();
      expect((await next.get(canvas)).checkpoint).toBeNull();
      await next.save(canvas, context.token, checkpoint);
      expect((await next.get(canvas)).checkpoint).toEqual(checkpoint);
    },
  );

  it('says what the store said as it opened with the first canvas restored, once', async () => {
    const said = [
      'The core’s database was damaged (it isn’t corrallm’s), and was moved to /p/core.rejected.db.',
      'It starts empty.',
    ];
    const runs = journal(store, said);
    const canvas = await runs.last();
    expect((await runs.get(canvas)).warning).toBe(said.join(' '));
    const [other] = await named('team.corral');
    await runs.opened(other, 'team.corral is a copy of a canvas saved as other.corral.');
    expect((await runs.get(other)).warning).toBe(
      'team.corral is a copy of a canvas saved as other.corral.',
    );
  });

  it('fails every read and write, saying why, when the database couldn’t be opened', async () => {
    const why = 'The core’s database could not be opened (disk I/O error).';
    const runs = journal(unopened(why));
    const canvas = newCanvasId();
    const asked = await Promise.allSettled([
      runs.last(),
      runs.get(canvas),
      runs.reads(canvas),
      runs.draft(),
      runs.opened(canvas),
      runs.saved(canvas),
    ]);
    for (const result of asked) {
      expect(result).toMatchObject({ status: 'rejected', reason: { message: why } });
    }
  });
});
