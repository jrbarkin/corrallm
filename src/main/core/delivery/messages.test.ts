import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORE_BYTES, STORE_SETTLED_PER_PARTY } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { MESSAGE_KINDS, MESSAGE_STATES } from '../../../shared/model/messages';
import type { Message } from '../../../shared/model/messages';
import { CanvasMemory } from '../../memory';
import { STORE_FILE } from '../store/open';
import { settleRestored } from '../store/restored';
import { connect } from '../store/sqlite';
import { SYSTEM_DEPS, unopened } from '../store/store';
import type { Store, StoreDeps } from '../store/store';
import { openTestStore, readOnDisk, refuseWrites } from '../store/test-store';
import { isActive, MessageStore, MessageTable } from './messages';
import { scanPrune } from './test-prune';
import type { PruneRecord } from './test-prune';

/*
 * A canvas's messages, kept in memory and in the profile's database: a row of `message` each, in
 * an order every canvas's messages share, written with the database's next commit.
 */

const CANVAS = '0b8c6f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e' as CanvasId;
const OTHER = '0b8c6f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5f' as CanvasId;

let profile: string;
let database: Store;
let table: MessageTable;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-messages-'));
  database = await openTestStore(profile);
  table = new MessageTable(database, new CanvasMemory(database));
});

