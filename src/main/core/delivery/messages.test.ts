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

  it('sets aside a log corrupt in the middle, and starts empty', async () => {
    const messages = await store();
    messages.add(draft('outside:orchestrator', 'agent:builder'));
    messages.add(draft('outside:orchestrator', 'agent:builder'));
    await messages.durable();
    const [first, second] = (await readFile(logFile(), 'utf8')).trim().split('\n');
    await writeFile(logFile(), `${String(first)}\nnot json\n${String(second)}\n`);
    const again = await store();
    expect(again.all()).toEqual([]);
    const kept = await readdir(path.join(profile, 'runs', CANVAS));
    expect(kept.some((name) => /^messages\.rejected-.+\.jsonl$/.test(name))).toBe(true);
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
    const written = Buffer.byteLength(await readFile(logFile(), 'utf8'));
    expect(written).toBeLessThanOrEqual(STORE_BYTES * 2);
    expect((await store()).get(added.id)?.body).toBe('y'.repeat(16 * 1024));
  });

  it('reads nothing for a canvas with no messages yet, and writes nothing until one comes', async () => {
    const messages = await store();
    expect(messages.all()).toEqual([]);
    await messages.durable();
    await mkdir(path.join(profile, 'runs'), { recursive: true });
    await expect(readFile(logFile(), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
