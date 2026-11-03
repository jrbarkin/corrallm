import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOOP_TURNS } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import type { Store } from '../store/store';
import { openTestStore, readOnDisk, refuseWrites, writeOnDisk } from '../store/test-store';
import { LoopStore, LoopTable, orderedPair } from './loops';

/*
 * The loop breaker's counts (B21 C6, Design §9.2 C9): the turns delivered between two agents since
 * the user last gave either input, kept in memory and in the profile's database (`loop_pair`,
 * schema 11), written only within a canvas's writes or a write of their own.
 */

const CANVAS = '3f2a1b0c-9d8e-4f70-8a6b-5c4d3e2f1a0b' as CanvasId;

let profile: string;
let database: Store;
let table: LoopTable;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-loops-'));
  database = await openTestStore(profile);
  const memory = new CanvasMemory(database);
  table = new LoopTable(database, memory);
  await database.write(() => {
    memory.ensure(CANVAS);
  });
});

afterEach(async () => {
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

/** The canvas's counts as a store loads them, after a restart. */
function loaded(): LoopStore {
  const store = new LoopStore(CANVAS, table);
  store.load();
  return store;
}

const rows = () =>
  readOnDisk(profile, (disk) =>
    disk.prepare('SELECT a, b, turns FROM loop_pair WHERE canvas_id = ? ORDER BY a, b').all(CANVAS),
  );

describe('a pair of agents', () => {
  it('is unordered: both directions count together, ordered by their ids’ UTF-8 bytes', () => {
    expect(orderedPair('builder', 'planner')).toEqual(['builder', 'planner']);
    expect(orderedPair('planner', 'builder')).toEqual(['builder', 'planner']);
    // An astral character sorts before U+FFFF by its UTF-16 units, after it by its UTF-8 bytes, as
    // SQLite's BINARY collation does.
    expect(orderedPair('\u{1F600}', '￿')).toEqual(['￿', '\u{1F600}']);
    const store = loaded();
    store.count('planner', 'builder');
    store.count('builder', 'planner');
    expect(store.turns('planner', 'builder')).toBe(2);
    expect(store.turns('builder', 'planner')).toBe(2);
  });

  it('counts apart from every other pair, and is held from LOOP_TURNS on', () => {
    const store = loaded();
    for (let i = 0; i < LOOP_TURNS - 1; i++) store.count('a', 'b');
    store.count('a', 'c');
    expect(store.held('a', 'b')).toBe(false);
    store.count('b', 'a');
    expect(store.turns('a', 'b')).toBe(LOOP_TURNS);
    expect(store.held('a', 'b')).toBe(true);
    expect(store.held('a', 'c')).toBe(false);
    expect(store.turns('b', 'c')).toBe(0);
  });

  it('is counted back when a delivery was never sent, to none at zero', () => {
    const store = loaded();
    store.count('a', 'b');
    store.count('a', 'b');
    store.uncount('a', 'b');
    expect(store.turns('a', 'b')).toBe(1);
    store.uncount('a', 'b');
    store.uncount('a', 'b');
    expect(store.turns('a', 'b')).toBe(0);
    expect(store.pairs()).toEqual([]);
  });
});

describe('the counts kept', () => {
  it('are written with the canvas’s next write and read back after a restart, as counts only', async () => {
    const store = loaded();
    store.count('a', 'b');
    store.count('b', 'a');
    store.count('a', 'c');
    // Nothing on disk until a write holds them.
    expect(rows()).toEqual([]);
    const written = await database.write(() => store.changes());
    written();
    expect(rows()).toEqual([
      { a: 'a', b: 'b', turns: 2 },
      { a: 'a', b: 'c', turns: 1 },
    ]);
    const again = loaded();
    expect(again.turns('b', 'a')).toBe(2);
    expect(again.turns('c', 'a')).toBe(1);
    expect(again.pending()).toBe(false);
  });

  it('are cleared for every pair holding an agent, and for no other', async () => {
    const store = loaded();
    for (const [x, y] of [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ] as const)
      store.count(x, y);
    await store.durable();
    expect(store.resetAgent('a')).toBe(true);
    expect(store.resetAgent('a')).toBe(false);
    await store.durable();
    expect(rows()).toEqual([{ a: 'b', b: 'c', turns: 1 }]);
    expect(loaded().turns('a', 'b')).toBe(0);
  });

  it('are cleared for one pair alone', async () => {
    const store = loaded();
    store.count('a', 'b');
    store.count('a', 'c');
    await store.durable();
    expect(store.resetPair('b', 'a')).toBe(true);
    await store.durable();
    expect(rows()).toEqual([{ a: 'a', b: 'c', turns: 1 }]);
  });

  it('go with an agent that left the canvas, whichever side it was', async () => {
    const store = loaded();
    for (const [x, y] of [
      ['a', 'b'],
      ['c', 'a'],
      ['b', 'c'],
    ] as const)
      store.count(x, y);
    await store.durable();
    store.prune(new Set(['b', 'c']));
    await store.durable();
    expect(rows()).toEqual([{ a: 'b', b: 'c', turns: 1 }]);
  });

  it('stay in memory where their write fails, and go with the next', async () => {
    const store = loaded();
    store.count('a', 'b');
    const release = refuseWrites(profile, 'loop_pair', 'The disk is full.');
    await expect(store.durable()).rejects.toThrow('The disk is full.');
    release();
    expect(store.turns('a', 'b')).toBe(1);
    expect(store.pending()).toBe(true);
    await store.durable();
    expect(loaded().turns('a', 'b')).toBe(1);
  });

  it('are read as held where their row holds nothing this code reads, and left as it is', () => {
    writeOnDisk(
      profile,
      `INSERT INTO loop_pair (canvas_id, a, b, turns) VALUES ('${CANVAS}', 'a', 'b', 1152921504606846976)`,
    );
    const store = loaded();
    expect(store.held('a', 'b')).toBe(true);
    expect(store.pending()).toBe(false);
  });
});
