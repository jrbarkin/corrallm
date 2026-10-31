import type { CanvasId } from '../../../shared/canvas';
import { HandoffSchema } from '../../../shared/model/handoff';
import type { Handoff } from '../../../shared/model/handoff';
import type { CanvasMemory } from '../../memory';
import type { Database } from '../store/store';
import type { Staged } from './messages';

export type { Handoff } from '../../../shared/model/handoff';

/*
 * Each agent's latest handoff (B11a Design §12 C7, §12.4), as the core keeps it: a row of
 * `handoff` (schema 7) per agent while it is on the canvas, in memory and in the profile's
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

/** What the core keeps of an agent's handoff. */
export interface HandoffRecord {
  /** Its latest accepted handoff, if one is. */
  handoff?: Handoff;
  /** The switch whose first automated send carries it, if one waits to. */
  carry?: string;
  /** Its last Markdown copy, if one was exported. */
  exported?: HandoffExport;
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
        `SELECT agent_id, text, at, source, during, bytes, carry, exported
         FROM handoff WHERE canvas_id = ?`,
      )
      .all(canvas);
  }

  /** Queues `write` for the database's next commit: resolves once that commit has returned. */
  write<T>(write: () => T): Promise<T> {
    return this.#store.write(write);
  }

  /** Within a write: an agent's row, as kept (each column by name). */
  keep(canvas: CanvasId, agent: string, { handoff, carry, exported }: HandoffRecord): void {
    this.#memory.ensure(canvas);
    this.#store
      .prepare(
        `INSERT INTO handoff (canvas_id, agent_id, text, at, source, during, bytes, carry, exported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (canvas_id, agent_id) DO UPDATE SET
           text = excluded.text, at = excluded.at, source = excluded.source,
           during = excluded.during, bytes = excluded.bytes, carry = excluded.carry,
           exported = excluded.exported`,
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
        json(exported),
      );
  }

  /** Within a write: an agent's carry alone, its row made if it has none. */
  carry(canvas: CanvasId, agent: string, carry: string): void {
    this.#memory.ensure(canvas);
    this.#store
      .prepare(
        `INSERT INTO handoff (canvas_id, agent_id, carry) VALUES (?, ?, ?)
         ON CONFLICT (canvas_id, agent_id) DO UPDATE SET carry = excluded.carry`,
      )
      .run(canvas, agent, carry);
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
  accept(agent: string, handoff: Handoff): void {
    this.#set(agent, { ...this.#kept.get(agent), handoff });
  }

  /**
   * Within a switch's commit write (B11a C4): the agent's carry set to that switch, on disk with
   * it or not at all. Kept at once, so that nothing written after it writes it out again; undone,
   * as it was, if the write fails.
   */
  stageCarry(agent: string, carry: string): Staged {
    const before = this.#kept.get(agent);
    this.#table.carry(this.canvas, agent, carry);
    this.#kept.set(agent, { ...before, carry });
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
   * send clears it on disk too. Undefined where nothing waits to be carried.
   */
  take(agent: string): { carry: string; handoff?: Handoff } | undefined {
    const record = this.#kept.get(agent);
    if (record?.carry === undefined) return undefined;
    const { carry, ...rest } = record;
    this.#set(agent, rest);
    return { carry, ...(record.handoff === undefined ? {} : { handoff: record.handoff }) };
  }

  /** The send that took `carry` was never recorded: it still waits, unless another is set since. */
  untake(agent: string, carry: string): void {
    const record = this.#kept.get(agent);
    if (record?.carry !== undefined) return;
    this.#set(agent, { ...record, carry });
  }

  /** The agent's handoff was exported as `exported`: what its next export may replace. */
  exported(agent: string, exported: HandoffExport): void {
    this.#set(agent, { ...this.#kept.get(agent), exported });
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
  const source = parsed(row.source);
  const during = parsed(row.during);
  const exported = parsed(row.exported);
  if (source === null || during === null || exported === null) return undefined;
  if (carry !== null && typeof carry !== 'string') return undefined;
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
  if (
    exported !== undefined &&
    (typeof exported.path !== 'string' ||
      typeof exported.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(exported.sha256) ||
      Object.keys(exported).length !== 2)
  )
    return undefined;
  return {
    ...(handoff === undefined ? {} : { handoff }),
    ...(typeof carry === 'string' ? { carry } : {}),
    ...(exported === undefined
      ? {}
      : { exported: { path: exported.path as string, sha256: exported.sha256 as string } }),
  };
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
