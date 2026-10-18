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
 * a line for each message each time it changes ({ seq, message }, the last line of a message
 * winning). Its order (`seq`) survives restarts, so a cursor into it does too. It keeps the newest
 * STORE_SETTLED_PER_PARTY settled messages of each party within STORE_BYTES, and every pending and
 * unresolved one, dropping the oldest settled first, and writes its log anew once it has grown past
 * what it keeps. It never throws: what it can't write it says on the console, except where a
 * caller asks for its record on disk (`durable`), which rejects then. A torn last line of its log is
 * left out, and written out of the log as it loads; a log broken before that is set aside, and the
 * store starts empty.
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

/** A message as the store keeps it: its place in the store's order, and how big its record is. */
interface Kept {
  seq: number;
  message: Message;
  bytes: number;
}

export class MessageStore {
  readonly canvas: CanvasId;
  readonly #log: MessageLog;
  readonly #now: () => number;
  /** Every message kept, by id, in the store's order. */
  #kept = new Map<string, Kept>();
  /** The last place given in the store's order. */
  #seq = 0;
  /** Records changed since the log was last written to, in order. */
  #pending: string[] = [];
  #scheduled = false;
  /** How many bytes the log has had appended since it was last written whole. */
  #grown = 0;
  /** Whether something was written to the log since it was last forced to disk. */
  #unsynced = false;
  readonly #listeners = new Set<() => void>();
  /** Why the store started empty, if its log was set aside as it loaded. */
  warning: string | undefined;

  constructor(canvas: CanvasId, log: MessageLog, now: () => number) {
    this.canvas = canvas;
    this.#log = log;
    this.#now = now;
  }

  /**
   * Reads what the log keeps of the canvas's messages. A last line torn as it was written (or that
   * lost its newline) is written out of the log before anything is appended after it, which would
   * otherwise join it on one line.
   */
  async load(): Promise<void> {
    const text = await this.#log.readMessages(this.canvas);
    if (text === undefined) return;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const read = new Map<string, Kept>();
    let torn = text !== '' && !text.endsWith('\n');
    for (const [i, line] of lines.entries()) {
      const kept = this.#record(line);
      if (kept) {
        read.set(kept.message.id, kept);
        this.#seq = Math.max(this.#seq, kept.seq);
      } else if (i < lines.length - 1) {
        const where = await this.#log.setAsideMessages(this.canvas);
        this.warning = `The canvas’s messages could not be read, and were moved to ${where}.`;
        this.#seq = 0;
        return;
      } else {
        torn = true;
      }
    }
    this.#kept = new Map([...read].sort(([, a], [, b]) => a.seq - b.seq));
    this.#prune();
    if (!torn) {
      this.#grown = Buffer.byteLength(text);
      return;
    }
    const whole = this.#whole();
    this.#grown = Buffer.byteLength(whole);
    await this.#log.rewriteMessages(this.canvas, whole);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

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

  /** Adds a message, journaled after everything before it: as kept. */
  add(draft: Draft): Message {
    const message: Message = { id: randomUUID(), canvas: this.canvas, ...draft, at: this.#now() };
    this.#keep({ seq: ++this.#seq, message, bytes: 0 });
    return message;
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
    const line = `${JSON.stringify({ seq: kept.seq, message: kept.message })}\n`;
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
    for (const listener of this.#listeners) listener();
  }

  /**
   * Writes out what changed: appended to the log (forced to disk if `durable`), or, once the log
   * has grown past what the store keeps, the log written anew with only that.
   */
  async #write(durable: boolean): Promise<void> {
    const text = this.#pending.join('');
    this.#pending = [];
    if (text === '' && (!durable || !this.#unsynced)) return;
    this.#unsynced = !durable;
    this.#grown += Buffer.byteLength(text);
    if (this.#grown <= STORE_BYTES) {
      await this.#log.appendMessages(this.canvas, text, durable);
      return;
    }
    const whole = this.#whole();
    this.#grown = Buffer.byteLength(whole);
    await this.#log.rewriteMessages(this.canvas, whole);
    if (durable) await this.#log.appendMessages(this.canvas, '', true);
  }

  /** The log as the store keeps it now: a line for each message. */
  #whole(): string {
    return [...this.#kept.values()]
      .map(({ seq, message }) => `${JSON.stringify({ seq, message })}\n`)
      .join('');
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
    };
  }
}

/**
 * A cursor into canvases' stores: where a reader is in each, by canvas (the place of the last
 * message it read), opaque to it.
 */
export function cursorOf(positions: Readonly<Record<string, number>>): string {
  return Buffer.from(JSON.stringify(positions)).toString('base64url');
}

/** Where a cursor says a reader is in each canvas's store: undefined if it isn't one. */
export function readCursor(cursor: string): Readonly<Record<string, number>> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return isRecord(value) && Object.values(value).every((seq) => Number.isSafeInteger(seq))
      ? (value as Record<string, number>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
