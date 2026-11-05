import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { STORE_BYTES, STORE_SETTLED_PER_PARTY } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import {
  isHandoffEvidence,
  isMessageToYou,
  isQueueHandoff,
  isSettled,
  isTurn,
  MESSAGE_KINDS,
  MESSAGE_STATES,
} from '../../../shared/model/messages';
import type { Message } from '../../../shared/model/messages';
import { AskColumn, AskSettlement } from '../../../shared/model/asks';
import { Purpose } from '../../../shared/model/purpose';
import { MAX_RECORD_ENTRIES, RecordAbout } from '../../../shared/model/records';
import { Verdict } from '../../../shared/model/results';
import { SettledDecision } from '../../../shared/model/settled';
import { CanvasMemory } from '../../memory';
import { STORE_FILE } from '../store/open';
import { settleRestored } from '../store/restored';
import { connect } from '../store/sqlite';
import { Store, SYSTEM_DEPS, unopened } from '../store/store';
import type { StoreDeps } from '../store/store';
import { openTestStore, readOnDisk, refuseWrites, writeOnDisk } from '../store/test-store';
import { isActive, MessageStore, MessageTable, runOwned, sentByRun } from './messages';
import type { Draft, Staged } from './messages';
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
let sequenceWork: Promise<void> | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-messages-'));
  database = await openTestStore(profile);
  table = new MessageTable(database, new CanvasMemory(database));
});

