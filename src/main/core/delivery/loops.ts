import { LOOP_TURNS } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasMemory } from '../../memory';
import type { Database } from '../store/store';

/*
 * The loop breaker's counts (B21 Design §9.2 C9): for each pair of agents of a canvas, how many
 * turns were delivered between them (either direction together) since the user last gave either
 * one input. A row of `loop_pair` (schema 11) per pair while its count is above zero, in memory and
 * in the profile's database, counts only: no text and no message id. The delivery that journals a
 * turn as `delivering` counts it in that same write (the canvas's messages write these alongside
 * their own), so a count and the turn it counts are on disk together or not at all; a reset is
 * written with the write that records the input (or on its own). A pair at LOOP_TURNS is held:
 * the next turn between them waits for the user (delivery.ts). A row of an agent that left the
 * canvas goes. A row this code can't read is kept, and read as held: never as zero.
 */

/** A pair of agents, ordered, as a row keeps it. */
export type Pair = readonly [string, string];

/**
 * The two agents ordered by their ids' UTF-8 bytes (as SQLite's BINARY collation orders text):
 * the same pair whichever direction a turn went.
 */
export function orderedPair(x: string, y: string): Pair {
  return Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')) <= 0 ? [x, y] : [y, x];
}

/** A pair's key in memory. */
const keyOf = ([a, b]: Pair): string => JSON.stringify([a, b]);

/** The profile's loop counts, every canvas's, in the database's `loop_pair` table. */
export class LoopTable {
  readonly #store: Database;
  readonly #memory: Pick<CanvasMemory, 'ensure'>;

  constructor(store: Database, memory: Pick<CanvasMemory, 'ensure'>) {
    this.#store = store;
    this.#memory = memory;
  }

  /** The rows of a canvas's counts. Throws if they can't be read. */
  rows(canvas: CanvasId): Record<string, unknown>[] {
    // A count past LOOP_TURNS (never one this code writes) is read as LOOP_TURNS: held, and a value
    // too large to read at all is no reason to read none.
    return this.#store
      .prepare(
        `SELECT a, b, min(turns, ${String(LOOP_TURNS)}) AS turns FROM loop_pair WHERE canvas_id = ?`,
      )
      .all(canvas);
  }

  /** Queues `write` for the database's next commit: resolves once that commit has returned. */
  write<T>(write: () => T): Promise<T> {
    return this.#store.write(write);
  }

  /** Within a write: a pair's row, as kept. */
  keep(canvas: CanvasId, [a, b]: Pair, turns: number): void {
    this.#memory.ensure(canvas);
    this.#store.run(
      `INSERT INTO loop_pair (canvas_id, a, b, turns) VALUES (?, ?, ?, ?)
         ON CONFLICT (canvas_id, a, b) DO UPDATE SET turns = excluded.turns`,
      canvas,
      a,
      b,
      turns,
    );
  }

  /** Within a write: deletes a pair's row. */
  forget(canvas: CanvasId, [a, b]: Pair): void {
    this.#store.run('DELETE FROM loop_pair WHERE canvas_id = ? AND a = ? AND b = ?', canvas, a, b);
  }
}

/** A canvas's counts, by pair. */
export class LoopStore {
  readonly canvas: CanvasId;
  readonly #table: LoopTable;
  /**
   * The pairs with a count above zero, each with the run of turns it counts: a new one begins each
   * time the pair counts from zero (after the user spoke to either, or as it is read).
   */
  readonly #kept = new Map<string, { pair: Pair; turns: number; run: number }>();
  #runs = 0;
  /** The pairs whose rows aren't on disk as they are, each with the number of its last change. */
  readonly #changed = new Map<string, { pair: Pair; change: number }>();
  #changes = 0;
  /** Why the canvas's counts couldn't be read as it loaded, if they couldn't. */
  warning: string | undefined;

  constructor(canvas: CanvasId, table: LoopTable) {
    this.canvas = canvas;
    this.#table = table;
  }

  /** Reads what the database keeps of the canvas's counts. Never throws. */
  load(): void {
    let rows: Record<string, unknown>[];
    try {
      rows = this.#table.rows(this.canvas);
    } catch (error) {
      this.warning = `The canvas’s loop counts could not be read (${error instanceof Error ? error.message : String(error)}).`;
      return;
    }
    for (const { a, b, turns } of rows) {
      if (typeof a !== 'string' || typeof b !== 'string' || a === b) continue;
      const pair = orderedPair(a, b);
      // A count this code can't read is as high as one can be: held, never zero.
      const read =
        typeof turns === 'number' && Number.isSafeInteger(turns) && turns >= 1 ? turns : LOOP_TURNS;
      this.#kept.set(keyOf(pair), { pair, turns: read, run: ++this.#runs });
    }
  }

