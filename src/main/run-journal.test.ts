import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { decodeSubmissions } from '../shared/engine/delivery/submission-state';
import type { MessageStore } from './core/delivery/messages';
import { MAX_RUN_BYTES } from '../shared/run';
import type { RunCheckpoint } from '../shared/run';
import { mintTrustedPath } from './core/host';
import type { Connection } from './core/store/sqlite';
import { SYSTEM_DEPS, unopened } from './core/store/store';
import type { Database, Store, StoreDeps } from './core/store/store';
import { messagesIn, onDisk, openTestStore } from './core/store/test-store';
import { CanvasMemory } from './memory';
import { RunJournal } from './run-journal';

/*
 * Each canvas's run, journaled in the profile's database (Core Database §5): its row in `run` (the
 * run's state), where each party's `wait` has read to in its messages (`read_position`), and the
 * canvas the profile had open last (`open_canvas`). A window saves with its canvas's generation
 * token; its manual submissions are your messages in the canvas's messages.
 */

/** A checkpoint's submissions when it has none. */
const NONE = '{"version":1,"agents":[]}';
const checkpoint: RunCheckpoint = {
  version: 2,
  state: '{"paused":true}',
  messages: NONE,
  updatedAt: 123,
};

let profile: string;
let store: Store;
let memory: CanvasMemory;
/** A second connection, which only reads: what is on disk. */
let reader: Connection;

/** The canvases' messages the journals of a test keep submissions in: one store each. */
let messagesOf: (canvas: CanvasId) => Promise<MessageStore>;

