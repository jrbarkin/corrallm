import { z } from 'zod';

import type { CanvasId } from '../../../shared/canvas';
import { HandoffSchema } from '../../../shared/model/handoff';
import type { Handoff } from '../../../shared/model/handoff';
import type { CanvasMemory } from '../../memory';
import type { Database } from '../store/store';
import type { Staged } from './messages';

export type { Handoff } from '../../../shared/model/handoff';

const ACCEPTED_TURNS = 64;
const AcceptedTurns = z.array(z.string().min(1).max(128)).max(ACCEPTED_TURNS);

/*
 * Each agent's latest handoff (B11a Design §12 C7, §12.4), as the core keeps it: a row of
 * `handoff` (schema 8) per agent while it is on the canvas, in memory and in the profile's
 * database. The text of a handoff accepted is written with the write that records the reply that
 * held it (it is kept in memory at once, and whatever the canvas writes next writes it: the reply's
 * record goes in that same write); a switch's carry is staged within the switch's own commit
 * (`stageCarry`); the send that carries it takes it (`take`), and the write that records that send
 * clears it. Nothing else writes the table. A row this code can't read (a newer corrallm's) is left
 * as it is.
 */

/** The Markdown copy of an agent's handoff last exported: where, and its bytes' SHA-256. */
export interface HandoffExport {
  path: string;
  sha256: string;
}

/**
 * Why there was no handoff to carry as a switch was made: its context never reached its ask point
 * (`reached`); it did, but no handoff was accepted (`unaccepted`: not asked, its backend out of
 * usage, or its requests not answered with one); its handoffs were off; or its connection
 * reported no context.
 */
export const CARRY_WHYS = ['reached', 'unaccepted', 'off', 'unreported'] as const;
export type CarryWhy = (typeof CARRY_WHYS)[number];

/** How the export of an agent's latest handoff went (none said: not made, or none to make). */
export const EXPORT_STATES = ['done', 'refused', 'failed'] as const;
export type ExportState = (typeof EXPORT_STATES)[number];

/** What the core keeps of an agent's handoff. */
export interface HandoffRecord {
  /** Its latest accepted handoff, if one is. */
  handoff?: Handoff;
  /** The 64 newest accepted request turn ids, independent of message retention; never text. */
  acceptedTurns?: readonly string[];
  /** The switch whose first automated send carries it, if one waits to. */
  carry?: string;
  /** Why there was no handoff to carry as the last switch was made, if there wasn't one. */
  carryWhy?: CarryWhy;
  /** Its last Markdown copy, if one was exported. */
  exported?: HandoffExport;
  /** How its latest handoff's export went, once it was made. */
  export?: ExportState;
}

/** The profile's handoffs, every canvas's, in the database's `handoff` table. */
export class HandoffTable {
  readonly #store: Database;
  readonly #memory: Pick<CanvasMemory, 'ensure'>;

  constructor(store: Database, memory: Pick<CanvasMemory, 'ensure'>) {
    this.#store = store;
    this.#memory = memory;
  }

  /** The rows of a canvas's handoffs. Throws if they can't be read. */
  rows(canvas: CanvasId): Record<string, unknown>[] {
    return this.#store
      .prepare(
        `SELECT agent_id, text, at, source, during, bytes, carry, carry_why, exported, accepted_turns
         FROM handoff WHERE canvas_id = ?`,
      )
      .all(canvas);
  }

  /** Queues `write` for the database's next commit: resolves once that commit has returned. */
  write<T>(write: () => T): Promise<T> {
    return this.#store.write(write);
  }

  /** Within a write: an agent's row, as kept (each column by name). */
  keep(
    canvas: CanvasId,
    agent: string,
    { handoff, acceptedTurns, carry, carryWhy, exported, export: state }: HandoffRecord,
  ): void {
    this.#memory.ensure(canvas);
    this.#store
      .prepare(
        `INSERT INTO handoff (canvas_id, agent_id, text, at, source, during, bytes, carry,
           carry_why, exported, accepted_turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (canvas_id, agent_id) DO UPDATE SET
           text = excluded.text, at = excluded.at, source = excluded.source,
           during = excluded.during, bytes = excluded.bytes, carry = excluded.carry,
           carry_why = excluded.carry_why, exported = excluded.exported,
           accepted_turns = excluded.accepted_turns`,
      )
      .run(
        canvas,
        agent,
        handoff?.text ?? null,
        handoff?.at ?? null,
        json(handoff?.source),
        json(handoff?.during),
        handoff?.bytes ?? null,
        carry ?? null,
        carryWhy ?? null,
        exported === undefined && state === undefined
          ? null
          : JSON.stringify({ ...exported, ...(state === undefined ? {} : { state }) }),
        JSON.stringify(acceptedTurns ?? []),
      );
  }

