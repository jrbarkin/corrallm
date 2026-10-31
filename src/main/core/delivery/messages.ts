import { randomUUID } from 'node:crypto';

import {
  MAX_MESSAGE_BYTES,
  STORE_BYTES,
  STORE_SETTLED_PER_PARTY,
} from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import {
  agentOf,
  isSettled,
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
import type { CanvasMemory } from '../../memory';
import type { Database } from '../store/store';
import { Sequence } from './sequence';

/*
 * A canvas's messages, as the core keeps them (API Spec §5.3, Core Server §5.9): in memory, in the
 * order they came, and in the profile's database (Core Database §5), each a row of `message`, with
 * the key of what it tells, for a notice (`told`), the note its recipient must still be told of
 * a withdrawal (`withdrawal`), how it came to be (`origin`, which its caller says, never a party:
 * B11 Design §3) and what a view shows of it beside its body (`display`). Their order (`seq`) is one every canvas's messages share, whose
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
}

/** A message to add: the store gives it its id, its canvas and when it was sent. */
export type Draft = Omit<Message, 'id' | 'canvas' | 'at'> & Provenance;

/**
 * What a write staged with what else it writes: told once the write's commit returned, or undone if
 * it failed.
 */
export interface Staged {
  reveal(): void;
  undo(): void;
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
           task, turn, state, delivery, by_party, sent_at, told, withdrawal
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
  write<T>(write: () => T): Promise<T> {
    return this.#store.write(write);
  }

  /** Within a write: gives the canvas its row, if it has none, for its messages to refer to. */
  ensure(canvas: CanvasId): void {
    this.#memory.ensure(canvas);
  }

  /**
   * Within a write: a message's row, as kept (each column written by name, so that what a newer
   * corrallm keeps beside them stays).
   */
  keep({ seq, message, origin, display, told, withdrawal }: Kept): void {
    this.#store
      .prepare(
        `INSERT INTO message (seq, id, canvas_id, from_party, to_party, kind, origin, body, display,
           reply_to, resend_of, task, turn, state, delivery, by_party, sent_at, told, withdrawal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           body = excluded.body, display = excluded.display, reply_to = excluded.reply_to,
           task = excluded.task, turn = excluded.turn, state = excluded.state,
           delivery = excluded.delivery, by_party = excluded.by_party, told = excluded.told,
           withdrawal = excluded.withdrawal`,
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
  /** Only records eligible for pruning: globally, and by both parties, in original order. */
  readonly #settled = new Sequence();
  readonly #parties = new Map<PartyId, Sequence>();
  /** Records that may just have fallen outside both parties’ newest-message quotas. */
  readonly #candidates = new Set<string>();
  #bytes = 0;
  /** What hears each message added. */
  readonly #listeners = new Set<(message: Message) => void>();
  /** What hears each message kept, changed or no longer kept (its id): the topics' source. */
  readonly #watchers = new Set<(id: string) => void>();
  /**
   * The messages changed (or deleted) whose rows aren't on disk as they are yet, each with the
   * number of its last change: a write marks a row on disk only if it has not changed since.
   */
  readonly #changed = new Map<string, number>();
  #changes = 0;
  #scheduled = false;
  /** The write queued that hasn't run yet: it writes every change made before it runs. */
  #queued: Promise<void> | undefined;
  /** What its canvas writes with its changes, within the same write. */
  #alongside: (() => () => void) | undefined;
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
   * Every message kept that delivery still acts on (isActive), in the store's order: those waiting,
   * being delivered, or whose turn goes on.
   */
  active(): Message[] {
    return Array.from(this.#active.values(), ({ message }) => message);
  }

  get(id: string): Message | undefined {
    return this.#kept.get(id)?.message;
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
  add({ origin, display, ...draft }: Draft, told?: string): Message {
    const message: Message = { id: randomUUID(), canvas: this.canvas, ...draft, at: this.#now() };
    const seq = this.#unjournaled === undefined ? this.#table.place() : ++this.#seq;
    this.#keep({
      seq,
      message,
      bytes: 0,
      origin,
      ...(display === undefined ? {} : { display }),
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
  stageWithin({ origin, display, ...draft }: Draft): Staged & { message: Message } {
    if (this.#unjournaled !== undefined) throw new Error(this.#unjournaled);
    const message: Message = { id: randomUUID(), canvas: this.canvas, ...draft, at: this.#now() };
    const kept: Kept = {
      seq: this.#table.place(),
      message,
      bytes: 0,
      origin,
      ...(display === undefined ? {} : { display }),
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
    const message = { ...kept.message, ...change };
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
   * Resolves once every change so far is on disk, with what its canvas writes with it; rejects if
   * it couldn't be.
   */
  durable(): Promise<void> {
    if (this.#unjournaled !== undefined) {
      return this.#lost ? Promise.reject(new Error(this.#unjournaled)) : Promise.resolve();
    }
    if (this.#changed.size === 0) return Promise.resolve();
    if (this.#queued) return this.#queued;
    let written: () => void = () => undefined;
    const write = this.#table
      .write(() => {
        if (this.#queued === write) this.#queued = undefined;
        const others = this.#alongside?.();
        const mine = this.changes();
        written = () => {
          others?.();
          mine();
        };
      })
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
   * Within a write: writes every change whose row isn't on disk as it is now; returns what marks
   * them on disk once the write's commit returned. Throws if the store journals nothing but
   * something changed.
   */
  changes(): () => void {
    if (this.#unjournaled !== undefined) {
      if (this.#lost) throw new Error(this.#unjournaled);
      return () => undefined;
    }
    const written = new Map(this.#changed);
    if (written.size > 0) this.#table.ensure(this.canvas);
    for (const id of written.keys()) {
      const kept = this.#kept.get(id);
      if (kept) this.#table.keep(kept);
      else this.#table.forget(id);
    }
    return () => {
      for (const [id, change] of written) {
        if (this.#changed.get(id) === change) this.#changed.delete(id);
      }
    };
  }

  /** Keeps a message as it is now, in its place in the order, and in `#active` if it belongs. */
  #set(kept: Kept): void {
    const { id } = kept.message;
    const before = this.#kept.get(id);
    this.#bytes += kept.bytes - (before?.bytes ?? 0);
    const was = before !== undefined && prunable(before);
    const now = prunable(kept);
    const same =
      was &&
      now &&
      before.seq === kept.seq &&
      before.message.from === kept.message.from &&
      before.message.to === kept.message.to;
    if (was && !same) this.#unsettle(before);
    this.#kept.set(id, kept);
    if (now && !same) this.#settle(kept);
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
      if (prunable(kept)) this.#unsettle(kept);
    }
    this.#kept.delete(id);
    this.#active.delete(id);
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
      if (!kept || !prunable(kept)) continue;
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
  }
}

/** An untold withdrawal is protected even after its turn has settled. */
function prunable({ message, withdrawal }: Kept): boolean {
  return isSettled(message) && (withdrawal === undefined || withdrawal.told === true);
}

/**
 * Whether a message is one of the run's sends of a task's attempt (B11 Design §3): a text with a
 * task link, which only the runtime's mailbox gives a message (Engines), never a caller. The run
 * sends it and settles it; delivery never delivers, takes back or kills it as a party's.
 */
export function sentByRun(message: Message): boolean {
  return message.kind === 'text' && message.task !== undefined;
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
 * Whether delivery still acts on a message: it waits, is being delivered, or is a text to an agent
 * whose turn goes on (delivered, not yet replied to). Delivery never acts on one settled or
 * unresolved again.
 */
export function isActive({ state, kind, to }: Message): boolean {
  return (
    state === 'pending' ||
    state === 'delivering' ||
    (state === 'delivered' && kind === 'text' && agentOf(to) !== undefined)
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

/** How big a message's record is: what its byte budget counts. */
function sizeOf({ seq, message, origin, display, told, withdrawal }: Kept): number {
  return Buffer.byteLength(JSON.stringify({ seq, message, origin, display, told, withdrawal }));
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
    at,
  } as unknown as Message;
  const kept: Kept = {
    seq,
    message,
    bytes: 0,
    origin: origin as MessageOrigin,
    ...(display === undefined ? {} : { display }),
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
  const { after, task, text, images, requiresImages, ...others } = value;
  const ok =
    Object.keys(others).length === 0 &&
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