function journal(database: Database = store, said?: readonly string[]): RunJournal {
  return new RunJournal({
    store: database,
    memory,
    messages: database === store ? messagesOf : messagesIn(database, memory),
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
  reader.prepare('SELECT state, updated_at FROM run WHERE canvas_id = ?').get(canvas);
/** The canvases open, as on disk: the one opened (or journaled) last first. */
const open = () =>
  reader
    .prepare('SELECT canvas_id FROM open_canvas ORDER BY opened_at DESC')
    .all()
    .map(({ canvas_id: id }) => id);
/** Where each party has read to in the canvas's messages, as on disk. */
const readTo = (canvas: CanvasId) =>
  reader
    .prepare('SELECT party, seq FROM read_position WHERE canvas_id = ? ORDER BY party')
    .all(canvas);
/** Closes the store and opens it again, as the core does when it starts again. */
async function reopen(deps?: StoreDeps): Promise<void> {
  await store.close();
  store = await openTestStore(profile, deps);
  memory = new CanvasMemory(store);
  messagesOf = messagesIn(store, memory);
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-runs-'));
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
  messagesOf = messagesIn(store, memory);
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
  it.each([
    ['state', 'depth'],
    ['state', 'nodes'],
    ['messages', 'depth'],
    ['messages', 'nodes'],
  ] as const)(
    'commits messages and a save error with the last good run when %s exceeds JSON %s',
    async (field, limit) => {
      const runs = journal();
      const canvas = await runs.last();
      const { token } = await runs.get(canvas);
      await runs.save(canvas, token, checkpoint);
      let deep: unknown = {};
      for (let i = 0; i < 66; i++) deep = [deep];
      const complex = {
        ...checkpoint,
        [field]: JSON.stringify(limit === 'depth' ? deep : Array<number>(200_001).fill(0)),
      };
      expect(Buffer.byteLength(JSON.stringify(complex))).toBeLessThan(MAX_RUN_BYTES);
      const messages = await messagesOf(canvas);
      messages.writeWith(() => {
        const problem = runs.keep(canvas, token, complex, messages);
        return () => {
          runs.kept(canvas, problem);
        };
      });
      const sent = messages.add({
        from: 'outside:orchestrator',
        to: 'agent:worker',
        kind: 'text',
        origin: 'party',
        body: 'Still record this',
        state: 'pending',
      });
      try {
        await expect(messages.durable()).resolves.toBeUndefined();
        expect(reader.prepare('SELECT body FROM message WHERE id = ?').get(sent.id)).toEqual({
          body: 'Still record this',
        });
        const saved = await runs.get(canvas);
        expect(saved.checkpoint).toEqual(checkpoint);
        expect(saved.saveError).toMatch(/complex/);
      } finally {
        messages.writeWith(undefined);
        await messages.durable();
      }
      await reopen();
      const next = journal();
      const restored = await next.get(canvas);
      expect(restored.checkpoint).toEqual(checkpoint);
      expect(restored.saveError).toMatch(/complex/);
      await next.save(canvas, (await next.get(canvas)).token, checkpoint);
      expect(next.problem(canvas)).toBeUndefined();
    },
  );

  it('keeps the last good run and a durable explanation when the next run is oversized', async () => {
    const runs = journal();
    const canvas = await runs.last();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    const large = { ...checkpoint, state: JSON.stringify({ text: 'x'.repeat(MAX_RUN_BYTES) }) };
    await expect(runs.save(canvas, token, large)).rejects.toThrow(/too large/);
    expect(await runs.get(canvas)).toMatchObject({ checkpoint });
    expect((await runs.get(canvas)).saveError).toMatch(/too large/);
    await reopen();
    const next = journal();
    expect(await next.get(canvas)).toMatchObject({ checkpoint });
    expect((await next.get(canvas)).saveError).toMatch(/too large/);
    await next.save(canvas, (await next.get(canvas)).token, checkpoint);
    expect((await next.get(canvas)).saveError).toBeUndefined();
  });

  it('records an oversized first run without inventing a checkpoint', async () => {
    const runs = journal();
    const canvas = await runs.last();
    const { token } = await runs.get(canvas);
    await expect(
      runs.save(canvas, token, {
        ...checkpoint,
        state: JSON.stringify({ text: 'x'.repeat(MAX_RUN_BYTES) }),
      }),
    ).rejects.toThrow(/too large/);
    expect((await runs.get(canvas)).checkpoint).toBeNull();
    expect((await runs.get(canvas)).saveError).toMatch(/too large/);
  });
  it('persists an unsaved draft under its id, across journals and restarts', async () => {
    const first = journal();
    const canvas = await first.last();
    const context = await first.get(canvas);
    expect(context).toMatchObject({ id: canvas, checkpoint: null });
    expect(context.savedText).toBeUndefined();
    await first.save(canvas, context.token, checkpoint);
    expect(await first.get(canvas)).toMatchObject({ checkpoint, token: context.token });

    await reopen();
    const second = journal();
    expect(await second.last()).toBe(canvas);
    expect(await second.get(canvas)).toMatchObject({ id: canvas, checkpoint });
  });

  it('has a canvas’s run on disk once its save resolves, one row a canvas, and the canvas the profile had last', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    let seen: unknown;
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint).then(() => {
      seen = ran(canvas);
    });
    // In its own envelope (B11 Design §4), with no submissions beside it.
    expect(seen).toEqual({ state: '{"format":3,"run":{"paused":true}}', updated_at: 123 });
    await runs.save(canvas, (await runs.get(canvas)).token, { ...checkpoint, updatedAt: 456 });
    expect(reader.prepare('SELECT count(*) AS runs FROM run').get()).toEqual({ runs: 1 });
    expect(reader.prepare('SELECT canvas_id FROM open_canvas').all()).toEqual([
      { canvas_id: canvas },
    ]);

    // Another canvas opened is the one the profile had last now; the first stays open beside it.
    const [other] = await named('other.corral');
    await runs.opened(other);
    expect(open()).toEqual([other, canvas]);
    expect(await journal().last()).toBe(other);
  });

  it('keeps each canvas open until it is closed, across restarts, the one opened last restored', async () => {
    const [team] = await named('team.corral');
    const [other] = await named('other.corral');
    const runs = journal();
    await runs.opened(team);
    await runs.opened(other);
    const draft = newCanvasId();
    await runs.opened(draft);
    await reopen();
    expect(open()).toEqual([draft, other, team]);
    expect(await journal().last()).toBe(draft);

    // Closed, it is no longer open, nor restored; what else is open stays.
    let closed: unknown;
    await journal()
      .close(draft)
      .then(() => {
        closed = open();
      });
    expect(closed).toEqual([other, team]);
    expect(await journal().last()).toBe(other);
    // Journaling a run of a canvas open keeps it open, the one used last restored first.
    const runsAgain = journal();
    await runsAgain.save(team, (await runsAgain.get(team)).token, checkpoint);
    expect(open()).toEqual([team, other]);
    // A save marks no canvas open that was closed: it only says which open one was used last.
    await runsAgain.close(other);
    await runsAgain.saved(other);
    expect(open()).toEqual([team]);
    // None open: a new draft, open from then on.
    await runsAgain.close(team);
    const fresh = await journal().last();
    expect([team, other, draft]).not.toContain(fresh);
    expect(open()).toEqual([fresh]);
  });

  it('restores a named canvas and its saved text, keeping checkpoint edits separate', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    await reopen();
    const next = journal();
    expect(await next.last()).toBe(canvas);
    expect(await next.get(canvas)).toMatchObject({ checkpoint, savedText: '{"saved":true}' });
  });

  it('writes the run a save has, whatever an earlier save’s flush did', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failing = false;
    await reopen({
      ...SYSTEM_DEPS,
      flush: (fd) => (failing ? Promise.reject(new Error('EIO')) : SYSTEM_DEPS.flush(fd)),
    });
    const [canvas] = await named('team.corral');
    const runs = journal();
    const { token } = await runs.get(canvas);
    const edited = { ...checkpoint, state: '{"edit":"two"}', updatedAt: 456 };
    await runs.save(canvas, token, checkpoint);
    // Committed, but its log couldn't be flushed: kept nowhere, the database refusing every write
    // until it is opened again.
    failing = true;
    await expect(runs.save(canvas, token, edited)).rejects.toThrow('EIO');
    failing = false;
    await expect(runs.save(canvas, token, checkpoint)).rejects.toThrow('EIO');
    reader.close();
    await reopen();
    reader = onDisk(profile);
    expect(ran(canvas)).toMatchObject({
      state: expect.stringContaining('paused') as string,
      updated_at: 123,
    });
    // Saved again, the edit is written as it is.
    const again = journal();
    await again.save(canvas, (await again.get(canvas)).token, edited);
    expect(ran(canvas)).toMatchObject({
      state: expect.stringContaining('two') as string,
      updated_at: 456,
    });
  });

  it('writes the run the last of saves made together has', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    await Promise.all([
      runs.save(canvas, token, { ...checkpoint, state: '{"edit":"two"}', updatedAt: 456 }),
      runs.save(canvas, token, { ...checkpoint, updatedAt: 789 }),
    ]);
    expect(ran(canvas)).toMatchObject({
      state: expect.stringContaining('paused') as string,
      updated_at: 789,
    });
  });

  it('writes the run again after a save of it failed, or its run was forgotten', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    const { token } = await runs.get(canvas);
    await runs.save(canvas, token, checkpoint);
    const edited = { ...checkpoint, state: '{"edit":"two"}', updatedAt: 456 };
    store.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON run
      BEGIN SELECT RAISE(ABORT, 'The disk is full'); END`);
    await expect(runs.save(canvas, token, edited)).rejects.toThrow('The disk is full');
    store.exec('DROP TRIGGER refuse');
    await runs.save(canvas, token, { ...edited, updatedAt: 457 });
    expect(ran(canvas)).toMatchObject({
      state: expect.stringContaining('two') as string,
      updated_at: 457,
    });

    // Forgotten with its canvas, as canvas memory forgets the canvases used least recently: its run
    // is written whole again, and its canvas kept again.
    store.prepare('DELETE FROM canvas WHERE id = ?').run(canvas);
    await runs.save(canvas, token, { ...edited, updatedAt: 458 });
    expect(ran(canvas)).toMatchObject({
      state: expect.stringContaining('two') as string,
      updated_at: 458,
    });
    // Journaled as none, then again: written whole.
    await runs.save(canvas, token, null);
    expect(ran(canvas)).toBeUndefined();
    await runs.save(canvas, token, edited);
    expect(ran(canvas)).toMatchObject({
      state: expect.stringContaining('two') as string,
      updated_at: 456,
    });
  });

  it('forgets drafts before a canvas kept with its file, folder or conversations', async () => {
    memory = new CanvasMemory(store, 3);
    const [saved, file] = await named('team.corral');
    await memory.update(saved, (kept) => ({ ...kept, project: mintTrustedPath('/work/app') }));
    const runs = journal();
    // New, pressed more often than memory keeps canvases: each a draft whose window journals its
    // run, as the app's does, closing the one before it.
    const drafts: CanvasId[] = [];
    for (let i = 0; i < 5; i++) {
      const draft = newCanvasId();
      await runs.opened(draft);
      const before = drafts.at(-1);
      if (before !== undefined) await runs.close(before);
      await runs.save(draft, (await runs.get(draft)).token, { ...checkpoint, updatedAt: i });
      drafts.push(draft);
    }
    expect(await memory.get(saved)).toEqual({
      file,
      project: '/work/app',
      conversations: {},
    });
    expect(await journal().last()).toBe(drafts.at(-1));
    // The oldest drafts are forgotten, with their runs: the drafts kept besides the one open are as
    // many as the canvases kept with a file, folder or conversations may be.
    expect(drafts.map((draft) => ran(draft)?.updated_at)).toEqual([undefined, 1, 2, 3, 4]);
  });

  it('keeps the canvas’s run and token through Save As', async () => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    const before = await runs.get(canvas);
    await runs.save(canvas, before.token, checkpoint);
    const target = path.join(profile, 'team v2.corral');
    await writeFile(target, '{"copy":true}');
    // canvas.saveAs has written the new file, and memory has it as the canvas's.
    await memory.setFile(canvas, mintTrustedPath(target));
    await runs.saved(canvas);

    expect(await runs.get(canvas)).toMatchObject({
      token: before.token,
      checkpoint,
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
    const messages = await messagesOf(canvas);
    await store.write(() => {
      runs.keep(canvas, token, checkpoint, messages);
      runs.moveRead(canvas, 'outside:orchestrator', 3);
    });
    expect(ran(canvas)).toMatchObject({ updated_at: 123 });
    expect(readTo(canvas)).toEqual([{ party: 'outside:orchestrator', seq: 3 }]);

    // What it was written with failed: neither lands.
    await expect(
      store.write(() => {
        runs.keep(canvas, token, { ...checkpoint, updatedAt: 456 }, messages);
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
        runs.keep(canvas, token, { ...checkpoint, updatedAt: 789 }, messages);
      }),
    ).rejects.toThrow(/earlier canvas/);
    expect(ran(canvas)).toMatchObject({ updated_at: 123 });
  });

  it('refuses a save of the canvas a window showed before it opened or began another', async () => {
    const runs = journal();
    const first = await runs.last();
    const before = await runs.get(first);
    await runs.save(first, before.token, checkpoint);
    const next = newCanvasId();
    await runs.opened(next);
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
    expect(context).toMatchObject({ id: canvas, checkpoint });
    expect(context.savedText).toBeUndefined();
    expect(context.warning).toContain('missing');
    expect((await memory.get(canvas)).file).toBeUndefined();
    // The same canvas: its token still saves.
    await next.save(canvas, context.token, checkpoint);
    // The window that had it open keeps saving it, as unsaved.
    await runs.save(canvas, token, checkpoint);
    expect((await runs.get(canvas)).savedText).toBeUndefined();
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
    {
      reason: 'the envelope of schema 3, which migration 4 couldn’t convert',
      state: `{"version":2,"state":{},"messages":${NONE}}`,
    },
    { reason: 'another envelope', state: '{"format":4,"run":{}}' },
    { reason: 'its run not JSON', state: '{"format":3,"run":"invalid"}' },
    { reason: 'its run not an object', state: '{"format":3,"run":2}' },
    { reason: 'no envelope', state: '[2]' },
  ])('discards a run with $reason, saying so, and opens without progress', async ({ state }) => {
    const [canvas] = await named('team.corral');
    const runs = journal();
    await runs.opened(canvas);
    await runs.save(canvas, (await runs.get(canvas)).token, checkpoint);
    store.prepare('UPDATE run SET state = ?').run(state);
    const next = journal();
    const context = await next.get(canvas);
    expect(context).toMatchObject({ checkpoint: null, savedText: '{"saved":true}' });
    expect(context.warning).toMatch(
      /^The run progress could not be restored, so it was discarded \(.+\)\.$/,
    );
    expect(ran(canvas)).toBeUndefined();
    expect((await next.get(canvas)).checkpoint).toBeNull();
    await next.save(canvas, context.token, checkpoint);
    expect((await next.get(canvas)).checkpoint).toEqual(checkpoint);
  });

  describe('a checkpoint’s submissions', () => {
    /** Submissions, as an engine encodes its sessions' (encodeSubmissions). */
    const records = (agents: Record<string, unknown[]>) =>
      JSON.stringify({
        version: 1,
        agents: Object.entries(agents).map(([id, submissions]) => ({ id, submissions })),
      });
    const done = { status: 'completed', reason: 'completed' } as const;

    it('are your messages, never kept beside the run, given back as it restores, across a restart', async () => {
      const [canvas] = await named('team.corral');
      const runs = journal();
      await runs.opened(canvas);
      const saved = {
        ...checkpoint,
        messages: records({
          lead: [
            {
              id: 'native-1',
              text: 'Fix it',
              status: 'completed',
              after: 'plan',
              task: { agent: 'lead', item: 'plan' },
              result: done,
            },
            { id: 'native-2', text: 'Going on', status: 'running', after: 'plan' },
          ],
          helper: [{ id: 'native-3', text: '/compact', status: 'completed', result: done }],
        }),
      };
      await runs.save(canvas, (await runs.get(canvas)).token, saved);

      expect(ran(canvas)).toEqual({ state: '{"format":3,"run":{"paused":true}}', updated_at: 123 });
      const rows = reader
        .prepare(
          `SELECT from_party, to_party, kind, origin, body, display, state, turn,
             json_extract(delivery, '$.as') AS alias
           FROM message WHERE canvas_id = ? ORDER BY seq`,
        )
        .all(canvas);
      const unresolved = JSON.stringify({
        status: 'cancelled',
        reason: 'interrupted',
        message: 'Unresolved after restart; resume the queue to continue.',
      });
      expect(rows).toEqual([
        {
          from_party: 'you',
          to_party: 'agent:lead',
          kind: 'text',
          origin: 'manual',
          body: 'Fix it',
          display: '{"after":"plan","task":{"agent":"lead","item":"plan"}}',
          state: 'replied',
          turn: JSON.stringify(done),
          alias: 'native-1',
        },
        // What goes on is kept as a restart would leave it, never active to delivery.
        {
          from_party: 'you',
          to_party: 'agent:lead',
          kind: 'text',
          origin: 'manual',
          body: 'Going on',
          display: '{"after":"plan"}',
          state: 'unresolved',
          turn: unresolved,
          alias: 'native-2',
        },
        {
          from_party: 'you',
          to_party: 'agent:helper',
          kind: 'text',
          origin: 'manual',
          body: '/compact',
          display: null,
          state: 'replied',
          turn: JSON.stringify(done),
          alias: 'native-3',
        },
      ]);
      // Restored as the engine restored them from its checkpoint.
      const restored = (await runs.get(canvas)).checkpoint;
      expect(restored?.state).toBe(checkpoint.state);
      expect(decodeSubmissions(restored?.messages ?? NONE)).toEqual(
        decodeSubmissions(saved.messages),
      );
      await reopen();
      const again = (await journal().get(canvas)).checkpoint;
      expect(decodeSubmissions(again?.messages ?? NONE)).toEqual(decodeSubmissions(saved.messages));
    });

    it('change their message as they do; one a message represents already keeps that one’s record', async () => {
      const [canvas] = await named('team.corral');
      const runs = journal();
      const { token } = await runs.get(canvas);
      const messages = await messagesOf(canvas);
      // Your message, which the core delivered under the native id the session sent it as.
      const delivered = messages.add({
        from: 'you',
        to: 'agent:lead',
        kind: 'text',
        origin: 'manual',
        body: 'Yours',
        state: 'delivered',
        delivery: { at: 1, as: 'native-1', attempt: 1 },
      });
      await messages.durable();
      const running = records({
        lead: [
          { id: 'native-1', text: 'Yours', status: 'running', after: 'plan' },
          { id: 'native-2', text: 'Mine', status: 'running' },
        ],
      });
      await runs.save(canvas, token, { ...checkpoint, messages: running });
      const ended = records({
        lead: [
          { id: 'native-1', text: 'Yours', status: 'completed', after: 'plan', result: done },
          { id: 'native-2', text: 'Mine', status: 'completed', result: done },
          { id: 'native-3', text: 'Again', status: 'completed', retryOf: 'native-2', result: done },
        ],
      });
      await runs.save(canvas, token, { ...checkpoint, messages: ended });
      const kept = messages.all();
      expect(kept).toHaveLength(3);
      // The core's record of its own delivery stands; it gains where it showed.
      expect(messages.get(delivered.id)).toMatchObject({ state: 'delivered' });
      expect(messages.displayOf(delivered.id)).toEqual({ after: 'plan' });
      const [, mine, again] = kept;
      expect(mine).toMatchObject({ body: 'Mine', state: 'replied', turn: done });
      expect(messages.originOf(mine?.id ?? '')).toBe('manual');
      expect(again).toMatchObject({ body: 'Again', state: 'replied', resendOf: mine?.id });
      expect(messages.originOf(again?.id ?? '')).toBe('resend');
      expect(again?.replyTo).toBeUndefined();
      // Saved again, nothing more is made.
      await runs.save(canvas, token, { ...checkpoint, messages: ended, updatedAt: 456 });
      expect(messages.all()).toHaveLength(3);
    });

    it('leave out a record no engine restores, never failing the write; refuse what isn’t records', async () => {
      const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const [canvas] = await named('team.corral');
      const runs = journal();
      const { token } = await runs.get(canvas);
      await runs.save(canvas, token, checkpoint);
      // A prompt pasted into a Terminal longer than any engine keeps, and a status none kept.
      const kept = records({
        lead: [
          { id: 'native-1', text: 'x'.repeat(200_001), status: 'completed', result: done },
          { id: 'native-2', text: 'Kept', status: 'completed', result: done },
          { id: 'native-3', text: 'Lost', status: 'lost' },
        ],
      });
      await runs.save(canvas, token, { ...checkpoint, messages: kept, updatedAt: 234 });
      expect(ran(canvas)).toMatchObject({ updated_at: 234 });
      expect((await messagesOf(canvas)).all().map(({ body }) => body)).toEqual(['Kept']);
      expect(said).toHaveBeenCalledWith(
        '2 submission record(s) no engine restores were left out of the run’s messages.',
      );
      await expect(
        runs.save(canvas, token, { ...checkpoint, messages: '[]', updatedAt: 456 }),
      ).rejects.toThrow('Invalid submission records');
      expect(ran(canvas)).toMatchObject({ updated_at: 234 });
    });
  });

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
      runs.opened(canvas),
      runs.saved(canvas),
    ]);
    for (const result of asked) {
      expect(result).toMatchObject({ status: 'rejected', reason: { message: why } });
    }
  });
});