  /** Within a write: an agent's carry and why there was no handoff, its row made if it has none. */
  carry(canvas: CanvasId, agent: string, carry: string, why: CarryWhy | undefined): void {
    this.#memory.ensure(canvas);
    this.#store
      .prepare(
        `INSERT INTO handoff (canvas_id, agent_id, carry, carry_why) VALUES (?, ?, ?, ?)
         ON CONFLICT (canvas_id, agent_id) DO UPDATE SET
           carry = excluded.carry, carry_why = excluded.carry_why`,
      )
      .run(canvas, agent, carry, why ?? null);
  }

  /** Within a write: deletes an agent's row. */
  forget(canvas: CanvasId, agent: string): void {
    this.#store
      .prepare('DELETE FROM handoff WHERE canvas_id = ? AND agent_id = ?')
      .run(canvas, agent);
  }
}

/** A canvas's handoffs, by agent. */
export class HandoffStore {
  readonly canvas: CanvasId;
  readonly #table: HandoffTable;
  readonly #kept = new Map<string, HandoffRecord>();
  /** The agents whose rows a newer corrallm wrote that this code doesn't read: left as they are. */
  readonly #unread = new Set<string>();
  /** The agents whose rows aren't on disk as they are, each with the number of its last change. */
  readonly #changed = new Map<string, number>();
  #changes = 0;
  /** Why the canvas's handoffs couldn't be read as it loaded, if they couldn't. */
  warning: string | undefined;

  constructor(canvas: CanvasId, table: HandoffTable) {
    this.canvas = canvas;
    this.#table = table;
  }

  /** Reads what the database keeps of the canvas's handoffs. Never throws. */
  load(): void {
    let rows: Record<string, unknown>[];
    try {
      rows = this.#table.rows(this.canvas);
    } catch (error) {
      this.warning = `The canvas’s handoffs could not be read (${reason(error)}).`;
      return;
    }
    for (const row of rows) {
      const agent = row.agent_id;
      if (typeof agent !== 'string') continue;
      const record = recordOf(row);
      if (record === undefined) this.#unread.add(agent);
      else this.#kept.set(agent, record);
    }
  }

  /** What is kept of an agent's handoff, if anything is. */
  of(agent: string): Readonly<HandoffRecord> | undefined {
    return this.#kept.get(agent);
  }

