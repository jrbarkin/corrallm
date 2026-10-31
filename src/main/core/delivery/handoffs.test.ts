import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import type { Store } from '../store/store';
import { openTestStore, readOnDisk, refuseWrites, writeOnDisk } from '../store/test-store';
import { HandoffStore, HandoffTable } from './handoffs';
import type { Handoff } from './handoffs';

/*
 * Each agent's latest handoff (B11a C7), kept in memory and in the profile's database (`handoff`,
 * schema 7): written only within a canvas's writes, the text with the reply's, the carry with the
 * switch's commit, and cleared with the send that carries it.
 */

const CANVAS = '3f2a1b0c-9d8e-4f70-8a6b-5c4d3e2f1a0b' as CanvasId;
const HANDOFF: Handoff = {
  text: 'The task: …\nDone: the parser.\nLeft: its tests.',
  at: 1_000,
  source: { adapter: 'codex', connection: 'codex.app-server', model: 'gpt-6.1' },
  during: { owner: 'lead', item: 'parse' },
  bytes: 0,
};
HANDOFF.bytes = Buffer.byteLength(HANDOFF.text);

let profile: string;
let database: Store;
let table: HandoffTable;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-handoffs-'));
  database = await openTestStore(profile);
  const memory = new CanvasMemory(database);
  table = new HandoffTable(database, memory);
  // The canvas's row, as its first commit makes it.
  await database.write(() => {
    memory.ensure(CANVAS);
  });
});