afterEach(async () => {
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

/** Closes the database and opens it again, as the core does when it starts again. */
async function restart(deps?: StoreDeps): Promise<void> {
  await database.close();
  database = await openTestStore(profile, deps);
  table = new MessageTable(database, new CanvasMemory(database));
}

/** A store of a canvas's messages, loaded from what the database keeps. */
async function store(canvas = CANVAS): Promise<MessageStore> {
  const loaded = new MessageStore(canvas, table, () => 1000);
  await loaded.load();
  return loaded;
}

/** A message from `from` to `to`, in `state`. */
function draft(
  from: Message['from'],
  to: Message['to'],
  state: Message['state'] = 'pending',
  body = 'Hello',
): Omit<Message, 'id' | 'canvas' | 'at'> {
  return { from, to, kind: 'text', body, state };
}

/** The canvas's messages' rows on disk, as a second connection reads them, in order. */
const rows = (canvas = CANVAS) =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare(
        'SELECT seq, id, state, delivery, told, withdrawal FROM message WHERE canvas_id = ? ORDER BY seq',
      )
      .all(canvas),
  );

describe('the message store', () => {
  it('keeps a stalled turn’s told key after receipt, settlement and a restart', async () => {
    const messages = await store();
    const sent = messages.add(draft('outside:orchestrator', 'agent:builder', 'delivered'));
    const key = `stalled:${sent.id}`;
    messages.add(
      {
        from: 'corrallm',
        to: sent.from,
        kind: 'notice',
        body: 'No activity',
        replyTo: sent.id,
        state: 'delivered',
      },
      key,
    );
    expect(messages.hasTold(key)).toBe(true);
    messages.update(sent.id, { state: 'unresolved' });
    await messages.durable();
    await restart();
    const restored = await store();
    expect(restored.hasTold(key)).toBe(true);
    expect(restored.hasTold('stalled:another')).toBe(false);
  });
  it('keeps each message as it changes, in the order they came, across a restart', async () => {
    const first = await store();
    const one = first.add(draft('outside:orchestrator', 'agent:builder'));
    const two = first.add(draft('you', 'agent:checker'));
    first.update(one.id, { state: 'delivering', delivery: { at: 1000, as: 'as-1', attempt: 1 } });
    await first.durable();
    await restart();

    const again = await store();
    expect(again.all().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: one.id, state: 'delivering' },
      { id: two.id, state: 'pending' },
    ]);
    expect(again.get(one.id)).toEqual({ ...first.get(one.id), at: 1000 });
    expect(again.get(two.id)).toEqual(first.get(two.id));
    // The store's order survives the restart: a message added now comes after both.
    const three = again.add(draft('agent:builder', 'outside:orchestrator', 'delivered'));
    expect(again.seqOf(three.id)).toBeGreaterThan(again.seqOf(two.id) ?? Infinity);
  });

  it('has each message’s row on disk as it is, its note and what it told with it, once durable() resolves', async () => {
    const messages = await store();
    const sent = messages.add(draft('outside:orchestrator', 'agent:builder'));
    const notice = messages.add(
      {
        from: 'corrallm',
        to: 'outside:orchestrator',
        kind: 'notice',
        body: 'Paused',
        state: 'delivered',
        replyTo: sent.id,
      },
      'paused:builder',
    );
    messages.update(sent.id, { state: 'withdrawn', by: 'outside:orchestrator' }, 'Taken back.');
    let seen: unknown;
    await messages.durable().then(() => {
      seen = rows();
    });
    expect(seen).toEqual([
      {
        seq: messages.seqOf(sent.id),
        id: sent.id,
        state: 'withdrawn',
        delivery: null,
        told: null,
        withdrawal: '{"text":"Taken back."}',
      },
      {
        seq: messages.seqOf(notice.id),
        id: notice.id,
        state: 'delivered',
        delivery: null,
        told: 'paused:builder',
        withdrawal: null,
      },
    ]);
  });

  it('reads back messages to and from an agent whose id holds a line break', async () => {
    const messages = await store();
    const to = messages.add(draft('outside:orchestrator', 'agent:two\nlines'));
    const from = messages.add(draft('agent:two\nlines', 'outside:orchestrator', 'delivered'));
    const after = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    await restart();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([to.id, from.id, after.id]);
    expect(again.warning).toBeUndefined();
  });

  it('numbers every canvas’s messages in one order, never giving a place again, though the newest are deleted', async () => {
    const one = await store(CANVAS);
    const other = await store(OTHER);
    const first = one.add(draft('outside:orchestrator', 'agent:builder'));
    const second = other.add(draft('outside:orchestrator', 'agent:builder'));
    const third = one.add(draft('outside:orchestrator', 'agent:builder'));
    const place = one.seqOf(first.id) ?? 0;
    const places = [one.seqOf(first.id), other.seqOf(second.id), one.seqOf(third.id)];
    expect(places).toEqual([place, place + 1, place + 2]);
    expect(one.end()).toBe(place + 2);
    expect(other.end()).toBe(place + 2);
    await Promise.all([one.durable(), other.durable()]);
    // The newest deleted, as a canvas forgotten deletes them.
    database.tx(() => database.prepare('DELETE FROM message WHERE id = ?').run(third.id));
    await restart();

    const again = await store(CANVAS);
    expect(again.end()).toBeGreaterThanOrEqual(place + 2);
    const next = again.add(draft('outside:orchestrator', 'agent:builder'));
    expect(again.seqOf(next.id)).toBeGreaterThan(place + 2);
  });

  it('never gives a place again, though a crash cut off the rows it was given to', async () => {
    // Ahead of the clock the store opened with: each open numbers places on from its clock.
    let clock = Date.now() + 3_600_000;
    const deps = { ...SYSTEM_DEPS, now: () => clock };
    await restart(deps);
    // Given, and named by a cursor at once (`status` gives the last place given), but no row was
    // written with them before the core stopped.
    const given = [table.place(), table.place(), table.place()];
    clock += 60_000;
    await restart(deps);
    expect(table.place()).toBeGreaterThan(Math.max(...given));
  });

  it('keeps the newest settled messages per party, and every pending and unresolved one, deleting the rest', async () => {
    const messages = await store();
    const pending = messages.add(draft('outside:orchestrator', 'agent:builder'));
    const unresolved = messages.add(draft('outside:orchestrator', 'agent:builder', 'unresolved'));
    const settled = Array.from({ length: STORE_SETTLED_PER_PARTY + 5 }, () =>
      messages.add(draft('agent:builder', 'outside:orchestrator', 'delivered')),
    );
    const ids = messages.all().map(({ id }) => id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(unresolved.id);
    // The oldest settled ones went first.
    expect(ids).not.toContain(settled[0]?.id);
    expect(ids).toContain(settled.at(-1)?.id);
    expect(ids.filter((id) => settled.some((one) => one.id === id))).toHaveLength(
      STORE_SETTLED_PER_PARTY,
    );
    await messages.durable();
    expect(rows().map(({ id }) => id)).toEqual(ids);
  });

  it('keeps an untold withdrawal through pruning, until its note reaches the agent', async () => {
    const messages = await store();
    const withdrawn = messages.add(draft('outside:orchestrator', 'agent:builder'));
    messages.update(withdrawn.id, { state: 'withdrawn' }, 'The instruction was withdrawn.');
    for (let i = 0; i < STORE_SETTLED_PER_PARTY + 5; i++) {
      messages.add(draft('outside:orchestrator', 'agent:builder', 'withdrawn'));
    }
    await messages.durable();
    await restart();
    const again = await store();
    expect(again.withdrawals('agent:checker')).toEqual([]);
    expect(again.withdrawals('agent:builder')).toEqual([
      { id: withdrawn.id, text: 'The instruction was withdrawn.' },
    ]);
    expect(again.get(withdrawn.id)?.state).toBe('withdrawn');
    again.toldWithdrawals([withdrawn.id]);
    await again.durable();
    await restart();
    const told = await store();
    expect(told.withdrawals('agent:builder')).toEqual([]);
    expect(told.get(withdrawn.id)).toBeUndefined();
    expect(rows().map(({ id }) => id)).not.toContain(withdrawn.id);
  });

  it('keeps within its byte budget, dropping the oldest settled first, and never throws', async () => {
    const messages = await store();
    const big = 'x'.repeat(16 * 1024);
    const pending = messages.add(draft('outside:a', 'agent:builder', 'pending', big));
    const parties = Array.from({ length: 400 }, (_, i) => `outside:p${String(i)}` as const);
    const settled = parties.map((party) =>
      messages.add(draft('agent:builder', party, 'delivered', big)),
    );
    const bytes = messages
      .all()
      .reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0);
    expect(bytes).toBeLessThanOrEqual(STORE_BYTES);
    expect(bytes).toBeGreaterThan(STORE_BYTES - 2 * (big.length + 1024));
    const ids = messages.all().map(({ id }) => id);
    expect(ids[0]).toBe(pending.id);
    expect(ids).not.toContain(settled[0]?.id);
    expect(ids.at(-1)).toBe(settled.at(-1)?.id);
    await messages.durable();
    expect(rows().map(({ id }) => id)).toEqual(ids);
  });

  it('writes nothing for a canvas with no messages, not even the canvas', async () => {
    const messages = await store();
    expect(messages.all()).toEqual([]);
    await messages.durable();
    expect(readOnDisk(profile, (disk) => disk.prepare('SELECT id FROM canvas').all())).toEqual([]);
  });

  it('leaves a row it doesn’t read as it is', async () => {
    const messages = await store();
    const read = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    // A kind a newer corrallm knows.
    database.tx(() =>
      database
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, body, state, sent_at)
           VALUES ('newer', ?, 'you', 'agent:builder', 'poll', 'Which?', 'pending', 1)`,
        )
        .run(CANVAS),
    );
    await restart();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([read.id]);
    again.add(draft('outside:orchestrator', 'agent:builder'));
    await again.durable();
    expect(rows().map(({ id }) => id)).toContain('newer');
  });

  it('writes what its canvas writes with it in the same write, or neither', async () => {
    const messages = await store();
    let fail = false;
    const marked: string[] = [];
    messages.writeWith(() => {
      database.prepare('UPDATE canvas SET project = ? WHERE id = ?').run('/beside', CANVAS);
      if (fail) throw new Error('The run is too large');
      return () => marked.push('beside');
    });
    messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    expect(marked).toEqual(['beside']);
    fail = true;
    const second = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await expect(messages.durable()).rejects.toThrow('The run is too large');
    expect(rows().map(({ id }) => id)).not.toContain(second.id);
    fail = false;
    await messages.durable();
    expect(rows().map(({ id }) => id)).toContain(second.id);
    expect(marked).toEqual(['beside', 'beside']);
  });

  it('stages a record within another write: on disk with it, in its place, told once it returned', async () => {
    const messages = await store();
    const heard: string[] = [];
    messages.subscribe((message) => heard.push(message.id));
    const before = messages.add(draft('you', 'agent:builder'));
    await messages.durable();
    let staged: ReturnType<MessageStore['stageWithin']> | undefined;
    await database.write(() => {
      database.prepare('UPDATE canvas SET project = ? WHERE id = ?').run('/beside', CANVAS);
      staged = messages.stageWithin(draft('corrallm', 'outside:orchestrator', 'delivered'));
      // Kept in its place at once, so no reader reads past it; not yet told.
      expect(messages.seqOf(staged.message.id)).toBeGreaterThan(messages.seqOf(before.id) ?? 0);
      expect(heard).toEqual([before.id]);
    });
    staged?.reveal();
    expect(heard).toEqual([before.id, staged?.message.id]);
    expect(rows().map(({ id }) => id)).toEqual([before.id, staged?.message.id]);
    // Nothing more to write of it.
    await messages.durable();
    expect(rows()).toHaveLength(2);
  });

  it('stages nothing a failed write held: undone, it is gone', async () => {
    const messages = await store();
    let staged: ReturnType<MessageStore['stageWithin']> | undefined;
    await expect(
      database.write(() => {
        staged = messages.stageWithin(draft('corrallm', 'outside:orchestrator', 'delivered'));
        throw new Error('The settlement failed');
      }),
    ).rejects.toThrow('The settlement failed');
    staged?.undo();
    expect(messages.all()).toEqual([]);
    await messages.durable();
    expect(rows()).toEqual([]);
  });
});

describe('incremental pruning', () => {
  it(
    'keeps exactly the scan algorithm’s set through seeded changes, restarts, restores and staged rollbacks',
    { timeout: 30_000 },
    async () => {
      let seed = 0x54b;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const pick = <T>(values: readonly T[]): T =>
        values[Math.floor(random() * values.length)] as T;
      const parties = [
        'you',
        'corrallm',
        'agent:a',
        'agent:b',
        'outside:one',
        'outside:two',
      ] as const;
      let messages = await store();
      let expected = new Map<string, PruneRecord>();
      const dropped = { quota: 0, bytes: 0 };
      const prune = () => {
        const next = scanPrune(expected);
        dropped.quota += next.quota;
        dropped.bytes += next.bytes;
      };
      const check = () => {
        expect(messages.all().map(({ id }) => id)).toEqual([...expected.keys()]);
        expect(messages.active()).toEqual(messages.all().filter(isActive));
      };
      const keepAdded = (message: Message, told?: string) => {
        expected.set(message.id, {
          seq: table.last(),
          message,
          ...(told === undefined ? {} : { told }),
        });
        prune();
        check();
      };
      // Enough settled traffic to cross both quotas, including the double count for self-sends.
      for (let i = 0; i < 240; i++) {
        const from = i % 3 === 0 ? 'you' : 'outside:one';
        const message = messages.add(draft(from, i % 2 === 0 ? from : 'outside:two', 'replied'));
        keepAdded(message);
      }
      const seen = new Set<number>();
      for (let step = 0; step < 800; step++) {
        const ids = [...expected.keys()];
        const roll = Math.floor(random() * 10);
        seen.add(roll);
        if (roll < 3 || ids.length === 0) {
          const from = pick(parties);
          const told = random() < 0.2 ? `told:${String(step)}` : undefined;
          const message = messages.add(
            {
              ...draft(
                from,
                random() < 0.2 ? from : pick(parties),
                pick(MESSAGE_STATES),
                random() < 0.15 ? '😀'.repeat(32_000) : 'Hello',
              ),
              kind: pick(MESSAGE_KINDS),
            },
            told,
          );
          keepAdded(message, told);
        } else if (roll < 6) {
          const id = pick(ids);
          const old = expected.get(id);
          if (!old) throw new Error('The reference lost its message');
          const withdrawal = random() < 0.2 ? 'Withdrawn after receipt' : undefined;
          const message = messages.update(
            id,
            {
              state: pick(MESSAGE_STATES),
              from: pick(parties),
              to: pick(parties),
              kind: pick(MESSAGE_KINDS),
              body: random() < 0.2 ? '界'.repeat(50_000) : 'Changed',
            },
            withdrawal,
          );
          if (!message) throw new Error('The store lost its message');
          expected.set(id, {
            ...old,
            message,
            ...(withdrawal === undefined ? {} : { withdrawal: { text: withdrawal } }),
          });
          prune();
        } else if (roll === 6) {
          for (const id of [pick(ids), pick(ids)]) {
            messages.toldWithdrawals([id]);
            const old = expected.get(id);
            if (old?.withdrawal && !old.withdrawal.told) {
              expected.set(id, { ...old, withdrawal: { ...old.withdrawal, told: true } });
              prune();
            }
          }
        } else if (roll === 7) {
          const fails = random() < 0.5;
          const staged: ReturnType<MessageStore['stageWithin']>[] = [];
          const writing = database.write(() => {
            for (let i = 0; i < 3; i++) {
              const one = messages.stageWithin(
                draft(pick(parties), pick(parties), pick(MESSAGE_STATES)),
              );
              staged.push(one);
              expected.set(one.message.id, { seq: table.last(), message: one.message });
              check();
            }
            if (fails) throw new Error('The staged settlement failed');
          });
          if (fails) await expect(writing).rejects.toThrow('The staged settlement failed');
          else await writing;
          for (const one of staged.toReversed()) {
            if (fails) {
              one.undo();
              expected.delete(one.message.id);
            } else {
              one.reveal();
              prune();
            }
            check();
          }
        } else {
          await messages.durable();
          if (roll === 9) {
            await database.close();
            const writer = connect(path.join(profile, STORE_FILE));
            try {
              writer.exec('BEGIN');
              settleRestored(writer, 1000);
              writer.exec('COMMIT');
            } finally {
              writer.close();
            }
          }
          await restart();
          // The unpruned SQL input, not the optimized load's output. Restores change pending rows
          // and add notices; rows also retain the original, immutable sender/recipient/kind.
          const parsed = (value: unknown): unknown => {
            if (typeof value !== 'string') throw new Error('The SQL JSON column was not text');
            const object: unknown = JSON.parse(value);
            return object;
          };
          expected = new Map(
            table.rows(CANVAS).map((row) => {
              const message: Message = {
                id: row.id as string,
                canvas: CANVAS,
                from: row.from_party as Message['from'],
                to: row.to_party as Message['to'],
                kind: row.kind as Message['kind'],
                body: row.body as string,
                state: row.state as Message['state'],
                at: row.sent_at as number,
                ...(row.reply_to === null ? {} : { replyTo: row.reply_to as string }),
                ...(row.turn === null
                  ? {}
                  : { turn: parsed(row.turn) as NonNullable<Message['turn']> }),
                ...(row.delivery === null
                  ? {}
                  : { delivery: parsed(row.delivery) as NonNullable<Message['delivery']> }),
                ...(row.by_party === null ? {} : { by: row.by_party as Message['from'] }),
              };
              const record: PruneRecord = {
                seq: row.seq as number,
                message,
                ...(row.told === null ? {} : { told: row.told as string }),
                ...(row.withdrawal === null
                  ? {}
                  : {
                      withdrawal: parsed(row.withdrawal) as NonNullable<PruneRecord['withdrawal']>,
                    }),
              };
              return [message.id, record];
            }),
          );
          prune();
          messages = await store();
        }
        check();
      }
      expect(seen.size).toBe(10);
      expect(dropped.quota).toBeGreaterThan(0);
      expect(dropped.bytes).toBeGreaterThan(0);
      await messages.durable();
      expect(rows().map(({ id }) => id)).toEqual([...expected.keys()]);
    },
  );
});

describe('what delivery acts on', () => {
  /** What `active()` must list: the messages kept that delivery acts on, in the store's order. */
  const expectIndexed = (messages: MessageStore) => {
    expect(messages.active()).toEqual(messages.all().filter(isActive));
  };

  it('lists the messages waiting, being delivered or whose turn goes on, as they change', async () => {
    const messages = await store();
    const one = messages.add(draft('outside:orchestrator', 'agent:builder'));
    const yours = messages.add(draft('you', 'agent:checker'));
    const record = messages.add({ ...draft('corrallm', 'outside:orchestrator'), kind: 'notice' });
    messages.update(record.id, { state: 'delivered' });
    const ids = () => messages.active().map(({ id }) => id);
    expect(ids()).toEqual([one.id, yours.id]);
    messages.update(one.id, {
      state: 'delivering',
      delivery: { at: 1000, as: 'as-1', attempt: 1 },
    });
    messages.update(one.id, { state: 'delivered' });
    // Its turn goes on: still delivery's.
    expect(ids()).toEqual([one.id, yours.id]);
    expect(messages.active()[0]).toBe(messages.get(one.id));
    messages.update(one.id, { state: 'replied' });
    messages.update(yours.id, { state: 'withdrawn', by: 'you' }, 'Taken back.');
    expect(ids()).toEqual([]);
    // Back to waiting, it is in its place again, ahead of one sent since.
    const later = messages.add(draft('outside:orchestrator', 'agent:builder'));
    messages.update(one.id, { state: 'pending' });
    expect(ids()).toEqual([one.id, later.id]);
    expectIndexed(messages);
  });

  it(
    'agrees with what it keeps through any sequence of changes, restarts and restores',
    { timeout: 30_000 },
    async () => {
      // A fixed seed: the same sequence every run.
      let seed = 0x5eed;
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
      const parties = [
        'you',
        'corrallm',
        'agent:builder',
        'agent:checker',
        'outside:orchestrator',
        'outside:other',
      ] as const;
      const agents = ['agent:builder', 'agent:checker'] as const;
      const states = [...MESSAGE_STATES, 'pending', 'pending', 'delivering', 'delivered'] as const;
      let messages = await store();
      for (let step = 0; step < 600; step++) {
        const ids = messages.all().map(({ id }) => id);
        const roll = random();
        if (roll < 0.34 || ids.length === 0) {
          // Sent: mostly to an agent, waiting.
          messages.add({
            ...draft(pick(parties), random() < 0.8 ? pick(agents) : pick(parties), pick(states)),
            kind: random() < 0.8 ? 'text' : pick(MESSAGE_KINDS),
          });
        } else if (roll < 0.72) {
          // Delivered, ended, withdrawn (with a note), cut off, or back to waiting.
          messages.update(
            pick(ids),
            { state: pick(states) },
            random() < 0.1 ? 'Withdrawn after it reached you.' : undefined,
          );
        } else if (roll < 0.77) {
          messages.toldWithdrawals([pick(ids), pick(ids)]);
        } else if (roll < 0.87) {
          // Settled traffic enough to prune the oldest settled.
          for (let i = 0; i < 40; i++) {
            messages.add(draft(pick(agents), 'outside:orchestrator', 'delivered'));
          }
        } else if (roll < 0.95) {
          // Staged within another write: revealed once it committed, or undone as it failed.
          const fails = random() < 0.5;
          let staged: ReturnType<MessageStore['stageWithin']> | undefined;
          await database
            .write(() => {
              staged = messages.stageWithin(draft(pick(parties), pick(agents), pick(states)));
              if (fails) throw new Error('The settlement failed');
            })
            .catch(() => undefined);
          if (fails) staged?.undo();
          else staged?.reveal();
        } else if (roll < 0.98) {
          // A restart: read back from its rows.
          await messages.durable();
          await restart();
          messages = await store();
        } else {
          // A restore from a snapshot, which settles what waited there.
          await messages.durable();
          await database.close();
          const writer = connect(path.join(profile, STORE_FILE));
          try {
            writer.exec('BEGIN');
            settleRestored(writer, 1000);
            writer.exec('COMMIT');
          } finally {
            writer.close();
          }
          await restart();
          messages = await store();
        }
        expectIndexed(messages);
      }
      // It went through each kind of change, and kept enough to prune.
      expect(messages.all().length).toBeGreaterThan(STORE_SETTLED_PER_PARTY);
      expect(messages.active().length).toBeGreaterThan(0);
    },
  );
});

describe('the message store, when its database fails', () => {
  it('starts empty, journaling nothing, when the database couldn’t be opened', async () => {
    const blind = new MessageStore(
      CANVAS,
      new MessageTable(unopened('The core’s database could not be opened (disk I/O error).'), {
        ensure: () => undefined,
      }),
      () => 1000,
    );
    await blind.load();
    expect(blind.all()).toEqual([]);
    expect(blind.warning).toBe(
      'The canvas’s messages could not be read (The core’s database could not be opened (disk I/O error).), so none can be sent until corrallm opens the canvas again.',
    );
    // Nothing it can't journal is sent: durable() refuses once anything has changed.
    await blind.durable();
    const message = blind.add(draft('outside:orchestrator', 'agent:builder'));
    expect(blind.seqOf(message.id)).toBe(1);
    await expect(blind.durable()).rejects.toThrow(/could not be read/);
    expect(() => blind.changes()).toThrow(/could not be read/);
  });

  it('fails durable() when its commit fails, and writes what that commit lost with the next', async () => {
    const messages = await store();
    const first = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    const allow = refuseWrites(profile, 'message', 'The disk is full');
    messages.update(first.id, { state: 'withdrawn', by: 'outside:orchestrator' });
    try {
      await expect(messages.durable()).rejects.toThrow('The disk is full');
    } finally {
      allow();
    }
    expect(rows().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: first.id, state: 'pending' },
    ]);
    const next = messages.add(draft('outside:orchestrator', 'agent:checker'));
    await messages.durable();
    expect(rows().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: first.id, state: 'withdrawn' },
      { id: next.id, state: 'pending' },
    ]);
  });
});
