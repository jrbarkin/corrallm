import { randomUUID } from 'node:crypto';

import {
  MAX_MESSAGE_BYTES,
  STORE_BYTES,
  STORE_SETTLED_PER_PARTY,
} from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { AskColumn } from '../../../shared/model/asks';
import { Purpose } from '../../../shared/model/purpose';
import { MAX_RECORD_ENTRIES, RecordAbout, shownRecord } from '../../../shared/model/records';
import type { RecordRow } from '../../../shared/model/records';
import { Verdict } from '../../../shared/model/results';
import {
  agentOf,
  isQueueHandoff,
  isSettled,
  isTurn,
  MESSAGE_KINDS,
  MESSAGE_ORIGINS,
  MESSAGE_STATES,
  PARTY_PATTERN,
} from '../../../shared/model/messages';
import type {
  Message,
  MessageDisplay,
  MessageOrigin,
  PartyId,
} from '../../../shared/model/messages';
import { Settled } from '../../../shared/model/settled';
import type { CanvasMemory } from '../../memory';
import type { Database } from '../store/store';
import { Sequence } from './sequence';

/*
 * A canvas's messages, as the core keeps them (API Spec §5.3, Core Server §5.9): in memory, in the
 * order they came, and in the profile's database (Core Database §5), each a row of `message`, with
 * the key of what it tells, for a notice (`told`), the note its recipient must still be told of
 * a withdrawal (`withdrawal`), how it came to be (`origin`, which its caller says, never a party:
 * B11 Design §3), what a view shows of it beside its body (`display`), for a record of a native
 * prompt's decision, what was decided (`settled`: B13 §9.2 C9, written with its row and never
 * changed after), or for an ask, how it ended (B21 C6: written once, as it ends, never after), and
 * an ask's questions or an answer's answers (`ask`: B21 C6, migration 9, written with its row and
 * never changed after), a result's verdict (`verdict`: B21 C8, migration 10, written with its
 * row and never changed after), and a queue hand-off's or its evidence's purpose (`purpose`: B19
 * C1, migration 12, written with its row and never changed after), and beside a record the core
 * settled, the agent whose window shows it (`about`: B19 C3, migration 13, written with its row and
 * never changed after, read through `records`). Their order (`seq`) is one every canvas's messages share, whose
 * places are never given again (MessageTable), so a cursor into it survives pruning, restarts and
 * restores. It keeps the newest STORE_SETTLED_PER_PARTY settled messages of each party within
 * STORE_BYTES, and every pending and unresolved one, deleting the oldest settled first (delivery
 * bounds how many wait: MAX_WAITING). Beside them it keeps the few delivery still acts on
 * (`active`), as they change, so that what looks at what waits (each needs pass, each delivery)
 * costs what waits, not what is kept.
 * Settled records are indexed by sequence, globally and for both parties, and bytes counted as
 * records change. Pruning checks only new records and the at-most-two occurrences crossing each
 * changed party's quota, then removes the oldest settled records while over the byte budget.
 *
 * What changes is written in the database's next commit, with whatever its canvas writes with it
 * (`writeWith`: its run, once the canvas is open), and on disk once `durable()` resolves: the commit
 * that holds it returned. A message's row is kept as it is in memory when that write runs, so a
 * change made since the last write is never written alone, before one made earlier. It never
 * throws: what it can't write it says on the console, and writes again with its next write, except
 * where a caller asks for its record on disk (`durable`), which rejects then. A store whose rows
 * can't be read (as when the database couldn't be opened) starts empty and journals nothing:
 * `durable` rejects once anything has changed, so nothing is sent without its record.
 */

/**
 * How a message came to be, as the core says (never an argument of a caller's), and what a view
 * shows of it: kept beside it, never changed but for its display.
 */
export interface Provenance {
  origin: MessageOrigin;
  display?: MessageDisplay;
  /**
   * B19 C3: for a record the core settled, the agent whose window shows it and the Needs item it
   * settled (src/shared/model/records.ts), core-written with it and never changed after.
   */
  about?: RecordAbout;
  /**
   * B19 C3: a native decision its prompt's owner made while this store runs, which its owner entry
   * shows, never the window: kept in memory alone, never written, so a store loaded again (a
   * restart, its canvas opened again), with no owner entry left, shows it in the window.
   */
  owned?: true;
}

/** A message to add: the store gives it its id, its canvas and when it was sent. */
export type Draft = Omit<Message, 'id' | 'canvas' | 'at'> & Provenance;

/**
 * What a write staged with what else it writes: told once the write's commit returned, or undone if
 * it failed.
 */
export interface Staged {
  reveal(): void;
  undo(error?: unknown): void;
}

/**
 * A message as the store keeps it: its place in the order, how big its record is, and, for a
 * notice, what it told (its key: Delivery tells each thing once, across restarts too).
 */
interface Kept extends Provenance {
  seq: number;
  message: Message;
  bytes: number;
  told?: string;
  /** What its recipient must still be told of a withdrawal after receipt. */
  withdrawal?: { text: string; told?: boolean };
}

/**
 * The profile's messages, every canvas's, in the database's `message` table: a row each, in the
 * order every canvas's messages share. The core is the table's only writer, so it gives each place
 * in that order itself, past the last the table's sequence gave (AUTOINCREMENT, which every open
 * raises past every place given before, those whose rows a crash cut off included: store/open.ts),
 * and SQLite raises that sequence with each row written.
 */
export class MessageTable {
  readonly #store: Database;
  readonly #memory: Pick<CanvasMemory, 'ensure'>;
  /** The last place given, once read. */
  #last: number | undefined;