  /** The turns delivered between two agents since the user last gave either input. */
  turns(x: string, y: string): number {
    return this.#kept.get(keyOf(orderedPair(x, y)))?.turns ?? 0;
  }

  /** Whether the next turn between two agents waits for the user. */
  held(x: string, y: string): boolean {
    return this.turns(x, y) >= LOOP_TURNS;
  }

  /** Whether any pair's next turn waits for the user. */
  holding(): boolean {
    for (const { turns } of this.#kept.values()) if (turns >= LOOP_TURNS) return true;
    return false;
  }

  /** Every pair counting now, with its turns. */
  pairs(): { pair: Pair; turns: number }[] {
    return [...this.#kept.values()].map(({ pair, turns }) => ({ pair, turns }));
  }

  /**
   * A turn between two agents was journaled as delivering: the run of turns it was counted in,
   * which `uncount` takes it back from.
   */
  count(x: string, y: string): number {
    const pair = orderedPair(x, y);
    const kept = this.#kept.get(keyOf(pair));
    const run = kept?.run ?? ++this.#runs;
    this.#set(pair, (kept?.turns ?? 0) + 1, run);
    return run;
  }

  /**
   * A turn counted in `run` was never sent (taken back unsent, or its journal not kept): taken
   * back from that run alone. Since the user spoke to either agent, the pair counts the turns
   * delivered since, and a turn counted before is none of them.
   */
  uncount(x: string, y: string, run: number): void {
    const kept = this.#kept.get(keyOf(orderedPair(x, y)));
    if (kept?.run === run) this.#set(kept.pair, kept.turns - 1, run);
  }

  /** The user gave `agent` input: every pair holding it is at zero. Whether any wasn't. */
  resetAgent(agent: string): boolean {
    let reset = false;
    for (const { pair } of [...this.#kept.values()]) {
      if (pair[0] !== agent && pair[1] !== agent) continue;
      this.#clear(pair);
      reset = true;
    }
    return reset;
  }

  /** The user let a pair go on: it is at zero. Whether it wasn't. */
  resetPair(x: string, y: string): boolean {
    const pair = orderedPair(x, y);
    if (!this.#kept.has(keyOf(pair))) return false;
    this.#clear(pair);
    return true;
  }

  /** The agents on the canvas now: a pair with an agent that isn't goes. */
  prune(agents: ReadonlySet<string>): void {
    for (const { pair } of [...this.#kept.values()]) {
      if (!agents.has(pair[0]) || !agents.has(pair[1])) this.#clear(pair);
    }
  }

  /** Whether anything changed that isn't on disk yet. */
  pending(): boolean {
    return this.#changed.size > 0;
  }

  /**
   * Within a write: writes each pair's row that isn't on disk as it is now; returns what marks
   * them on disk once the write's commit returned.
   */
  changes(): () => void {
    const written = new Map(this.#changed);
    for (const [key, { pair }] of written) {
      const kept = this.#kept.get(key);
      if (kept === undefined) this.#table.forget(this.canvas, pair);
      else this.#table.keep(this.canvas, pair, kept.turns);
    }
    return () => {
      for (const [key, { change }] of written)
        if (this.#changed.get(key)?.change === change) this.#changed.delete(key);
    };
  }

  /** Writes what changed in a write of its own: resolves once on disk, rejects if it couldn't be. */
  async durable(): Promise<void> {
    if (this.#changed.size === 0) return;
    const written = await this.#table.write(() => this.changes());
    written();
  }

  /** A pair's count, in its run of turns; at zero, none. */
  #set(pair: Pair, turns: number, run: number): void {
    const key = keyOf(pair);
    if (turns <= 0) this.#kept.delete(key);
    else this.#kept.set(key, { pair, turns, run });
    this.#changed.set(key, { pair, change: ++this.#changes });
  }

  /** A pair starts again from zero: the run of turns it counted is over. */
  #clear(pair: Pair): void {
    this.#set(pair, 0, 0);
  }
}