afterEach(async () => {
  // Vitest aborts a timed-out test, but does not await its callback. The seeded loops check
  // that signal after every I/O boundary; drain them before another fixture owns these names.
  await sequenceWork?.catch(() => undefined);
  sequenceWork = undefined;
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

function sequence(run: () => Promise<void>): Promise<void> {
  sequenceWork = run();
  return sequenceWork;
}

/** Closes the database and opens it again, as the core does when it starts again. */
async function restart(deps?: StoreDeps, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const previous = database;
  const folder = profile;
  await previous.close();
  signal?.throwIfAborted();
  const opened = await openTestStore(folder, deps);
  if (signal?.aborted) {
    await opened.close();
    signal.throwIfAborted();
  }
  database = opened;
  table = new MessageTable(database, new CanvasMemory(database));
}

/** A store of a canvas's messages, loaded from what the database keeps. */
async function store(canvas = CANVAS): Promise<MessageStore> {
  const loaded = new MessageStore(canvas, table, () => 1000);
  await loaded.load();
  return loaded;
}

/** A message from `from` to `to`, in `state`: yours as you typed it, or a party's. */
function draft(
  from: Message['from'],
  to: Message['to'],
  state: Message['state'] = 'pending',
  body = 'Hello',
): Draft {
  return { from, to, kind: 'text', origin: from === 'you' ? 'manual' : 'party', body, state };
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
  it('writes each changed row once across containing savepoints before their log flush', async () => {
    const gate = Promise.withResolvers<undefined>();
    let held = false;
    await restart({
      ...SYSTEM_DEPS,
      flush: async (fd) => {
        if (held) await gate.promise;
        await SYSTEM_DEPS.flush(fd);
      },
    });
    const messages = await store();
    for (let i = 0; i < STORE_SETTLED_PER_PARTY; i++)
      messages.add(draft('agent:builder', 'outside:orchestrator', 'delivered'));
    await messages.durable();
    const keep = vi.spyOn(table, 'keep');
    const forget = vi.spyOn(table, 'forget');
    const pending: Promise<void>[] = [];
    held = true;
    try {
      // Several containing savepoints may stage rows in one commit, all still unflushed.
      const staged: Staged[] = [];
      pending.push(
        database
          .write(() => {
            for (let i = 0; i < 6; i++) {
              messages.add(draft('agent:builder', 'outside:orchestrator', 'delivered'));
              staged.push(database.tx(() => messages.changes()));
            }
          })
          .then(() => {
            for (const change of staged) change.reveal();
          }),
      );
      await vi.waitFor(() => {
        expect(keep).toHaveBeenCalledTimes(6);
      });
      expect(keep).toHaveBeenCalledTimes(6);
      expect(forget).toHaveBeenCalledTimes(6);
      let durable = false;
      pending.push(
        messages.durable().then(() => {
          durable = true;
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(durable).toBe(false);
    } finally {
      held = false;
      gate.resolve(undefined);
      await Promise.all(pending);
    }
    expect(rows()).toHaveLength(STORE_SETTLED_PER_PARTY);
  });

  it('retries message rows from a failed containing savepoint in the next queued write', async () => {
    const messages = await store();
    const message = messages.add(draft('outside:orchestrator', 'agent:builder'));
    let staged: Staged | undefined;
    const failed = database.write(
      () => {
        staged = messages.changes();
        throw new Error('The containing write failed');
      },
      (error) => {
        staged?.undo(error);
      },
    );
    const retry = messages.durable();
    await expect(failed).rejects.toThrow('The containing write failed');
    await retry;
    expect(rows().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: message.id, state: 'pending' },
    ]);
  });
  it('keeps a stalled turn’s told key after receipt, settlement and a restart', async () => {
    const messages = await store();
    const sent = messages.add(draft('outside:orchestrator', 'agent:builder', 'delivered'));
    const key = `stalled:${sent.id}`;
    messages.add(
      {
        from: 'corrallm',
        to: sent.from,
        kind: 'notice',
        origin: 'party',
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
        origin: 'party',
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
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
             sent_at)
           VALUES ('newer', ?, 'you', 'agent:builder', 'poll', 'manual', 'Which?', 'pending', 1)`,
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

  it('keeps how each message came to be, what a view shows of it and what it resends, across a restart', async () => {
    const messages = await store();
    const original = messages.add(draft('you', 'agent:builder', 'replied'));
    const resent = messages.add({
      ...draft('you', 'agent:builder'),
      origin: 'resend',
      display: { images: 2, requiresImages: true },
      resendOf: original.id,
    });
    const party = messages.add(draft('outside:orchestrator', 'agent:builder'));
    expect(messages.redisplay(original.id, { after: 'plan' })).toBe(true);
    await messages.durable();
    await restart();
    const again = await store();
    expect(again.all()).toEqual([original, resent, party]);
    expect(again.all().map(({ id }) => again.originOf(id))).toEqual(['manual', 'resend', 'party']);
    expect(again.displayOf(original.id)).toEqual({ after: 'plan' });
    expect(again.requiresImages(resent)).toBe(true);
    expect(again.requiresImages(original)).toBe(false);
    expect(again.resent(original.id)).toBe(true);
    expect(again.resent(resent.id)).toBe(false);
    expect(resent.replyTo).toBeUndefined();
  });

  it('keeps a record’s settled decision with it across a restart, never changing it after', async () => {
    const messages = await store();
    const settled = SettledDecision.parse({
      v: 1,
      need: 'prompt/builder/2/0f1e2d3c-4b5a-4968-8776-655443322110',
      prompt: { id: '0f1e2d3c-4b5a-4968-8776-655443322110', kind: 'approval', subject: 'tool' },
      outcome: { type: 'choice', value: 'allow', hint: 'allow_once' },
    });
    const record = messages.add({
      from: 'corrallm',
      to: 'you',
      kind: 'settled',
      origin: 'party',
      body: 'You allowed Builder’s tool call once.',
      state: 'delivering',
      by: 'you',
      settled,
    });
    await messages.durable();
    messages.update(record.id, { state: 'delivered' });
    await messages.durable();
    await restart();
    const again = await store();
    expect(again.get(record.id)).toEqual({ ...record, state: 'delivered' });
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT settled FROM message WHERE id = ?').get(record.id),
      ),
    ).toEqual({ settled: JSON.stringify(settled) });
  });

  it('keeps an ask’s questions and its answer’s answers, and its settlement once it ends, never changing either after', async () => {
    const messages = await store();
    const ask = AskColumn.parse({
      v: 1,
      type: 'question',
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          text: 'How much?',
          options: [{ label: 'All' }, { label: 'Some' }],
          multiple: false,
          other: false,
        },
      ],
      deadline: 90_000,
    });
    const asked = messages.add({
      from: 'agent:planner',
      to: 'agent:builder',
      kind: 'prompt',
      origin: 'party',
      body: 'Planner asks: Scope',
      state: 'pending',
      ask,
    });
    await messages.durable();
    // Settled as it ends, with its answer in the same write.
    const settled = AskSettlement.parse({
      v: 1,
      ask: { questions: 1 },
      outcome: { type: 'answers', count: 1 },
    });
    messages.update(asked.id, { state: 'answered', by: 'agent:builder', settled });
    const answer = messages.add({
      from: 'agent:builder',
      to: 'agent:planner',
      kind: 'text',
      origin: 'party',
      body: 'Scope: All',
      replyTo: asked.id,
      state: 'pending',
      ask: { v: 1, type: 'answer', of: asked.id, answers: { scope: { picked: ['All'] } } },
    });
    await messages.durable();
    // A later change of the row never writes another settlement over it.
    messages.update(asked.id, {
      settled: { v: 1, ask: { questions: 1 }, outcome: { type: 'expired' } },
    });
    await messages.durable();
    await restart();
    const again = await store();
    expect(again.get(asked.id)).toEqual({
      ...asked,
      state: 'answered',
      by: 'agent:builder',
      settled,
    });
    expect(again.get(answer.id)).toEqual(answer);
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT ask, settled FROM message WHERE id = ?').get(asked.id),
      ),
    ).toEqual({ ask: JSON.stringify(ask), settled: JSON.stringify(settled) });
  });

  it('leaves a row whose ask it doesn’t read as it is', async () => {
    const messages = await store();
    const read = messages.add(draft('you', 'agent:builder'));
    await messages.durable();
    database.tx(() =>
      database
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
             sent_at, ask)
           VALUES ('newer ask', ?, 'agent:a', 'agent:b', 'prompt', 'party', 'Asks', 'pending', 1,
             '{"v":2,"type":"question"}')`,
        )
        .run(CANVAS),
    );
    await restart();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([read.id]);
    again.add(draft('outside:orchestrator', 'agent:builder'));
    await again.durable();
    expect(rows().map(({ id }) => id)).toContain('newer ask');
  });

  it('keeps a result’s verdict with its row, never changing it after, and leaves one it can’t read as it is', async () => {
    const messages = await store();
    const verdict = Verdict.parse({ v: 1, outcome: 'failed', summary: 'Two tests fail.' });
    const result = messages.add({
      from: 'agent:builder',
      to: 'corrallm',
      kind: 'result',
      origin: 'party',
      body: 'Failed: Two tests fail.',
      task: { agent: 'builder', item: 'tests', attempt: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' },
      state: 'delivered',
      verdict,
    });
    await messages.durable();
    // A later change of the row never writes another verdict over it.
    messages.update(result.id, { verdict: { ...verdict, outcome: 'succeeded' } });
    await messages.durable();
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT verdict FROM message WHERE id = ?').get(result.id),
      ),
    ).toEqual({ verdict: JSON.stringify(verdict) });
    // One a newer corrallm might keep: read as nothing, and left as it is.
    writeOnDisk(
      profile,
      `UPDATE message SET verdict = '${JSON.stringify({ v: 2, outcome: 'partial' })}' WHERE id = '${result.id}'`,
    );
    await restart();
    const again = await store();
    expect(again.get(result.id)).toBeUndefined();
  });

  it('keeps a queue hand-off’s purpose and its evidence’s with their rows, never changing either after, and leaves one it can’t read as it is', async () => {
    const messages = await store();
    const task = {
      agent: 'lead',
      item: 'handoff',
      attempt: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    };
    const handoff = messages.add({
      from: 'agent:lead',
      to: 'agent:builder',
      kind: 'text',
      origin: 'run',
      body: 'Build it',
      task,
      state: 'pending',
      purpose: Purpose.parse({ v: 1, type: 'handoff' }),
    });
    await messages.durable();
    messages.update(handoff.id, {
      state: 'replied',
      turn: { status: 'completed', reason: 'completed' },
    });
    const evidence = messages.add({
      from: 'agent:builder',
      to: 'agent:lead',
      kind: 'text',
      origin: 'run',
      body: 'Built.',
      replyTo: handoff.id,
      task,
      turn: { status: 'completed', reason: 'completed' },
      state: 'delivered',
      purpose: Purpose.parse({ v: 1, type: 'evidence' }),
    });
    await messages.durable();
    // A later change of the row never writes another purpose over it, nor gives one in memory.
    messages.update(handoff.id, { purpose: { v: 1, type: 'evidence' } });
    expect(messages.get(handoff.id)?.purpose).toEqual({ v: 1, type: 'handoff' });
    const party = messages.add({
      from: 'agent:lead',
      to: 'agent:builder',
      kind: 'text',
      origin: 'party',
      body: 'Plain',
      state: 'pending',
    });
    messages.update(party.id, { purpose: { v: 1, type: 'handoff' } });
    expect(messages.get(party.id)).not.toHaveProperty('purpose');
    await messages.durable();
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT purpose FROM message WHERE id = ?').get(handoff.id),
      ),
    ).toEqual({ purpose: JSON.stringify({ v: 1, type: 'handoff' }) });
    await restart();
    const again = await store();
    expect(again.get(handoff.id)).toEqual({
      ...handoff,
      state: 'replied',
      turn: { status: 'completed', reason: 'completed' },
    });
    expect(again.get(evidence.id)).toEqual(evidence);
    // One a newer corrallm might keep: read as nothing, and left as it is.
    writeOnDisk(
      profile,
      `UPDATE message SET purpose = '${JSON.stringify({ v: 2, type: 'copy' })}' WHERE id = '${evidence.id}'`,
    );
    await restart();
    const later = await store();
    expect(later.get(evidence.id)).toBeUndefined();
    expect(later.get(handoff.id)).toBeDefined();
  });

  it('never drops an open ask, or your message waiting on you, past its party’s quota', async () => {
    const messages = await store();
    const ask = messages.add({
      from: 'agent:planner',
      to: 'you',
      kind: 'prompt',
      origin: 'party',
      body: 'Planner asks: Scope',
      state: 'delivered',
      ask: AskColumn.parse({
        v: 1,
        type: 'question',
        questions: [
          { id: 'q', header: 'Q', text: 'Why?', options: [], multiple: false, other: true },
        ],
        deadline: 90_000,
      }),
    });
    const toYou = messages.add(draft('agent:planner', 'you', 'delivered'));
    // Settled messages enough to push both past the planner's quota and yours.
    for (let i = 0; i < STORE_SETTLED_PER_PARTY + 2; i++)
      messages.add(draft('you', 'agent:planner', 'replied'));
    expect(messages.get(ask.id)).toBeDefined();
    expect(messages.get(toYou.id)).toBeDefined();
    // Once you dismiss it, it is a record like any other.
    messages.update(toYou.id, { state: 'answered', by: 'you' });
    messages.add(draft('you', 'agent:planner', 'replied'));
    expect(messages.get(toYou.id)).toBeUndefined();
    expect(messages.get(ask.id)).toBeDefined();
  });

  it('leaves a row whose settled decision it doesn’t read as it is', async () => {
    const messages = await store();
    const read = messages.add(draft('you', 'agent:builder'));
    await messages.durable();
    // A decision a newer corrallm might keep, and one that would hold a value.
    for (const [id, settled] of [
      ['newer', '{"v":2,"need":"prompt/b/1/x"}'] as const,
      [
        'valued',
        JSON.stringify({
          v: 1,
          need: 'prompt/b/1/0f1e2d3c-4b5a-4968-8776-655443322110',
          prompt: { id: '0f1e2d3c-4b5a-4968-8776-655443322110', kind: 'approval' },
          outcome: { type: 'choice', value: 'allow', hint: 'allow_once', label: 'Run rm -rf' },
        }),
      ] as const,
    ]) {
      database.tx(() =>
        database
          .prepare(
            `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
               sent_at, settled)
             VALUES (?, ?, 'corrallm', 'you', 'settled', 'party', 'Decided', 'delivered', 1, ?)`,
          )
          .run(id, CANVAS, settled),
      );
    }
    await restart();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([read.id]);
    again.add(draft('outside:orchestrator', 'agent:builder'));
    await again.durable();
    expect(rows().map(({ id }) => id)).toEqual(expect.arrayContaining(['newer', 'valued']));
  });

  it('leaves a row whose display it doesn’t know as it is', async () => {
    const messages = await store();
    const read = messages.add(draft('you', 'agent:builder'));
    await messages.durable();
    // A field of a display a newer corrallm might keep.
    database.tx(() =>
      database
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, display,
             state, sent_at)
           VALUES ('newer display', ?, 'you', 'agent:builder', 'text', 'manual', 'Hello',
             '{"after":"plan","colour":"red"}', 'pending', 1)`,
        )
        .run(CANVAS),
    );
    await restart();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([read.id]);
    again.add(draft('outside:orchestrator', 'agent:builder'));
    await again.durable();
    expect(rows().map(({ id }) => id)).toContain('newer display');
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
  for (const initialSeed of process.env.CORRALLM_TEST_STRESS === '1' ? [0x54b, 0x55b] : [0x54b]) {
    it(
      `keeps exactly the scan algorithm’s set through seeded changes, restarts, restores and staged rollbacks (seed ${String(initialSeed)})`,
      { timeout: 30_000 },
      ({ signal }) =>
        sequence(async () => {
          // Exercise real SQLite closes/reopens, restores and pruning, without making an unrelated
          // backup at every randomized restart. Snapshot publication has its own store tests.
          const snapshots = vi.spyOn(Store.prototype, 'snapshot').mockResolvedValue('unused');
          onTestFinished(() => {
            snapshots.mockRestore();
          });
          let seed = initialSeed;
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
            const message = messages.add(
              draft(from, i % 2 === 0 ? from : 'outside:two', 'replied'),
            );
            keepAdded(message);
          }
          const seen = new Set<number>();
          for (let step = 0; step < 400; step++) {
            signal.throwIfAborted();
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
              signal.throwIfAborted();
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
              signal.throwIfAborted();
              if (roll === 9) {
                await database.close();
                signal.throwIfAborted();
                const writer = connect(path.join(profile, STORE_FILE));
                try {
                  writer.exec('BEGIN');
                  settleRestored(writer, 1000);
                  writer.exec('COMMIT');
                } finally {
                  writer.close();
                }
              }
              await restart(undefined, signal);
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
                          withdrawal: parsed(row.withdrawal) as NonNullable<
                            PruneRecord['withdrawal']
                          >,
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
          expect(snapshots.mock.calls.length).toBeGreaterThan(40);
          await messages.durable();
          expect(rows().map(({ id }) => id)).toEqual([...expected.keys()]);
        }),
    );
  }
});

describe('what delivery acts on', () => {
  /** What `active()` must list: the messages kept that delivery acts on, in the store's order. */
  const expectIndexed = (messages: MessageStore) => {
    expect(messages.active()).toEqual(messages.all().filter(isActive));
    // B19 C2: and each recipient's line of it, read alone.
    for (const to of new Set(messages.all().map((message) => message.to)))
      expect(messages.activeTo(to)).toEqual(messages.active().filter((one) => one.to === to));
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
    ({ signal }) =>
      sequence(async () => {
        const snapshots = vi.spyOn(Store.prototype, 'snapshot').mockResolvedValue('unused');
        onTestFinished(() => {
          snapshots.mockRestore();
        });
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
        const states = [
          ...MESSAGE_STATES,
          'pending',
          'pending',
          'delivering',
          'delivered',
        ] as const;
        let messages = await store();
        for (let step = 0; step < 600; step++) {
          signal.throwIfAborted();
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
            signal.throwIfAborted();
            if (fails) staged?.undo();
            else staged?.reveal();
          } else if (roll < 0.98) {
            // A restart: read back from its rows.
            await messages.durable();
            signal.throwIfAborted();
            await restart(undefined, signal);
            messages = await store();
          } else {
            // A restore from a snapshot, which settles what waited there.
            await messages.durable();
            signal.throwIfAborted();
            await database.close();
            signal.throwIfAborted();
            const writer = connect(path.join(profile, STORE_FILE));
            try {
              writer.exec('BEGIN');
              settleRestored(writer, 1000);
              writer.exec('COMMIT');
            } finally {
              writer.close();
            }
            await restart(undefined, signal);
            messages = await store();
          }
          expectIndexed(messages);
        }
        // It went through each kind of change, and kept enough to prune.
        expect(messages.all().length).toBeGreaterThan(STORE_SETTLED_PER_PARTY);
        expect(messages.active().length).toBeGreaterThan(0);
      }),
  );
});

describe('the settled records each agent’s window shows (B19 C3)', () => {
  const PROMPT = '0f1e2d3c-4b5a-4968-8776-655443322110';
  /** A run hold's decision for agent `agent`, kept with the core's association. */
  const hold = (agent = 'builder', choice = 'approve'): Draft => ({
    from: 'corrallm',
    to: 'you',
    kind: 'settled',
    origin: 'party',
    body: 'You answered “private-hold-title”: Approve.',
    state: 'delivered',
    by: 'you',
    about: RecordAbout.parse({
      v: 1,
      agent,
      need: `hold/${encodeURIComponent(agent)}/0a1b2c3d/ok`,
      hold: { choice },
    }),
  });
  /** A native prompt's decision for agent `agent`, being made, kept with the core's association. */
  const native = (agent = 'builder'): Draft => {
    const need = `prompt/${encodeURIComponent(agent)}/2/${PROMPT}`;
    return {
      from: 'corrallm',
      to: 'you',
      kind: 'settled',
      origin: 'party',
      body: 'You allowed Builder’s command once.',
      state: 'delivering',
      by: 'you',
      settled: SettledDecision.parse({
        v: 1,
        need,
        prompt: { id: PROMPT, kind: 'approval', subject: 'command' },
        outcome: { type: 'choice', value: 'yes', hint: 'allow_once' },
      }),
      about: RecordAbout.parse({ v: 1, agent, need }),
    };
  };
  const ids = (messages: MessageStore, agent = 'builder') =>
    messages.records(agent).map(({ message }) => message.id);

  it('keeps a record’s association with its row, never changing it after, across a restart', async () => {
    const messages = await store();
    const record = messages.add(hold());
    await messages.durable();
    messages.update(record.id, { body: 'Changed words' });
    await messages.durable();
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT about FROM message WHERE id = ?').get(record.id),
      ),
    ).toEqual({ about: JSON.stringify(hold().about) });
    await restart();
    const again = await store();
    expect(again.records('builder')).toEqual([
      { message: { ...record, body: 'Changed words' }, about: hold().about },
    ]);
    // Never on the message itself: what the window shows is the core's, beside it.
    expect(again.get(record.id)).not.toHaveProperty('about');
  });

  it('reads a row whose association it can’t read, showing nothing of it, and leaves the column as it is', async () => {
    const messages = await store();
    const record = messages.add(hold());
    await messages.durable();
    const newer = JSON.stringify({ v: 2, agent: 'builder', need: 'hold/builder/0a1b2c3d/ok' });
    writeOnDisk(profile, `UPDATE message SET about = '${newer}' WHERE id = '${record.id}'`);
    await restart();
    const again = await store();
    expect(again.get(record.id)).toEqual(record);
    expect(again.records('builder')).toEqual([]);
    again.update(record.id, { body: 'Changed' });
    await again.durable();
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT about FROM message WHERE id = ?').get(record.id),
      ),
    ).toEqual({ about: newer });
  });

  it('shows each agent its own records, in the store’s order, and nothing without the core’s association', async () => {
    const messages = await store();
    const first = messages.add(hold('builder'));
    const other = messages.add(hold('reviewer'));
    // A decision kept before migration 13 (no association), and a message that is no record.
    const unassociated = hold('builder');
    delete unassociated.about;
    messages.add(unassociated);
    messages.add(draft('agent:builder', 'you', 'delivered'));
    const second = messages.add(hold('builder', 'stop'));
    expect(ids(messages)).toEqual([first.id, second.id]);
    expect(ids(messages, 'reviewer')).toEqual([other.id]);
    expect(messages.records('nobody')).toEqual([]);
  });

  it('shows a native decision only once a crash cut it off: B13’s owner entry shows it until then', async () => {
    const messages = await store();
    const landed = messages.add(native());
    const refused = messages.add(native());
    const cut = messages.add(native());
    expect(ids(messages)).toEqual([]);
    messages.update(landed.id, { state: 'delivered' });
    messages.update(refused.id, { state: 'withdrawn', by: 'corrallm' });
    expect(ids(messages)).toEqual([]);
    await messages.durable();
    // As the canvas's messages load again, one being made is unresolved, never given again.
    await restart();
    const again = await store();
    again.update(cut.id, { state: 'unresolved' });
    expect(ids(again)).toEqual([cut.id]);
    expect(again.records('builder')[0]?.message.state).toBe('unresolved');
  });

  it('shows the newest MAX_RECORD_ENTRIES of an agent’s, its unresolved ones among them, while their rows stay kept', async () => {
    const messages = await store();
    const cut = Array.from({ length: MAX_RECORD_ENTRIES + 5 }, () => {
      const record = messages.add(native());
      messages.update(record.id, { state: 'unresolved' });
      return record;
    });
    // An unresolved record is never pruned: every row stays, for you to inspect.
    for (const { id } of cut) expect(messages.get(id)).toBeDefined();
    expect(ids(messages)).toEqual(cut.slice(5).map(({ id }) => id));
    const newest = messages.add(hold());
    expect(ids(messages)).toEqual([...cut.slice(6).map(({ id }) => id), newest.id]);
    expect(messages.records('builder')).toHaveLength(MAX_RECORD_ENTRIES);
  });

  it('shows nothing the store no longer keeps: its window lies within the store’s retention', async () => {
    const messages = await store();
    const records = Array.from({ length: STORE_SETTLED_PER_PARTY + 3 }, () => messages.add(hold()));
    const kept = records.filter(({ id }) => messages.get(id) !== undefined).map(({ id }) => id);
    expect(kept.length).toBeLessThanOrEqual(STORE_SETTLED_PER_PARTY);
    expect(ids(messages)).toEqual(kept.slice(-MAX_RECORD_ENTRIES));
    expect(ids(messages)).not.toContain(records[0]?.id);
  });

  it('keeps its ids and its order across a restart', async () => {
    const messages = await store();
    const kept = [
      messages.add(hold()),
      messages.add(hold('builder', 'more')),
      messages.add(hold()),
    ];
    await messages.durable();
    await restart();
    expect(ids(await store())).toEqual(kept.map(({ id }) => id));
  });

  it('tells the agent whose window changed, once, as its record is kept, changed or dropped, and never for another message', async () => {
    const messages = await store();
    const heard: string[] = [];
    messages.watchRecords((agent) => heard.push(agent));
    const record = messages.add(hold());
    expect(heard).toEqual(['builder']);
    messages.add(draft('agent:builder', 'you', 'delivered'));
    const party = messages.add(draft('outside:orchestrator', 'agent:builder'));
    messages.update(party.id, { state: 'delivering' });
    const being = messages.add(native('reviewer'));
    expect(heard).toEqual(['builder']);
    messages.update(being.id, { state: 'unresolved' });
    expect(heard).toEqual(['builder', 'reviewer']);
    messages.update(record.id, { body: 'Changed' });
    expect(heard).toEqual(['builder', 'reviewer', 'builder']);
  });

  it('tells of a record staged within another write once that write returned, and again if it is undone', async () => {
    const messages = await store();
    const heard: string[] = [];
    messages.watchRecords((agent) => heard.push(agent));
    const staged = await table.write(() => messages.stageWithin(hold()));
    // Kept in its place at once, as every message is: told once the write returned.
    expect(ids(messages)).toEqual([staged.message.id]);
    expect(heard).toEqual([]);
    staged.reveal();
    expect(heard).toEqual(['builder']);
    staged.undo();
    expect(ids(messages)).toEqual([]);
    expect(heard).toEqual(['builder', 'builder']);
  });

  it('reads an agent’s window again only once it changed', async () => {
    const messages = await store();
    messages.add(hold());
    const window = messages.records('builder');
    // A burst of other messages changes nothing the window holds.
    for (let n = 0; n < 50; n++) {
      const message = messages.add(draft('outside:orchestrator', 'agent:builder'));
      messages.update(message.id, { state: 'withdrawn' });
    }
    expect(messages.records('builder')).toBe(window);
    messages.add(hold());
    expect(messages.records('builder')).not.toBe(window);
  });
});

describe('what a message’s purpose makes it (B19 C1)', () => {
  const task = { agent: 'lead', item: 'hand', attempt: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' };
  const base = {
    id: '6d0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    canvas: '0a6f6a5e-4bb3-4c3e-8a8c-3f7f2c1e9d10' as CanvasId,
    kind: 'text' as const,
    body: 'Review this',
    at: 1,
  };
  /** A run's direct send of its owner's own step, as before B19: no purpose. */
  const send: Message = { ...base, from: 'corrallm', to: 'agent:lead', task, state: 'delivering' };
  const handoff: Message = {
    ...base,
    from: 'agent:lead',
    to: 'agent:worker',
    task,
    state: 'pending',
    purpose: { v: 1, type: 'handoff' },
  };
  const evidence: Message = {
    ...base,
    from: 'agent:worker',
    to: 'agent:lead',
    body: 'APPROVED',
    replyTo: handoff.id,
    task,
    turn: { status: 'completed', reason: 'completed' },
    state: 'delivered',
    purpose: { v: 1, type: 'evidence' },
  };
  const party: Message = { ...base, from: 'agent:lead', to: 'agent:worker', state: 'pending' };

  it('keeps a row with no purpose as it was: a text with a task is the run’s own send', () => {
    expect(sentByRun(send)).toBe(true);
    expect(runOwned(send)).toBe(true);
    expect(sentByRun(party)).toBe(false);
    expect(runOwned(party)).toBe(false);
  });

  it('makes a hand-off the run’s work, which delivery delivers as a turn: no direct send of the run’s', () => {
    expect(sentByRun(handoff)).toBe(false);
    expect(runOwned(handoff)).toBe(true);
    expect(isQueueHandoff(handoff)).toBe(true);
    expect(isTurn(handoff)).toBe(true);
    expect(isActive(handoff)).toBe(true);
    expect(isSettled(handoff)).toBe(false);
  });

  it('makes its evidence a record: never a turn, never pending, never the run’s send, whatever its parent row', () => {
    expect(isHandoffEvidence(evidence)).toBe(true);
    expect(isQueueHandoff(evidence)).toBe(false);
    expect(isTurn(evidence)).toBe(false);
    expect(sentByRun(evidence)).toBe(false);
    expect(runOwned(evidence)).toBe(false);
    expect(isActive(evidence)).toBe(false);
    expect(isSettled(evidence)).toBe(true);
    expect(isMessageToYou(evidence)).toBe(false);
  });
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