  constructor(store: Database, memory: Pick<CanvasMemory, 'ensure'>) {
    this.#store = store;
    this.#memory = memory;
  }

  /** The rows of a canvas's messages, in order. Throws if they can't be read. */
  rows(canvas: CanvasId): Record<string, unknown>[] {
    return this.#store
      .prepare(
        `SELECT seq, id, from_party, to_party, kind, origin, body, display, reply_to, resend_of,
           task, turn, state, delivery, by_party, sent_at, told, withdrawal, settled, ask, verdict,
           purpose, about
         FROM message WHERE canvas_id = ? ORDER BY seq`,
      )
      .all(canvas);
  }

  /** The last place given in the order: on disk, or since. Throws if it can't be read. */
  last(): number {
    this.#last ??= Number(
      this.#store.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'message'").get()?.seq ?? 0,
    );
    return this.#last;
  }

  /** The next place in the order. */
  place(): number {
    this.#last = this.last() + 1;
    return this.#last;
  }

  /** Queues `write` for the database's next commit: resolves once that commit has returned. */
  write<T>(write: () => T, failed?: (error: unknown) => void): Promise<T> {
    return this.#store.write(write, failed);
  }

  /** Within a write: gives the canvas its row, if it has none, for its messages to refer to. */
  ensure(canvas: CanvasId): void {
    this.#memory.ensure(canvas);
  }

  /**
   * Within a write: a message's row, as kept (each column written by name, so that what a newer
   * corrallm keeps beside them stays). A record's settled decision is written with its row and
   * never after: no change writes it again; an ask's settlement is written once, as it ends (a
   * row that has one keeps it). An ask's questions or an answer's answers, a result's verdict, and
   * a queue hand-off's or its evidence's purpose (B19 C1), and a record's association (B19 C3), are
   * written with its row and never after.
   */
  keep({ seq, message, origin, display, told, withdrawal, about }: Kept): void {
    this.#store
      .prepare(
        `INSERT INTO message (seq, id, canvas_id, from_party, to_party, kind, origin, body, display,
           reply_to, resend_of, task, turn, state, delivery, by_party, sent_at, told, withdrawal,
           settled, ask, verdict, purpose, about)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           body = excluded.body, display = excluded.display, reply_to = excluded.reply_to,
           task = excluded.task, turn = excluded.turn, state = excluded.state,
           delivery = excluded.delivery, by_party = excluded.by_party, told = excluded.told,
           withdrawal = excluded.withdrawal, settled = coalesce(message.settled, excluded.settled)`,
      )
      .run(
        seq,
        message.id,
        message.canvas,
        message.from,
        message.to,
        message.kind,
        origin,
        message.body,
        json(display),
        message.replyTo ?? null,
        message.resendOf ?? null,
        json(message.task),
        json(message.turn),
        message.state,
        json(message.delivery),
        message.by ?? null,
        message.at,
        told ?? null,
        json(withdrawal),
        json(message.settled),
        json(message.ask),
        json(message.verdict),
        json(message.purpose),
        json(about),
      );
  }

  /** Within a write: deletes a message's row. */
  forget(id: string): void {
    this.#store.prepare('DELETE FROM message WHERE id = ?').run(id);
  }
}

export class MessageStore {
  readonly canvas: CanvasId;
  readonly #table: MessageTable;
  readonly #now: () => number;
  /** Every message kept, by id, in the store's order. */
  readonly #kept = new Map<string, Kept>();
  /** The messages kept that delivery still acts on (isActive), by id, in the store's order. */
  #active = new Map<string, Kept>();
  /** The latest place of a message `#active` has taken: one placed later goes last in it. */
  #activeLast = 0;
  /**
   * B19 C2: the messages delivery still acts on, by their recipient, each in the store's order, with
   * the latest place each line has taken: what reads one agent's line (a gap offered it) reads it
   * alone, never every message delivery acts on.
   */
  readonly #activeTo = new Map<PartyId, { line: Map<string, Kept>; last: number }>();
  /** Only records eligible for pruning: globally, and by both parties, in original order. */
  readonly #settled = new Sequence();
  readonly #parties = new Map<PartyId, Sequence>();
  /** Records that may just have fallen outside both parties’ newest-message quotas. */
  readonly #candidates = new Set<string>();
  /** Results by the native turn they report: its unsettled turn keeps its fixed verdict. */
  readonly #results = new Map<string, Set<string>>();
  /**
   * B19 C3: the records each agent's window may show (shownRecord), by agent, in the store's
   * order; the agent each is shown to, by id; each agent's window (its newest MAX_RECORD_ENTRIES)
   * as last read, until it changes; and the agents whose window a message's change changed, told
   * as that change is (its id heard).
   */
  readonly #records = new Map<string, Sequence>();
  readonly #recordOf = new Map<string, string>();
  readonly #windows = new Map<string, readonly RecordRow[]>();
  readonly #windowsChanged = new Map<string, Set<string>>();
  readonly #recordWatchers = new Set<(agent: string) => void>();
  /** Settling a turn and judging its report are one synchronous action. */
  readonly #judging = new Set<string>();
  #bytes = 0;
  /** What hears each message added. */
  readonly #listeners = new Set<(message: Message) => void>();
  /** What hears each message kept, changed or no longer kept (its id): the topics' source. */
  readonly #watchers = new Set<(id: string) => void>();
  /**
   * Changes that still need SQL, each with its last change number. Issued SQL moves to #inFlight
   * until the containing write flushes; a rollback restores it here before the next write runs.
   */
  readonly #changed = new Map<string, number>();
  /** The latest issued write's flush covers the preceding SQL too: the store flushes a prefix. */
  #inFlight: Promise<void> | undefined;
  #changes = 0;
  #scheduled = false;
  /** The write queued that hasn't run yet: it writes every change made before it runs. */
  #queued: Promise<void> | undefined;
  /** What its canvas writes with its changes, within the same write. */
  #alongside: (() => () => void) | undefined;
  /**
   * What is written with its changes in every write that holds them, whoever makes it (B21 C6: the
   * loop breaker's counts, which a turn journaled as delivering is counted in).
   */
  #companion: (() => () => void) | undefined;
  /** Why the store journals nothing, if it can't. */
  #unjournaled: string | undefined;
  /** Whether anything changed that wasn't journaled, as the store journals nothing. */
  #lost = false;
  /** The last place given, while the store journals nothing. */
  #seq = 0;
  /** Why the store couldn't read its messages as it loaded, if it couldn't. */
  warning: string | undefined;

