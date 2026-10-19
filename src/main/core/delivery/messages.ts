import { randomUUID } from 'node:crypto';

import { STORE_BYTES, STORE_SETTLED_PER_PARTY } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import {
  isSettled,
  MESSAGE_KINDS,
  MESSAGE_STATES,
  PARTY_PATTERN,
} from '../../../shared/model/messages';
import type { Message, PartyId } from '../../../shared/model/messages';

/*
 * A canvas's messages, as the core keeps them (API Spec §5.3, Core Server §5.9): in memory, in the
 * order they came, and journaled to runs/<id>/messages.jsonl through the run journal's one queue,
 * a line for each message each time it changes ({ seq, message, told? }, the last line of a
 * message winning). Its order (`seq`) survives restarts, so a cursor into it does too. It keeps the newest
 * STORE_SETTLED_PER_PARTY settled messages of each party within STORE_BYTES, and every pending and
 * unresolved one, dropping the oldest settled first (delivery bounds how many wait: MAX_WAITING),
 * and writes its log anew once what it appended since it last did outgrows both what it kept then
 * and STORE_BYTES. It never throws: what it can't write it says on the console, except where a
 * caller asks for its record on disk (`durable`), which rejects then; and once a write fails, the
 * next writes the log anew, whole (a line a failed append tore included). A torn last line of its
 * log is left out, and written out of the log as it loads (or with the next write, if that fails);
 * a log broken before that is set aside, and written anew from the records that could be read, the
 * store's order going on past it; a message that waited with no record read after the broken line
 * is never sent. A log it can't read, or a broken one it can't set aside, is left as it is, for
 * corrallm to read when it opens the canvas again: the store starts empty and journals nothing
 * meanwhile, so `durable` rejects, and nothing is sent without its record.
 */

/** Where the store's log is written: the run journal's, by canvas. */
export interface MessageLog {
  readMessages(canvas: CanvasId): Promise<string | undefined>;
  appendMessages(canvas: CanvasId, text: string, durable: boolean): Promise<void>;
  rewriteMessages(canvas: CanvasId, text: string): Promise<void>;
  setAsideMessages(canvas: CanvasId): Promise<string>;
}

/** A message to add: the store gives it its id, its canvas and when it was sent. */
export type Draft = Omit<Message, 'id' | 'canvas' | 'at'>;

/**
 * A message as the store keeps it: its place in the store's order, how big its record is, and, for
 * a notice, what it told (its key: Delivery tells each thing once, across restarts too).
 */
interface Kept {
  seq: number;
  message: Message;
  bytes: number;
  told?: string;
}

export class MessageStore {
  readonly canvas: CanvasId;
  readonly #log: MessageLog;
  readonly #now: () => number;
  /** Every message kept, by id, in the store's order. */
  #kept = new Map<string, Kept>();
  /** What hears each message added. */
  readonly #listeners = new Set<(message: Message) => void>();
  /** The last place given in the store's order. */
  #seq = 0;
  /** Records changed since the log was last written to, in order. */
  #pending: string[] = [];
  #scheduled = false;
  /** Each write, after the one before it. */
  #writing: Promise<void> = Promise.resolve();
  /** How many bytes the log holds. */
  #size = 0;
  /** How many of them it held when it was last written whole (or read): what the store kept then. */
  #compacted = 0;
  /** Whether something was written to the log since it was last forced to disk. */
  #unsynced = false;
  /** Whether the log may lack what the store keeps, or hold a torn line: written whole next. */
  #broken = false;
  /** Why the store journals nothing, if it can't: its log is left as it was. */
  #unjournaled: string | undefined;
  /** Whether anything changed that wasn't journaled, as the store journals nothing. */
  #lost = false;
  /** Why the store couldn't read all of its log as it loaded, if it couldn't. */
  warning: string | undefined;
  /**
   * The messages that waited in a log set aside as broken, as the store loaded, whose last record
   * that could be read came before a line that couldn't be: what became of each since is unknown
   * (it may have been sent), so delivery never sends them.
   */
  doubtful: ReadonlySet<string> = new Set();

  constructor(canvas: CanvasId, log: MessageLog, now: () => number) {
    this.canvas = canvas;
    this.#log = log;
    this.#now = now;
  }