afterEach(async () => {
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

/** The canvas's handoffs as a store loads them, after a restart. */
function loaded(): HandoffStore {
  const store = new HandoffStore(CANVAS, table);
  store.load();
  return store;
}

const rows = () =>
  readOnDisk(profile, (disk) =>
    disk.prepare('SELECT * FROM handoff WHERE canvas_id = ? ORDER BY agent_id').all(CANVAS),
  );

describe('a handoff accepted', () => {
  it('is written with the canvas’s next write, exactly, and read back as it was', async () => {
    const store = loaded();
    store.accept('worker', HANDOFF);
    expect(store.of('worker')).toEqual({ handoff: HANDOFF });
    // Nothing on disk until a write holds it.
    expect(rows()).toEqual([]);
    const written = await database.write(() => store.changes());
    written();
    expect(loaded().of('worker')).toEqual({ handoff: HANDOFF });
    expect(rows()).toEqual([
      expect.objectContaining({ agent_id: 'worker', text: HANDOFF.text, carry: null }),
    ]);
  });

  it('replaces the agent’s last one, keeping what waits to be carried', async () => {
    const store = loaded();
    await database
      .write(() => store.stageCarry('worker', 'switch-1'))
      .then((staged) => {
        staged.reveal();
      });
    store.accept('worker', HANDOFF);
    store.accept('worker', { ...HANDOFF, text: 'Newer.', bytes: 6, at: 2_000 });
    await store.durable();
    expect(loaded().of('worker')).toEqual({
      handoff: { ...HANDOFF, text: 'Newer.', bytes: 6, at: 2_000 },
      carry: 'switch-1',
    });
  });

  it('stays in memory where its write fails, and goes with the next', async () => {
    const store = loaded();
    store.accept('worker', HANDOFF);
    const release = refuseWrites(profile, 'handoff', 'The disk is full.');
    await expect(store.durable()).rejects.toThrow('The disk is full.');
    release();
    expect(store.of('worker')).toEqual({ handoff: HANDOFF });
    await store.durable();
    expect(loaded().of('worker')).toEqual({ handoff: HANDOFF });
  });
});

describe('a carry', () => {
  it('is staged within the switch’s own write, and undone with it', async () => {
    const store = loaded();
    store.accept('worker', HANDOFF);
    await store.durable();
    await expect(
      database.write(() => {
        const staged = store.stageCarry('worker', 'switch-1');
        // Seen at once, so that nothing written after it writes it out again.
        expect(store.of('worker')?.carry).toBe('switch-1');
        staged.undo();
        throw new Error('The commit failed.');
      }),
    ).rejects.toThrow('The commit failed.');
    expect(store.of('worker')).toEqual({ handoff: HANDOFF });
    expect(loaded().of('worker')).toEqual({ handoff: HANDOFF });

    await database.write(() => store.stageCarry('worker', 'switch-2'));
    expect(loaded().of('worker')).toEqual({ handoff: HANDOFF, carry: 'switch-2' });
  });

  it('is staged for an agent that wrote none yet, with why, which stays once carried', async () => {
    const store = loaded();
    await database.write(() => store.stageCarry('worker', 'switch-1', 'unreported'));
    expect(loaded().of('worker')).toEqual({ carry: 'switch-1', carryWhy: 'unreported' });
    expect(store.take('worker')).toEqual({ carry: 'switch-1', why: 'unreported' });
    await store.durable();
    expect(loaded().of('worker')).toEqual({ carryWhy: 'unreported' });
    // A later switch says why anew; with a handoff kept, there's no why.
    await database.write(() => store.stageCarry('worker', 'switch-2', 'off'));
    expect(loaded().of('worker')).toEqual({ carry: 'switch-2', carryWhy: 'off' });
    store.accept('worker', HANDOFF);
    await store.durable();
    await database.write(() => store.stageCarry('worker', 'switch-3'));
    expect(loaded().of('worker')).toEqual({ handoff: HANDOFF, carry: 'switch-3' });
  });

  it('is taken by the send that carries it, cleared with that send’s write, and put back if it failed', async () => {
    const store = loaded();
    store.accept('worker', HANDOFF);
    await database.write(() => store.stageCarry('worker', 'switch-1'));
    const taken = store.take('worker');
    expect(taken).toEqual({ carry: 'switch-1', handoff: HANDOFF });
    // Taken once.
    expect(store.take('worker')).toBeUndefined();
    // Its send's record couldn't be written: still waiting to be carried.
    store.untake('worker', 'switch-1');
    expect(store.of('worker')?.carry).toBe('switch-1');
    expect(store.take('worker')).toEqual({ carry: 'switch-1', handoff: HANDOFF });
    await store.durable();
    expect(loaded().of('worker')).toEqual({ handoff: HANDOFF });
    // Never put back over a carry set since.
    await database.write(() => store.stageCarry('worker', 'switch-2'));
    store.untake('worker', 'switch-1');
    expect(store.of('worker')?.carry).toBe('switch-2');
  });
});

describe('as the canvas opens', () => {
  it('forgets the rows of agents no longer on it', async () => {
    const store = loaded();
    store.accept('worker', HANDOFF);
    store.accept('gone', HANDOFF);
    await store.durable();
    const reopened = loaded();
    reopened.prune(new Set(['worker']));
    await reopened.durable();
    expect(rows()).toEqual([expect.objectContaining({ agent_id: 'worker' })]);
    expect(loaded().of('gone')).toBeUndefined();
  });

  it('leaves a row it can’t read as it is', async () => {
    writeOnDisk(
      profile,
      `INSERT INTO handoff (canvas_id, agent_id, text, at, source, bytes)
       VALUES ('${CANVAS}', 'newer', 'Done.', 1, '{"adapter":"--flag","connection":"x"}', 5)`,
    );
    const store = loaded();
    expect(store.of('newer')).toBeUndefined();
    store.prune(new Set(['newer']));
    await store.durable();
    expect(rows()).toEqual([expect.objectContaining({ agent_id: 'newer', text: 'Done.' })]);
  });

  it('keeps what was exported, to replace only the agent’s own copy, and how its latest export went', async () => {
    const store = loaded();
    store.accept('worker', HANDOFF);
    store.exported('worker', { state: 'done', path: 'HANDOFF.md', sha256: 'a'.repeat(64) });
    await store.durable();
    expect(loaded().of('worker')).toEqual({
      handoff: HANDOFF,
      exported: { path: 'HANDOFF.md', sha256: 'a'.repeat(64) },
      export: 'done',
    });
    // A newer handoff's export not yet made: none said; refused, its last copy still its own.
    store.accept('worker', { ...HANDOFF, text: 'Newer.', bytes: 6 });
    expect(store.of('worker')?.export).toBeUndefined();
    store.exported('worker', { state: 'refused' });
    await store.durable();
    expect(loaded().of('worker')).toEqual({
      handoff: { ...HANDOFF, text: 'Newer.', bytes: 6 },
      exported: { path: 'HANDOFF.md', sha256: 'a'.repeat(64) },
      export: 'refused',
    });
    // One never written: failed, with no copy of its own.
    store.accept('other', HANDOFF);
    store.exported('other', { state: 'failed' });
    await store.durable();
    expect(loaded().of('other')).toEqual({ handoff: HANDOFF, export: 'failed' });
  });
});