  constructor(canvas: CanvasId, table: MessageTable, now: () => number) {
    this.canvas = canvas;
    this.#table = table;
    this.#now = now;
  }

  /**
   * Reads what the database keeps of the canvas's messages: a row this code doesn't read (as one a
   * newer corrallm wrote) is left as it is. Never rejects.
   */
  load(): Promise<void> {
    let rows: Record<string, unknown>[];
    try {
      rows = this.#table.rows(this.canvas);
      this.#table.last();
    } catch (error) {
      this.#unjournaled = `The canvas’s messages could not be read (${reason(error)}), so none can be sent until corrallm opens the canvas again.`;
      this.warning = this.#unjournaled;
      return Promise.resolve();
    }
    for (const row of rows) {
      const kept = keptOf(row, this.canvas);
      if (kept) this.#set(kept);
    }
    this.#prune();
    return Promise.resolve();
  }

  /** Every message kept, in the store's order. */
  all(): Message[] {
    return Array.from(this.#kept.values(), ({ message }) => message);
  }

  /**
   * B19 C2: the messages kept that delivery still acts on (isActive) to party `to`, in the store's
   * order: what waits for one agent, read without a walk of the rest.
   */
  activeTo(to: PartyId): Message[] {
    const kept = this.#activeTo.get(to);
    return kept === undefined ? [] : Array.from(kept.line.values(), ({ message }) => message);
  }

  /**
   * Every message kept that delivery still acts on (isActive), in the store's order: those waiting,
   * being delivered, or whose turn goes on.
   */
  active(): Message[] {
    return Array.from(this.#active.values(), ({ message }) => message);
  }

  get(id: string): Message | undefined {
    return this.#kept.get(id)?.message;
  }

  /** Keeps a turn's result readable through settlement and the judgment that immediately follows. */
  judging(id: string, use: () => void): void {
    if (!this.#results.has(id) || this.#judging.has(id)) {
      use();
      return;
    }
    this.#judging.add(id);
    try {
      use();
    } finally {
      this.#judging.delete(id);
      for (const result of this.#results.get(id) ?? []) {
        const kept = this.#kept.get(result);
        if (kept !== undefined && this.#prunable(kept)) this.#settle(kept);
      }
      this.#prune();
    }
  }

  /** A message's place in the store's order, if it is kept. */
  seqOf(id: string): number | undefined {
    return this.#kept.get(id)?.seq;
  }

  /**
   * The last place given in the order (in any canvas): a cursor there reads only what comes later.
   */
  end(): number {
    return this.#unjournaled === undefined ? this.#table.last() : this.#seq;
  }

  /**
   * Adds a message, written with the store's next write: as kept. `told`: for a notice, the key of
   * what it tells, kept with it.
   */
  add({ origin, display, about, owned, ...draft }: Draft, told?: string): Message {
    const message: Message = { id: randomUUID(), canvas: this.canvas, ...draft, at: this.#now() };
    const seq = this.#unjournaled === undefined ? this.#table.place() : ++this.#seq;
    this.#keep({
      seq,
      message,
      bytes: 0,
      origin,
      ...(display === undefined ? {} : { display }),
      ...(about === undefined ? {} : { about }),
      ...(owned === undefined ? {} : { owned }),
      ...(told === undefined ? {} : { told }),
    });
    for (const listener of this.#listeners) listener(message);
    return message;
  }

  /**
   * Within a write: adds a message whose row that very write holds, with whatever else it writes
   * (B9 Design §3: a proposal's settlement, and Allow's change, with the record its proposer gets),
   * so that it is on disk with them or not at all. It is kept, in its place in the order, at once,
   * as every message the store adds is (a reader never skips past it); `reveal` tells those who
   * hear messages, once the write's commit returned, and `undo` forgets it, if the write failed.
   * Throws, adding nothing, if the store journals nothing.
   */
  stageWithin({ origin, display, about, owned, ...draft }: Draft): Staged & { message: Message } {
    if (this.#unjournaled !== undefined) throw new Error(this.#unjournaled);
    const message: Message = { id: randomUUID(), canvas: this.canvas, ...draft, at: this.#now() };
    const kept: Kept = {
      seq: this.#table.place(),
      message,
      bytes: 0,
      origin,
      ...(display === undefined ? {} : { display }),
      ...(about === undefined ? {} : { about }),
      ...(owned === undefined ? {} : { owned }),
    };
    this.#table.ensure(this.canvas);
    this.#table.keep(kept);
    this.#set({ ...kept, bytes: sizeOf(kept) });
    return {
      message,
      reveal: () => {
        this.#prune();
        this.#changedId(message.id);
        for (const listener of this.#listeners) listener(message);
      },
      undo: () => {
        this.#delete(message.id);
        this.#changedId(message.id);
      },
    };
  }

  /**
   * B19 C3: agent `agent`'s window, the settled records it shows (shownRecord), the newest
   * MAX_RECORD_ENTRIES of those kept, in the store's order, each with its association: the same
   * list until it changes, read only then, never by a walk of the rest.
   */
  records(agent: string): readonly RecordRow[] {
    const cached = this.#windows.get(agent);
    if (cached !== undefined) return cached;
    const sequence = this.#records.get(agent);
    if (sequence === undefined) return NO_RECORDS;
    const rows: RecordRow[] = [];
    for (let offset = Math.min(sequence.weight, MAX_RECORD_ENTRIES) - 1; offset >= 0; offset--) {
      const id = sequence.newest(offset);
      const kept = id === undefined ? undefined : this.#kept.get(id);
      if (kept?.about !== undefined)
        rows.push(Object.freeze({ message: kept.message, about: kept.about }));
    }
    const window = Object.freeze(rows);
    this.#windows.set(agent, window);
    return window;
  }

  /**
   * Hears, by agent, each change of its window (B19 C3), as the message that changed it is heard
   * (`watch`): a record kept, changed or dropped where the window shows it, or moved into or out of
   * it; never another message's change. What the session topic publishes its records from.
   */
  watchRecords(watcher: (agent: string) => void): () => void {
    this.#recordWatchers.add(watcher);
    return () => {
      this.#recordWatchers.delete(watcher);
    };
  }

  /** Hears each message added from now on, as it is kept (a `wait` wakes on it). */
  subscribe(listener: (message: Message) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Hears, by its id, each message kept from now on, each change to one, and each one no longer
   * kept (pruned): what a canvas's `messages:<c>` topic publishes (B11 §5). A message staged within
   * a write is heard once revealed.
   */
  watch(watcher: (id: string) => void): () => void {
    this.#watchers.add(watcher);
    return () => {
      this.#watchers.delete(watcher);
    };
  }

  /** The keys of what the notices kept told about messages still waiting. */
  told(): string[] {
    return [...this.#kept.values()].flatMap(({ message, told }) =>
      told !== undefined &&
      message.replyTo !== undefined &&
      this.get(message.replyTo)?.state === 'pending'
        ? [told]
        : [],
    );
  }

  /** A durable notice already told this, even if its message's turn has ended since. */
  hasTold(key: string): boolean {
    return [...this.#kept.values()].some(({ told }) => told === key);
  }

  /** The message kept with the told key `key`, if one is (what a request admitted once). */
  toldAs(key: string): Message | undefined {
    for (const { message, told } of this.#kept.values()) if (told === key) return message;
    return undefined;
  }

  /** The messages kept with a told key starting `prefix`, in the store's order. */
  toldStarting(prefix: string): Message[] {
    return [...this.#kept.values()].flatMap(({ message, told }) =>
      told?.startsWith(prefix) === true ? [message] : [],
    );
  }

  /** The key a message kept was kept with (what it told, or what admitted it), if any. */
  toldOf(id: string): string | undefined {
    return this.#kept.get(id)?.told;
  }

  /**
   * Keeps a message with another key (none: `undefined`), written with the next write: B11a C7's
   * mark of a send that carried an agent's handoff, value-free. False if it isn't kept.
   */
  retell(id: string, told: string | undefined): boolean {
    const kept = this.#kept.get(id);
    if (!kept) return false;
    if (kept.told === told) return true;
    const next: Kept = { ...kept };
    if (told === undefined) delete next.told;
    else next.told = told;
    this.#keep(next);
    return true;
  }

  /** How a message kept came to be. */
  originOf(id: string): MessageOrigin | undefined {
    return this.#kept.get(id)?.origin;
  }

  /** What a view shows of a message kept beside its body, if anything. */
  displayOf(id: string): MessageDisplay | undefined {
    return this.#kept.get(id)?.display;
  }

  /**
   * Whether a message can't be sent without the images it carried. Their bytes are live-only
   * (Delivery's): once a restart has lost them, it is never sent without them.
   */
  requiresImages(message: Message): boolean {
    return this.#kept.get(message.id)?.display?.requiresImages === true;
  }

  /** Whether a message kept resends the message `id`: each is resent once, across restarts too. */
  resent(id: string): boolean {
    for (const { message } of this.#kept.values()) if (message.resendOf === id) return true;
    return false;
  }

  /** Changes what a view shows of a message: as kept, or false if it isn't kept (any more). */
  redisplay(id: string, display: MessageDisplay | undefined): boolean {
    const kept = this.#kept.get(id);
    if (!kept) return false;
    const next: Kept = { ...kept };
    if (display === undefined) delete next.display;
    else next.display = display;
    this.#keep(next);
    return true;
  }

  /** Changes a message: as kept, or undefined if it isn't kept (any more). */
  update(
    id: string,
    change: Partial<Omit<Message, 'id' | 'canvas'>>,
    withdrawal?: string,
  ): Message | undefined {
    const kept = this.#kept.get(id);
    if (!kept) return undefined;
    // B19 C1: a purpose is the row's from its first write, as its column keeps it: never changed.
    const { purpose } = kept.message;
    const message: Message = { ...kept.message, ...change };
    if (purpose === undefined) delete message.purpose;
    else message.purpose = purpose;
    this.#keep({
      ...kept,
      message,
      ...(withdrawal === undefined ? {} : { withdrawal: { text: withdrawal } }),
    });
    return message;
  }

  /** The withdrawals a recipient has not yet been told of, in the order their messages came. */
  withdrawals(to: PartyId): { id: string; text: string }[] {
    return [...this.#kept.values()].flatMap(({ message, withdrawal }) =>
      message.to === to && withdrawal !== undefined && !withdrawal.told
        ? [{ id: message.id, text: withdrawal.text }]
        : [],
    );
  }

  /** The CLI echoed the message carrying these notes: their withdrawals need no more telling. */
  toldWithdrawals(ids: readonly string[]): void {
    for (const id of ids) {
      const kept = this.#kept.get(id);
      if (kept?.withdrawal && !kept.withdrawal.told) {
        this.#keep({ ...kept, withdrawal: { ...kept.withdrawal, told: true } });
      }
    }
  }

  /**
   * What its canvas writes with each write of its changes, within the same write (none: nothing):
   * `alongside` writes it, and returns what marks it on disk once the write's commit returned.
   */
  writeWith(alongside: (() => () => void) | undefined): void {
    this.#alongside = alongside;
  }

  /**
   * What every write that holds this store's changes writes with them, within the same write
   * (none: nothing): `companion` writes it, and returns what marks it on disk once the write's
   * commit returned.
   */
  writeAlso(companion: (() => () => void) | undefined): void {
    this.#companion = companion;
  }

  /**
   * Resolves once every change so far is on disk, with what its canvas writes with it; rejects if
   * it couldn't be.
   */
  durable(): Promise<void> {
    if (this.#unjournaled !== undefined) {
      return this.#lost ? Promise.reject(new Error(this.#unjournaled)) : Promise.resolve();
    }
    if (this.#changed.size === 0) return this.#inFlight ?? Promise.resolve();
    if (this.#queued) return this.#queued;
    let written: () => void = () => undefined;
    let mine: Staged | undefined;
    const write = this.#table
      .write(
        () => {
          if (this.#queued === write) this.#queued = undefined;
          const others = this.#alongside?.();
          mine = this.changes();
          written = () => {
            others?.();
            mine?.reveal();
          };
        },
        (error) => {
          mine?.undo(error);
        },
      )
      .then(() => {
        written();
      });
    this.#queued = write;
    write.catch(() => {
      if (this.#queued === write) this.#queued = undefined;
    });
    return write;
  }

  /**
   * Within a write: issues SQL for changes not already in a pending write. Reveal once flushed,
   * or undo in the containing write's failure callback. Throws if the store journals nothing but
   * something changed.
   */
  changes(): Staged {
    if (this.#unjournaled !== undefined) {
      if (this.#lost) throw new Error(this.#unjournaled);
      return { reveal: () => undefined, undo: () => undefined };
    }
    const written = new Map(this.#changed);
    if (written.size > 0) this.#table.ensure(this.canvas);
    for (const id of written.keys()) {
      const kept = this.#kept.get(id);
      if (kept) this.#table.keep(kept);
      else this.#table.forget(id);
    }
    // B21 C6: the loop counts go in the same write; marked on disk only once it flushed.
    const also = this.#companion?.();
    if (written.size === 0)
      return {
        reveal: () => {
          also?.();
        },
        undo: () => undefined,
      };
    for (const id of written.keys()) this.#changed.delete(id);
    const flushed = Promise.withResolvers<undefined>();
    this.#inFlight = flushed.promise;
    // A containing write may be awaited directly, rather than through durable().
    void flushed.promise.catch(() => undefined);
    let settled = false;
    return {
      reveal: () => {
        if (settled) return;
        settled = true;
        also?.();
        if (this.#inFlight === flushed.promise) this.#inFlight = undefined;
        for (const [id, change] of written)
          if ((this.#changed.get(id) ?? Infinity) <= change) this.#changed.delete(id);
        flushed.resolve(undefined);
      },
      undo: (error) => {
        if (settled) return;
        settled = true;
        if (this.#inFlight === flushed.promise) this.#inFlight = undefined;
        for (const [id, change] of written)
          this.#changed.set(id, Math.max(change, this.#changed.get(id) ?? 0));
        flushed.reject(error ?? new Error('The message write failed.'));
      },
    };
  }

  /** Keeps a message as it is now, in its place in the order, and in `#active` if it belongs. */
  #set(kept: Kept): void {
    const { id } = kept.message;
    const before = this.#kept.get(id);
    this.#bytes += kept.bytes - (before?.bytes ?? 0);
    const was = before !== undefined && this.#prunable(before);
    const now = this.#prunable(kept);
    const same =
      was &&
      now &&
      before.seq === kept.seq &&
      before.message.from === kept.message.from &&
      before.message.to === kept.message.to;
    if (was && !same) this.#unsettle(before);
    this.#kept.set(id, kept);
    this.#indexRecord(before, kept);
    this.#indexResult(before, false);
    this.#indexResult(kept, true);
    if (now && !same) this.#settle(kept);
    if (before !== undefined && isSettled(before.message) !== isSettled(kept.message)) {
      for (const result of this.#results.get(id) ?? []) {
        const row = this.#kept.get(result);
        if (row === undefined || !prunable(row)) continue;
        if (isSettled(kept.message) && !this.#judging.has(id)) this.#settle(row);
        else this.#unsettle(row);
      }
    }
    this.#lineOf(before, kept);
    if (!isActive(kept.message)) {
      this.#active.delete(id);
    } else if (this.#active.has(id) || kept.seq > this.#activeLast) {
      // As kept now, in its place, or last.
      this.#active.set(id, kept);
      this.#activeLast = Math.max(this.#activeLast, kept.seq);
    } else {
      // Active again, behind one taken since: in its place.
      this.#active.set(id, kept);
      this.#active = new Map([...this.#active].sort(([, a], [, b]) => a.seq - b.seq));
    }
  }

  /** Keeps a message no more. */
  #delete(id: string): void {
    const kept = this.#kept.get(id);
    if (kept) {
      this.#bytes -= kept.bytes;
      if (this.#prunable(kept)) this.#unsettle(kept);
      this.#indexResult(kept, false);
      this.#indexRecord(kept, undefined);
    }
    this.#kept.delete(id);
    this.#active.delete(id);
    if (kept !== undefined) this.#lineOf(kept, undefined);
  }

  /**
   * B19 C2: keeps a message's recipient's line (`#activeTo`) as it is now (`kept`, none: gone), as
   * `#active` is kept: in its place, or last, or (active again behind one taken since) in order.
   */
  #lineOf(before: Kept | undefined, kept: Kept | undefined): void {
    const id = (kept ?? before)?.message.id;
    if (id === undefined) return;
    if (before !== undefined && before.message.to !== kept?.message.to) {
      const old = this.#activeTo.get(before.message.to);
      old?.line.delete(id);
      if (old?.line.size === 0) this.#activeTo.delete(before.message.to);
    }
    if (kept === undefined) return;
    const { to } = kept.message;
    let line = this.#activeTo.get(to);
    if (!isActive(kept.message)) {
      line?.line.delete(id);
      if (line?.line.size === 0) this.#activeTo.delete(to);
      return;
    }
    if (line === undefined) this.#activeTo.set(to, (line = { line: new Map(), last: 0 }));
    if (line.line.has(id) || kept.seq > line.last) {
      line.line.set(id, kept);
      line.last = Math.max(line.last, kept.seq);
    } else {
      line.line.set(id, kept);
      line.line = new Map([...line.line].sort(([, a], [, b]) => a.seq - b.seq));
    }
  }

  /**
   * B19 C3: keeps a record's place in its agent's window (`#records`) as it is now (`kept`, none:
   * gone), and notes each agent whose window that changed, told as its id is heard.
   */
  #indexRecord(before: Kept | undefined, kept: Kept | undefined): void {
    const at = kept ?? before;
    if (at === undefined) return;
    const { id } = at.message;
    const was = this.#recordOf.get(id);
    const now =
      kept?.about !== undefined && shownRecord(kept.message, kept.about, kept.owned === true)
        ? kept.about.agent
        : undefined;
    if (was === undefined && now === undefined) return;
    const shown = (agent: string) =>
      (this.#records.get(agent)?.newer(at.seq) ?? MAX_RECORD_ENTRIES) < MAX_RECORD_ENTRIES;
    if (was !== undefined && was !== now) {
      if (shown(was)) this.#windowChanged(was, id);
      const sequence = this.#records.get(was);
      sequence?.delete(at.seq);
      if (sequence?.weight === 0) this.#records.delete(was);
      this.#recordOf.delete(id);
    }
    if (now === undefined) return;
    if (was !== now) {
      let sequence = this.#records.get(now);
      if (sequence === undefined) this.#records.set(now, (sequence = new Sequence()));
      sequence.set(at.seq, id);
      this.#recordOf.set(id, now);
    }
    if (shown(now)) this.#windowChanged(now, id);
  }

  /** Agent `agent`'s window changed with message `id`'s change: read again, told as it is heard. */
  #windowChanged(agent: string, id: string): void {
    this.#windows.delete(agent);
    if (this.#recordWatchers.size === 0) return;
    const agents = this.#windowsChanged.get(id) ?? new Set<string>();
    agents.add(agent);
    this.#windowsChanged.set(id, agents);
  }

  #settle({ seq, message: { id, from, to } }: Kept): void {
    this.#settled.set(seq, id);
    this.#candidates.add(id);
    for (const party of new Set([from, to])) {
      let sequence = this.#parties.get(party);
      if (!sequence) {
        sequence = new Sequence();
        this.#parties.set(party, sequence);
      }
      sequence.set(seq, id, from === to ? 2 : 1);
      if (sequence.weight <= STORE_SETTLED_PER_PARTY) continue;
      // One new record moves at most two occurrences over the boundary (a self-send counts
      // twice). An older insertion may also be outside itself, hence id above. This covers bulk
      // load and staged records too, without walking the rest of this party's kept messages.
      for (const offset of [STORE_SETTLED_PER_PARTY, STORE_SETTLED_PER_PARTY + 1]) {
        const candidate = sequence.newest(offset);
        if (candidate !== undefined) this.#candidates.add(candidate);
      }
    }
  }

  #indexResult(kept: Kept | undefined, add: boolean): void {
    const message = kept?.message;
    if (message?.verdict === undefined || message.replyTo === undefined) return;
    const ids = this.#results.get(message.replyTo) ?? new Set<string>();
    if (add) ids.add(message.id);
    else ids.delete(message.id);
    if (ids.size === 0) this.#results.delete(message.replyTo);
    else this.#results.set(message.replyTo, ids);
  }

  #prunable(kept: Kept): boolean {
    if (!prunable(kept)) return false;
    const { verdict, replyTo } = kept.message;
    if (verdict !== undefined && replyTo !== undefined && this.#judging.has(replyTo)) return false;
    const turn = replyTo === undefined ? undefined : this.#kept.get(replyTo)?.message;
    return verdict === undefined || turn === undefined || isSettled(turn);
  }

  #unsettle({ seq, message: { id, from, to } }: Kept): void {
    this.#settled.delete(seq);
    this.#candidates.delete(id);
    for (const party of new Set([from, to])) {
      const sequence = this.#parties.get(party);
      sequence?.delete(seq);
      if (sequence?.weight === 0) this.#parties.delete(party);
    }
  }

  #keep(kept: Kept): void {
    const { message } = kept;
    this.#set({ ...kept, bytes: sizeOf(kept) });
    if (this.#unjournaled === undefined) this.#changed.set(message.id, ++this.#changes);
    else this.#lost = true;
    this.#prune();
    this.#changedId(message.id);
    if (this.#scheduled || this.#unjournaled !== undefined) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.durable().catch((error: unknown) => {
        console.error('Could not journal the canvas’s messages:', error);
      });
    });
  }

  /**
   * Keeps the newest settled messages of each party (a message counts for its sender and its
   * recipient) within the byte budget, and every message that isn't settled; the rows of those it
   * drops are deleted with the next write.
   */
  #prune(): void {
    for (const id of this.#candidates) {
      const kept = this.#kept.get(id);
      if (!kept || !this.#prunable(kept)) continue;
      const { from, to } = kept.message;
      const wanted = [from, to].some((party) => {
        const sequence = this.#parties.get(party);
        return (
          sequence !== undefined &&
          (sequence.weight <= STORE_SETTLED_PER_PARTY ||
            sequence.newer(kept.seq) < STORE_SETTLED_PER_PARTY)
        );
      });
      if (!wanted) this.#drop(id);
    }
    this.#candidates.clear();
    while (this.#bytes > STORE_BYTES) {
      const id = this.#settled.first();
      if (id === undefined) break; // Pending, unresolved and untold withdrawals are never dropped.
      this.#drop(id);
    }
  }

  #drop(id: string): void {
    this.#delete(id);
    if (this.#unjournaled === undefined) this.#changed.set(id, ++this.#changes);
    this.#changedId(id);
  }

  #changedId(id: string): void {
    for (const watcher of this.#watchers) watcher(id);
    const agents = this.#windowsChanged.get(id);
    if (agents === undefined) return;
    this.#windowsChanged.delete(id);
    for (const agent of agents) for (const watcher of this.#recordWatchers) watcher(agent);
  }
}

/** An untold withdrawal is protected even after its turn has settled. */
function prunable({ message, withdrawal }: Kept): boolean {
  return isSettled(message) && (withdrawal === undefined || withdrawal.told === true);
}

/**
 * Whether a message is one of the run's sends of a task's attempt (B11 Design §3): a text with a
 * task link, which only the runtime's mailbox gives a message (Engines), never a caller. The run
 * sends it and settles it; delivery never delivers, takes back or kills it as a party's. An answer
 * to an ask a task's attempt made carries its task too (B21 C7: a continuation), but is no send of
 * the run's: delivery delivers it, as the attempt's own turn. Nor is a message with a purpose (B19
 * C1): a queue hand-off, which delivery delivers, or its evidence, a record.
 */
export function sentByRun(message: Message): boolean {
  return (
    message.kind === 'text' &&
    message.task !== undefined &&
    message.ask === undefined &&
    message.purpose === undefined
  );
}

/**
 * Whether a message is the run's own work (B19 C1): one of its sends of a task's attempt, or a
 * queue hand-off, which delivery delivers but which its run owns. No party takes it back, no
 * sender is told of it, no loop counts it, and Stop, Kill and a restart treat it as the run's.
 */
export function runOwned(message: Message): boolean {
  return sentByRun(message) || isQueueHandoff(message);
}

/**
 * A text cut to the most a message holds (MAX_MESSAGE_BYTES), marked where it was cut as the
 * `whole` of it (a reply, a prompt) its transcript has.
 */
export function capBody(text: string, whole: 'reply' | 'prompt'): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_MESSAGE_BYTES) return text;
  const cut = `\n\n[corrallm: cut here; the whole ${whole} is in its transcript]`;
  const room = MAX_MESSAGE_BYTES - new TextEncoder().encode(cut).length;
  // Cut on a character's boundary: the decoder ends a character cut in two with U+FFFD, dropped
  // here.
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, room));
  return `${kept.replace(/�$/u, '')}${cut}`;
}

/**
 * Whether delivery still acts on a message: it waits, is being delivered, or is a turn to an agent
 * that goes on (delivered, not yet replied to: a text, an ask, an ask's end its asker is sent).
 * Delivery never acts on one settled or unresolved again.
 */
export function isActive(message: Message): boolean {
  const { state, to } = message;
  return (
    state === 'pending' ||
    state === 'delivering' ||
    (state === 'delivered' && isTurn(message) && agentOf(to) !== undefined)
  );
}

/**
 * What gave a cursor: `wait` (whose cursors `status` gives too, naming every canvas its caller
 * reaches), or `messages` (naming the one canvas it paged). `wait` takes only its own, since a
 * canvas its cursor doesn't name it reads from the start; `messages` reads its canvas's place in
 * either.
 */
export type CursorKind = 'wait' | 'messages';

/**
 * A cursor into canvases' stores, for `kind`: where a reader is in each, by canvas (the place of
 * the last message it read), opaque to it.
 */
export function cursorOf(kind: CursorKind, positions: Readonly<Record<string, number>>): string {
  return Buffer.from(JSON.stringify({ [kind]: positions })).toString('base64url');
}

/**
 * Where a cursor of one of `kinds` says a reader is in each canvas's store: undefined if it isn't
 * one, or another op gave it.
 */
export function readCursor(
  cursor: string,
  kinds: readonly CursorKind[],
): Readonly<Record<string, number>> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const kind = isRecord(value) ? kinds.find((one) => one in value) : undefined;
    const positions = isRecord(value) && kind !== undefined ? value[kind] : undefined;
    return isRecord(positions) &&
      Object.values(positions).every((seq) => Number.isSafeInteger(seq) && (seq as number) >= 0)
      ? (positions as Record<string, number>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** No agent's window holds a record. */
const NO_RECORDS: readonly RecordRow[] = Object.freeze([]);

/** How big a message's record is: what its byte budget counts. */
function sizeOf({ seq, message, origin, display, told, withdrawal, about }: Kept): number {
  return Buffer.byteLength(
    JSON.stringify({ seq, message, origin, display, told, withdrawal, about }),
  );
}

/** A row of `message`, read: undefined if it isn't one of the canvas's messages this code reads. */
function keptOf(row: Record<string, unknown>, canvas: CanvasId): Kept | undefined {
  const party = (v: unknown): v is PartyId => typeof v === 'string' && PARTY_PATTERN.test(v);
  const { seq, id, from_party: from, to_party: to, kind, origin, body, state, sent_at: at } = row;
  if (
    typeof seq !== 'number' ||
    typeof id !== 'string' ||
    !party(from) ||
    !party(to) ||
    !(MESSAGE_KINDS as readonly unknown[]).includes(kind) ||
    !(MESSAGE_ORIGINS as readonly unknown[]).includes(origin) ||
    !(MESSAGE_STATES as readonly unknown[]).includes(state) ||
    typeof body !== 'string' ||
    typeof at !== 'number'
  ) {
    return undefined;
  }
  const replyTo = row.reply_to;
  const resendOf = row.resend_of;
  const by = row.by_party;
  const display = row.display === null ? undefined : displayOf(parsed(row.display));
  if (display === null) return undefined;
  // A decision this code doesn't read (another version's, or one holding more than it may): the
  // row is left as it is.
  const decided =
    row.settled === null || row.settled === undefined
      ? undefined
      : Settled.safeParse(parsed(row.settled));
  if (decided?.success === false) return undefined;
  // An ask this code doesn't read (another version's): the row is left as it is too.
  const asked =
    row.ask === null || row.ask === undefined ? undefined : AskColumn.safeParse(parsed(row.ask));
  if (asked?.success === false) return undefined;
  // A verdict this code doesn't read (another version's): the row is left as it is too.
  const verdict =
    row.verdict === null || row.verdict === undefined
      ? undefined
      : Verdict.safeParse(parsed(row.verdict));
  if (verdict?.success === false) return undefined;
  // A purpose this code doesn't read (another version's): the row is left as it is too.
  const purpose =
    row.purpose === null || row.purpose === undefined
      ? undefined
      : Purpose.safeParse(parsed(row.purpose));
  if (purpose?.success === false) return undefined;
  // B19 C3: an association this code doesn't read (another version's) shows the record in no
  // window here; the row is read, and its column left as it is (no write changes it).
  const about =
    row.about === null || row.about === undefined
      ? undefined
      : RecordAbout.safeParse(parsed(row.about));
  const task = parsed(row.task);
  const turn = parsed(row.turn);
  const delivery = parsed(row.delivery);
  const withdrawal = parsed(row.withdrawal);
  const message = {
    id,
    canvas,
    from,
    to,
    kind,
    body,
    ...(typeof replyTo === 'string' ? { replyTo } : {}),
    ...(typeof resendOf === 'string' ? { resendOf } : {}),
    ...(task === undefined ? {} : { task }),
    ...(turn === undefined ? {} : { turn }),
    state,
    ...(delivery === undefined ? {} : { delivery }),
    ...(party(by) ? { by } : {}),
    ...(decided === undefined ? {} : { settled: decided.data }),
    ...(asked === undefined ? {} : { ask: asked.data }),
    ...(verdict === undefined ? {} : { verdict: verdict.data }),
    ...(purpose === undefined ? {} : { purpose: purpose.data }),
    at,
  } as unknown as Message;
  const kept: Kept = {
    seq,
    message,
    bytes: 0,
    origin: origin as MessageOrigin,
    ...(display === undefined ? {} : { display }),
    ...(about?.success === true ? { about: about.data } : {}),
    ...(typeof row.told === 'string' ? { told: row.told } : {}),
    ...(withdrawal !== undefined && typeof withdrawal.text === 'string'
      ? {
          withdrawal: {
            text: withdrawal.text,
            ...(withdrawal.told === true ? { told: true } : {}),
          },
        }
      : {}),
  };
  return { ...kept, bytes: sizeOf(kept) };
}

/**
 * What a view shows of a message, as its row holds it: null if it holds anything else, so that the
 * row is one this code doesn't read (left as it is).
 */
function displayOf(value: Record<string, unknown> | undefined): MessageDisplay | null {
  if (value === undefined) return null;
  const { after, task, text, images, requiresImages, via, ...others } = value;
  const ok =
    Object.keys(others).length === 0 &&
    (via === undefined || via === 'manager') &&
    (after === undefined || typeof after === 'string') &&
    (text === undefined || typeof text === 'string') &&
    (images === undefined || (Number.isSafeInteger(images) && (images as number) >= 0)) &&
    (requiresImages === undefined || requiresImages === true) &&
    (task === undefined ||
      (isRecord(task) &&
        Object.keys(task).length === 2 &&
        typeof task.agent === 'string' &&
        typeof task.item === 'string'));
  return ok ? value : null;
}

/** A JSON column's object, if it holds one. */
function parsed(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const object: unknown = JSON.parse(value);
    return isRecord(object) ? object : undefined;
  } catch {
    return undefined;
  }
}

/** A value as a JSON column holds it: none for none. */
function json(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why something failed, as a sentence quotes it. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
