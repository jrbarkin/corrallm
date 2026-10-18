import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORE_BYTES, STORE_SETTLED_PER_PARTY } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import type { Message } from '../../../shared/model/messages';
import { CanvasMemory } from '../../memory';
import { RunJournal } from '../../run-journal';
import { MessageStore } from './messages';
import type { MessageLog } from './messages';

const CANVAS = '0b8c6f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e' as CanvasId;

let profile: string;
let journal: RunJournal;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-messages-'));
  journal = new RunJournal(path.join(profile, 'runs'), {
    memory: new CanvasMemory(path.join(profile, 'canvases.json')),
    projectOf: () => undefined,
  });
});

afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

const logFile = () => path.join(profile, 'runs', CANVAS, 'messages.jsonl');

/** A store of the canvas's messages, loaded from what the journal keeps. */
async function store(now = () => 1000): Promise<MessageStore> {
  const loaded = new MessageStore(CANVAS, journal, now);
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

describe('the message store', () => {
  it('keeps each message as it changes, in the order they came, across a restart', async () => {
    const first = await store();
    const one = first.add(draft('outside:orchestrator', 'agent:builder'));
    const two = first.add(draft('you', 'agent:checker'));
    first.update(one.id, { state: 'delivering', delivery: { at: 1000, as: 'as-1', attempt: 1 } });
    await first.durable();

    const again = await store();
    expect(again.all().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: one.id, state: 'delivering' },
      { id: two.id, state: 'pending' },
    ]);
    expect(again.get(one.id)).toMatchObject({ delivery: { as: 'as-1', attempt: 1 } });
    // The store's order survives the restart: a message added now comes after both.
    const three = again.add(draft('agent:builder', 'outside:orchestrator', 'delivered'));
    expect(again.seqOf(three.id)).toBeGreaterThan(again.seqOf(two.id) ?? Infinity);
  });

  it('forces what it appended to disk before durable() resolves', async () => {
    const messages = await store();
    const added = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    const lines = (await readFile(logFile(), 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { message: Message }).message.id)).toEqual([
      added.id,
    ]);
  });

  it('ignores a torn last line', async () => {
    const messages = await store();
    const added = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    await writeFile(logFile(), `${await readFile(logFile(), 'utf8')}{"seq":9,"mess`);
    expect((await store()).all().map(({ id }) => id)).toEqual([added.id]);
  });

  it.each([
    ['a torn last line', (log: string) => `${log}{"seq":9,"mess`],
    ['a last line that lost its newline', (log: string) => log.trimEnd()],
    ['a last line that isn’t a record', (log: string) => `${log}{"seq":9}\n`],
  ])('appends what comes next on a line of its own after %s', async (_, tear) => {
    const messages = await store();
    const first = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    await writeFile(logFile(), tear(await readFile(logFile(), 'utf8')));
    const torn = await store();
    const second = torn.add(draft('outside:orchestrator', 'agent:checker'));
    torn.update(first.id, { state: 'delivering', delivery: { at: 1000, as: 'as-1', attempt: 1 } });
    await torn.durable();
    // Read back as written, however often.
    for (let i = 0; i < 2; i++) {
      const again = await store();
      expect(again.all().map(({ id, state }) => ({ id, state }))).toEqual([
        { id: first.id, state: 'delivering' },
        { id: second.id, state: 'pending' },
      ]);
      expect(again.warning).toBeUndefined();
    }
    expect(await readdir(path.join(profile, 'runs', CANVAS))).toEqual(['messages.jsonl']);
  });

  it('reads back messages to and from an agent whose id holds a line break', async () => {
    const messages = await store();
    const to = messages.add(draft('outside:orchestrator', 'agent:two\nlines'));
    const from = messages.add(draft('agent:two\nlines', 'outside:orchestrator', 'delivered'));
    const after = messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([to.id, from.id, after.id]);
    expect(again.warning).toBeUndefined();
  });

  it('sets aside a log corrupt in the middle, keeping what it reads of it, its order going on', async () => {
    const messages = await store();
    const waiting = messages.add(draft('outside:orchestrator', 'agent:builder'));
    const reply = messages.add(draft('agent:builder', 'outside:orchestrator', 'delivered'));
    const last = messages.add(draft('outside:orchestrator', 'agent:checker'));
    await messages.durable();
    const lines = (await readFile(logFile(), 'utf8')).trim().split('\n');
    await writeFile(logFile(), `${String(lines[0])}\nnot json\n${lines.slice(1).join('\n')}\n`);
    const again = await store();
    expect(again.warning).toMatch(
      /^The canvas’s messages could not all be read, and were moved to /,
    );
    expect(again.all().map(({ id }) => id)).toEqual([waiting.id, reply.id, last.id]);
    // What became of a message that waited before the broken line is unknown: it is never sent.
    // One whose last record comes after it still waits, for certain.
    expect([...again.doubtful]).toEqual([waiting.id]);
    // Its order goes on from the log's, so a cursor into it still reads what comes next.
    const next = again.add(draft('outside:orchestrator', 'agent:builder'));
    expect(again.seqOf(next.id)).toBeGreaterThan(again.seqOf(last.id) ?? Infinity);
    const kept = await readdir(path.join(profile, 'runs', CANVAS));
    expect(kept.some((name) => /^messages\.rejected-.+\.jsonl$/.test(name))).toBe(true);
    await again.durable();
    // Written anew, it reads back whole.
    const third = await store();
    expect(third.warning).toBeUndefined();
    expect(third.all().map(({ id }) => id)).toEqual([waiting.id, reply.id, last.id, next.id]);
  });

  it('keeps the newest settled messages per party, and every pending and unresolved one', async () => {
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
  });

  it('compacts its log once it grows past its budget, and reads back the same', async () => {
    const messages = await store();
    const added = messages.add(draft('outside:orchestrator', 'agent:builder'));
    for (let i = 0; i < 400; i++) messages.update(added.id, { body: 'y'.repeat(16 * 1024) });
    await messages.durable();
    // Written anew: one line, the message as it is now.
    const lines = (await readFile(logFile(), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThan(17 * 1024);
    expect((await store()).get(added.id)?.body).toBe('y'.repeat(16 * 1024));
  });

  it('appends again after it compacts a log as big as its budget', async () => {
    // Messages waiting are always kept, however many: what it keeps is past its byte budget.
    const rewrites: string[] = [];
    const counting: MessageLog = {
      readMessages: (canvas) => journal.readMessages(canvas),
      appendMessages: (canvas, text, durable) => journal.appendMessages(canvas, text, durable),
      rewriteMessages: (canvas, text) => {
        rewrites.push(text);
        return journal.rewriteMessages(canvas, text);
      },
      setAsideMessages: (canvas) => journal.setAsideMessages(canvas),
    };
    const messages = new MessageStore(CANVAS, counting, () => 1000);
    await messages.load();
    const big = 'x'.repeat(16 * 1024);
    const waiting = Array.from({ length: STORE_BYTES / (16 * 1024) + 10 }, (_, i) =>
      messages.add(draft(`outside:p${String(i)}`, 'agent:builder', 'pending', big)),
    );
    await messages.durable();
    expect(rewrites).toHaveLength(1);
    for (const [i, message] of waiting.slice(0, 10).entries()) {
      messages.update(message.id, {
        state: 'delivering',
        delivery: { at: 1000, as: `as-${String(i)}`, attempt: 1 },
      });
      await messages.durable();
    }
    expect(rewrites).toHaveLength(1);
    expect(
      (await store())
        .all()
        .filter(({ state }) => state === 'delivering')
        .map(({ id }) => id),
    ).toEqual(waiting.slice(0, 10).map(({ id }) => id));
  });

  it('reads nothing for a canvas with no messages yet, and writes nothing until one comes', async () => {
    const messages = await store();
    expect(messages.all()).toEqual([]);
    await messages.durable();
    await mkdir(path.join(profile, 'runs'), { recursive: true });
    await expect(readFile(logFile(), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('the message store, when its disk fails', () => {
  /** What the journal is asked to do that fails while it is named here. */
  const failing = new Set<keyof MessageLog>();
  /** How much of what is appended a failing append writes first. */
  let torn = 0;
  const EIO = () => new Error('EIO: i/o error');
  /** The journal, failing what `failing` names. */
  const faulty = (): MessageLog => ({
    readMessages: (canvas) =>
      failing.has('readMessages') ? Promise.reject(EIO()) : journal.readMessages(canvas),
    appendMessages: async (canvas, text, durable) => {
      if (!failing.has('appendMessages')) return journal.appendMessages(canvas, text, durable);
      if (torn > 0) await journal.appendMessages(canvas, text.slice(0, torn), false);
      throw EIO();
    },
    rewriteMessages: (canvas, text) =>
      failing.has('rewriteMessages')
        ? Promise.reject(EIO())
        : journal.rewriteMessages(canvas, text),
    setAsideMessages: (canvas) =>
      failing.has('setAsideMessages') ? Promise.reject(EIO()) : journal.setAsideMessages(canvas),
  });
  /** A store loaded over the faulty journal. */
  const shaky = async () => {
    const loaded = new MessageStore(CANVAS, faulty(), () => 1000);
    await loaded.load();
    return loaded;
  };
  /** Lets the store's own write of what changed (queued as it changes) go, and fail. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    failing.clear();
    torn = 0;
  });

  it('starts empty, journaling nothing over its log, when it can’t read it', async () => {
    const before = await store();
    const kept = before.add(draft('outside:orchestrator', 'agent:builder'));
    await before.durable();
    const log = await readFile(logFile(), 'utf8');

    failing.add('readMessages');
    const blind = await shaky();
    expect(blind.all()).toEqual([]);
    expect(blind.warning).toMatch(/^The canvas’s messages could not be read \(EIO: i\/o error\)/);
    // Nothing it can't journal is sent: durable() refuses, and the log stays as it was.
    blind.add(draft('outside:orchestrator', 'agent:builder'));
    await expect(blind.durable()).rejects.toThrow(/could not be read/);
    await settle();
    expect(await readFile(logFile(), 'utf8')).toBe(log);
    expect((await store()).all().map(({ id }) => id)).toEqual([kept.id]);
  });

  it('starts empty, journaling nothing, when it can’t set aside a log broken in the middle', async () => {
    const before = await store();
    before.add(draft('outside:orchestrator', 'agent:builder'));
    before.add(draft('outside:orchestrator', 'agent:builder'));
    await before.durable();
    const [first, second] = (await readFile(logFile(), 'utf8')).trim().split('\n');
    const broken = `${String(first)}\nnot json\n${String(second)}\n`;
    await writeFile(logFile(), broken);

    failing.add('setAsideMessages');
    const blind = await shaky();
    expect(blind.all()).toEqual([]);
    expect(blind.warning).toMatch(/^The canvas’s messages could not be read, nor moved aside/);
    blind.add(draft('outside:orchestrator', 'agent:builder'));
    await expect(blind.durable()).rejects.toThrow();
    expect(await readFile(logFile(), 'utf8')).toBe(broken);
  });

  it('writes a torn last line out with its next write when it couldn’t as it loaded', async () => {
    const before = await store();
    const first = before.add(draft('outside:orchestrator', 'agent:builder'));
    await before.durable();
    await writeFile(logFile(), `${await readFile(logFile(), 'utf8')}{"seq":9,"mess`);

    failing.add('rewriteMessages');
    const loaded = await shaky();
    expect(loaded.all().map(({ id }) => id)).toEqual([first.id]);
    failing.clear();
    const second = loaded.add(draft('outside:orchestrator', 'agent:checker'));
    await loaded.durable();
    const again = await store();
    expect(again.all().map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(again.warning).toBeUndefined();
  });

  it.each([
    ['nothing', 0],
    ['part of a line', 30],
  ])(
    'writes again what a write that failed after %s lost, before durable() resolves',
    async (_, written) => {
      const messages = await shaky();
      const first = messages.add(draft('outside:orchestrator', 'agent:builder'));
      await messages.durable();
      // Its withdrawal's write fails.
      failing.add('appendMessages');
      torn = written;
      messages.update(first.id, { state: 'withdrawn', by: 'outside:orchestrator' });
      await settle();
      failing.clear();
      const next = messages.add(draft('outside:orchestrator', 'agent:checker'));
      await messages.durable();
      const again = await store();
      expect(again.all().map(({ id, state }) => ({ id, state }))).toEqual([
        { id: first.id, state: 'withdrawn' },
        { id: next.id, state: 'pending' },
      ]);
      expect(again.warning).toBeUndefined();
    },
  );
});