  /**
   * Reads what the log keeps of the canvas's messages. A last line torn as it was written (or that
   * lost its newline) is written out of the log before anything is appended after it, which would
   * otherwise join it on one line. A log broken before its last line is set aside, and written
   * anew from the records that could be read; a message that waited with no record read after the
   * broken line is `doubtful`. Either way the store's order goes on past every place a line of the
   * log gave. Never rejects.
   */
  async load(): Promise<void> {
    let text: string | undefined;
    try {
      text = await this.#log.readMessages(this.canvas);
    } catch (error) {
      this.#journalNothing(`The canvas’s messages could not be read (${reason(error)})`);
      return;
    }
    if (text === undefined) return;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const read = new Map<string, Kept>();
    /** The line each message's last record was read from. */
    const lastLine = new Map<string, number>();
    let torn = text !== '' && !text.endsWith('\n');
    /**
     * The last line before the last that isn't a record, if one isn't: the log is broken in the
     * middle, and a message's records after its last one read may be lost there.
     */
    let broken: number | undefined;
    for (const [i, line] of lines.entries()) {
      const kept = this.#record(line);
      // A cursor may point at any place the log gave, read or not.
      this.#seq = Math.max(this.#seq, kept?.seq ?? placeIn(line));
      if (kept) {
        read.set(kept.message.id, kept);
        lastLine.set(kept.message.id, i);
      } else if (i < lines.length - 1) broken = i;
      else torn = true;
    }
    this.#kept = new Map([...read].sort(([, a], [, b]) => a.seq - b.seq));
    if (broken !== undefined) {
      try {
        const where = await this.#log.setAsideMessages(this.canvas);
        this.warning = `The canvas’s messages could not all be read, and were moved to ${where}.`;
      } catch (error) {
        this.#kept = new Map();
        this.#journalNothing(
          `The canvas’s messages could not be read, nor moved aside (${reason(error)})`,
        );
        return;
      }
      // A message's later records always come after its earlier ones: one whose last record read
      // comes after the last broken line lost none there.
      this.doubtful = new Set(
        this.all()
          .filter(({ id, state }) => state === 'pending' && (lastLine.get(id) ?? 0) < broken)
          .map(({ id }) => id),
      );
      // The log is written anew from what was read.
      torn = true;
    }
    this.#prune();
    if (!torn) {
      this.#size = Buffer.byteLength(text);
      this.#compacted = [...this.#kept.values()].reduce((sum, { bytes }) => sum + bytes, 0);
      return;
    }
    const whole = this.#whole();
    try {
      await this.#log.rewriteMessages(this.canvas, whole);
      this.#size = this.#compacted = Buffer.byteLength(whole);
    } catch (error) {
      console.error('Could not write the canvas’s messages anew:', error);
      this.#broken = true;
    }
  }

  /** Every message kept, in the store's order. */
  all(): Message[] {
    return [...this.#kept.values()].map(({ message }) => message);
  }

  get(id: string): Message | undefined {
    return this.#kept.get(id)?.message;
  }

  /** A message's place in the store's order, if it is kept. */
  seqOf(id: string): number | undefined {
    return this.#kept.get(id)?.seq;
  }

  /** The place of the last message added: a cursor there reads only what comes later. */
  end(): number {
    return this.#seq;
  }

  /**
   * Adds a message, journaled after everything before it: as kept. `told`: for a notice, the key
   * of what it tells, kept with it.
   */
  add(draft: Draft, told?: string): Message {
    const message: Message = { id: randomUUID(), canvas: this.canvas, ...draft, at: this.#now() };
    this.#keep({ seq: ++this.#seq, message, bytes: 0, ...(told === undefined ? {} : { told }) });
    for (const listener of this.#listeners) listener(message);
    return message;
  }

  /** Hears each message added from now on, as it is kept (a `wait` wakes on it). */
  subscribe(listener: (message: Message) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
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

  /** Changes a message: as kept, or undefined if it isn't kept (any more). */
  update(id: string, change: Partial<Omit<Message, 'id' | 'canvas'>>): Message | undefined {
    const kept = this.#kept.get(id);
    if (!kept) return undefined;
    const message = { ...kept.message, ...change };
    this.#keep({ ...kept, message });
    return message;
  }

  /** Resolves once every change so far is on disk (forced there); rejects if it couldn't be. */
  durable(): Promise<void> {
    return this.#write(true);
  }

  #keep(kept: Kept): void {
    const line = lineOf(kept);
    this.#kept.set(kept.message.id, { ...kept, bytes: Buffer.byteLength(line) });
    this.#pending.push(line);
    this.#prune();
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.#write(false).catch((error: unknown) => {
          console.error('Could not journal the canvas’s messages:', error);
        });
      });
    }
  }

  /** Writes out what changed, once every write before it is done. */
  #write(durable: boolean): Promise<void> {
    const write = this.#writing.then(() => this.#flush(durable));
    this.#writing = write.catch(() => undefined);
    return write;
  }

  /**
   * Writes out what changed: appended to the log (forced to disk if `durable`), or, once a write
   * before failed or what was appended since the log was last written whole outgrows both what the
   * store kept then and its byte budget, the log written anew, whole (so that a store keeping more
   * than its budget, all of it waiting, still appends between its rewrites). A store that journals
   * nothing writes nothing, and rejects `durable` once anything has changed.
   */
  async #flush(durable: boolean): Promise<void> {
    const text = this.#pending.join('');
    this.#pending = [];
    if (this.#unjournaled !== undefined) {
      this.#lost ||= text !== '';
      if (durable && this.#lost) throw new Error(this.#unjournaled);
      return;
    }
    if (!this.#broken && text === '' && (!durable || !this.#unsynced)) return;
    const bytes = Buffer.byteLength(text);
    try {
      const appended = this.#size + bytes - this.#compacted;
      if (!this.#broken && appended <= Math.max(this.#compacted, STORE_BYTES)) {
        await this.#log.appendMessages(this.canvas, text, durable);
        this.#size += bytes;
      } else {
        const whole = this.#whole();
        await this.#log.rewriteMessages(this.canvas, whole);
        this.#size = this.#compacted = Buffer.byteLength(whole);
        if (durable) await this.#log.appendMessages(this.canvas, '', true);
        this.#broken = false;
      }
      this.#unsynced = !durable;
    } catch (error) {
      // The log may lack what this was to write, or hold a line it tore: written whole next.
      this.#broken = true;
      throw error;
    }
  }

  /** The store journals nothing, saying why (`what`), and leaves its log as it is. */
  #journalNothing(what: string): void {
    this.#unjournaled = `${what}, so none can be sent until corrallm opens the canvas again.`;
    this.warning = this.#unjournaled;
  }

  /** The log as the store keeps it now: a line for each message. */
  #whole(): string {
    return [...this.#kept.values()].map(lineOf).join('');
  }

  /**
   * Keeps the newest settled messages of each party (a message counts for its sender and its
   * recipient) within the byte budget, and every message that isn't settled.
   */
  #prune(): void {
    const kept = [...this.#kept.values()];
    const counts = new Map<PartyId, number>();
    const dropped = new Set<string>();
    for (const { message } of kept.toReversed()) {
      if (!isSettled(message)) continue;
      const parties = [message.from, message.to];
      const wanted = parties.some((party) => (counts.get(party) ?? 0) < STORE_SETTLED_PER_PARTY);
      for (const party of parties) counts.set(party, (counts.get(party) ?? 0) + 1);
      if (!wanted) dropped.add(message.id);
    }
    let bytes = kept.reduce((sum, one) => (dropped.has(one.message.id) ? sum : sum + one.bytes), 0);
    for (const { message, bytes: size } of kept) {
      if (bytes <= STORE_BYTES) break;
      if (dropped.has(message.id) || !isSettled(message)) continue;
      dropped.add(message.id);
      bytes -= size;
    }
    for (const id of dropped) this.#kept.delete(id);
  }

  /** A line of the log, read: undefined if it isn't one of this canvas's records. */
  #record(line: string): Kept | undefined {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(value) || !Number.isSafeInteger(value.seq) || !isRecord(value.message)) {
      return undefined;
    }
    const message = value.message;
    const party = (v: unknown) => typeof v === 'string' && PARTY_PATTERN.test(v);
    if (
      typeof message.id !== 'string' ||
      message.canvas !== this.canvas ||
      !party(message.from) ||
      !party(message.to) ||
      !(MESSAGE_KINDS as readonly unknown[]).includes(message.kind) ||
      !(MESSAGE_STATES as readonly unknown[]).includes(message.state) ||
      typeof message.body !== 'string' ||
      typeof message.at !== 'number'
    ) {
      return undefined;
    }
    return {
      seq: value.seq as number,
      message: message as unknown as Message,
      bytes: Buffer.byteLength(line) + 1,
      ...(typeof value.told === 'string' ? { told: value.told } : {}),
    };
  }
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

/** A message's line in the store's log. */
function lineOf({ seq, message, told }: Kept): string {
  return `${JSON.stringify({ seq, message, ...(told === undefined ? {} : { told }) })}\n`;
}

/** The place in the store's order a line of its log gives, though it isn't a record it reads. */
function placeIn(line: string): number {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && Number.isSafeInteger(value.seq) ? (value.seq as number) : 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why something failed, as a sentence quotes it. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