  /**
   * An accepted handoff, the agent's latest now: kept at once, written with the canvas's next
   * write (the one that records its reply), what waits to be carried and the last export kept.
   */
  accept(agent: string, handoff: Handoff, turn?: string): void {
    // Its own export is yet to be made: how the last one went no longer says.
    const record: HandoffRecord = { ...this.#kept.get(agent), handoff };
    if (turn !== undefined)
      record.acceptedTurns = [
        ...(record.acceptedTurns ?? []).filter((id) => id !== turn),
        turn,
      ].slice(-ACCEPTED_TURNS);
    delete record.export;
    this.#set(agent, record);
  }

  /**
   * Within a switch's commit write (B11a C4): the agent's carry set to that switch, with why there
   * is no handoff to carry if there isn't (`why`), on disk with it or not at all. Kept at once, so
   * that nothing written after it writes it out again; undone, as it was, if the write fails.
   */
  stageCarry(agent: string, carry: string, why?: CarryWhy): Staged {
    const before = this.#kept.get(agent);
    this.#table.carry(this.canvas, agent, carry, why);
    const record: HandoffRecord = { ...before, carry };
    if (why === undefined) delete record.carryWhy;
    else record.carryWhy = why;
    this.#kept.set(agent, record);
    this.#unread.delete(agent);
    return {
      reveal: () => undefined,
      undo: () => {
        if (this.#kept.get(agent)?.carry !== carry) return;
        if (before === undefined) this.#kept.delete(agent);
        else this.#kept.set(agent, before);
      },
    };
  }

  /**
   * The send that carries an agent's handoff takes it (C7): the switch it waits for and the latest
   * handoff (none if none was written), its carry cleared at once, so the write that records that
   * send clears it on disk too; why there was none, where there wasn't, stays. Undefined where
   * nothing waits to be carried.
   */
  take(agent: string): { carry: string; why?: CarryWhy; handoff?: Handoff } | undefined {
    const record = this.#kept.get(agent);
    if (record?.carry === undefined) return undefined;
    const { carry, ...rest } = record;
    this.#set(agent, rest);
    return {
      carry,
      ...(record.handoff === undefined && record.carryWhy !== undefined
        ? { why: record.carryWhy }
        : {}),
      ...(record.handoff === undefined ? {} : { handoff: record.handoff }),
    };
  }

  /**
   * The send that took `carry` never went (its record not kept, taken back before its session had
   * it, or cut off by a crash before it was sent): it still waits, unless another is set since.
   */
  untake(agent: string, carry: string): void {
    const record = this.#kept.get(agent);
    if (record?.carry !== undefined) return;
    this.#set(agent, { ...record, carry });
  }

  /**
   * How the export of the agent's latest handoff went: done, its copy what its next export may
   * replace; refused or failed, its last copy still its own.
   */
  exported(
    agent: string,
    outcome: ({ state: 'done' } & HandoffExport) | { state: 'refused' | 'failed' },
  ): void {
    const record: HandoffRecord = { ...this.#kept.get(agent), export: outcome.state };
    if (outcome.state === 'done') record.exported = { path: outcome.path, sha256: outcome.sha256 };
    this.#set(agent, record);
  }

  /** A superseded handoff finished writing: retain its copy's proof, not its export status. */
  copied(agent: string, exported: HandoffExport): void {
    const record = this.#kept.get(agent);
    if (record !== undefined) this.#set(agent, { ...record, exported });
  }

  /** As the canvas opens: the rows of agents no longer on it go, with the next write. */
  prune(agents: ReadonlySet<string>): void {
    for (const agent of [...this.#kept.keys(), ...this.#unread]) {
      if (agents.has(agent)) continue;
      this.#kept.delete(agent);
      this.#unread.delete(agent);
      this.#changed.set(agent, ++this.#changes);
    }
  }

  /** Whether anything changed that isn't on disk yet. */
  pending(): boolean {
    return this.#changed.size > 0;
  }

  /**
   * Within a write: writes each agent's row that isn't on disk as it is now; returns what marks
   * them on disk once the write's commit returned.
   */
  changes(): () => void {
    const written = new Map(this.#changed);
    for (const agent of written.keys()) {
      const record = this.#kept.get(agent);
      if (record === undefined) this.#table.forget(this.canvas, agent);
      else this.#table.keep(this.canvas, agent, record);
    }
    return () => {
      for (const [agent, change] of written)
        if (this.#changed.get(agent) === change) this.#changed.delete(agent);
    };
  }

  /** Writes what changed in a write of its own: resolves once on disk, rejects if it couldn't be. */
  async durable(): Promise<void> {
    if (this.#changed.size === 0) return;
    const written = await this.#table.write(() => this.changes());
    written();
  }

  #set(agent: string, record: HandoffRecord): void {
    this.#unread.delete(agent);
    if (Object.keys(record).length === 0) this.#kept.delete(agent);
    else this.#kept.set(agent, record);
    this.#changed.set(agent, ++this.#changes);
  }
}

/** A row of `handoff`, read: undefined if it holds anything this code doesn't read. */
function recordOf(row: Record<string, unknown>): HandoffRecord | undefined {
  const { text, at, bytes, carry } = row;
  const carryWhy = CARRY_WHYS.find((one) => one === row.carry_why);
  const source = parsed(row.source);
  const during = parsed(row.during);
  const exported = parsed(row.exported);
  const acceptedTurns = turnsOf(row.accepted_turns);
  if (source === null || during === null || exported === null) return undefined;
  if (acceptedTurns === undefined) return undefined;
  if (carry !== null && typeof carry !== 'string') return undefined;
  if (row.carry_why !== null && carryWhy === undefined) return undefined;
  let handoff: Handoff | undefined;
  if (text !== null) {
    const read = HandoffSchema.safeParse({
      text,
      at,
      source,
      ...(during === undefined ? {} : { during }),
      bytes,
    });
    if (!read.success) return undefined;
    handoff = read.data;
  }
  // What was exported: its last copy (path and hash, together or neither), and how its latest
  // export went.
  const { path, sha256, state, ...others } = exported ?? {};
  const copy = path !== undefined || sha256 !== undefined;
  const last =
    typeof path === 'string' && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)
      ? { path, sha256 }
      : undefined;
  const outcome = EXPORT_STATES.find((one) => one === state);
  if (
    Object.keys(others).length > 0 ||
    (copy && last === undefined) ||
    (state !== undefined && outcome === undefined) ||
    (exported !== undefined && !copy && outcome === undefined)
  )
    return undefined;
  return {
    ...(handoff === undefined ? {} : { handoff }),
    ...(acceptedTurns.length === 0 ? {} : { acceptedTurns }),
    ...(typeof carry === 'string' ? { carry } : {}),
    ...(carryWhy === undefined ? {} : { carryWhy }),
    ...(last === undefined ? {} : { exported: last }),
    ...(outcome === undefined ? {} : { export: outcome }),
  };
}

/** Only bounded ids are retained as provenance, never request or reply text. */
function turnsOf(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const read = AcceptedTurns.safeParse(JSON.parse(value));
    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON column's object: undefined for none, null for anything else. */
function parsed(value: unknown): Record<string, unknown> | undefined | null {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  try {
    const object: unknown = JSON.parse(value);
    return typeof object === 'object' && object !== null && !Array.isArray(object)
      ? (object as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A value as a JSON column holds it: none for none. */
function json(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
