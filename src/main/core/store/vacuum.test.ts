import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import { MessageStore, MessageTable } from '../delivery/messages';
import { Checkpointer } from './checkpointer';
import type { Checkpointed } from './checkpointer';
import { SYSTEM_DEPS } from './store';
import type { Store } from './store';
import { openTestStore } from './test-store';

let profile: string;
let store: Store;
let idle: (() => void) | undefined;
let beforeFlush: () => Promise<void>;

beforeEach(async () => {
  beforeFlush = () => Promise.resolve();
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-vacuum-'));
  store = await openTestStore(profile, {
    ...SYSTEM_DEPS,
    flush: async (fd) => {
      await beforeFlush();
      await SYSTEM_DEPS.flush(fd);
    },
    later: (run) => {
      idle = run;
      return () => {
        idle = undefined;
      };
    },
  });
  await store.snapshot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

const free = () => Number(store.prepare('PRAGMA freelist_count').get()?.freelist_count);
const size = async () => (await stat(store.file)).size;

it('does no maintenance write when there are no free pages', async () => {
  await store.checkpoint();
  expect(free()).toBe(0);
  const worker = new Checkpointer(store.file);
  const header = (await readFile(`${store.file}-wal`)).subarray(12, 24);
  try {
    expect(await worker.vacuum()).toBe(0);
    expect((await readFile(`${store.file}-wal`)).subarray(12, 24)).toEqual(header);
  } finally {
    await worker.close();
  }
});

async function prunedMessages(): Promise<void> {
  const messages = new MessageStore(
    'canvas' as CanvasId,
    new MessageTable(store, new CanvasMemory(store)),
    () => 1000,
  );
  await messages.load();
  const ids: string[] = [];
  for (let i = 0; i < 220; i++) {
    ids.push(
      messages.add({
        from: 'you',
        to: 'agent:a',
        kind: 'text',
        state: 'pending',
        body: 'x'.repeat(64 * 1024),
      }).id,
    );
  }
  await messages.durable();
  await store.checkpoint();
  for (const id of ids) messages.update(id, { state: 'withdrawn' });
  await messages.durable();
  expect(messages.all().length).toBeGreaterThan(0);
  expect(messages.all().length).toBeLessThan(220);
}

it('returns pages freed by message pruning, in bounded idle passes after checkpointing', async () => {
  await prunedMessages();
  const before = await size();
  const freed = free();
  expect(freed).toBeGreaterThan(64);
  idle?.();
  await vi.waitFor(async () => {
    expect(await size()).toBeLessThan(before);
  });
  expect(freed - free()).toBeGreaterThan(0);
  expect(freed - free()).toBeLessThanOrEqual(64);
  expect(idle).toBeDefined(); // More free pages get another idle pass, not a busy loop.
});

it('skips vacuum when a write queued during its checkpoint', async () => {
  await prunedMessages();
  // Preserve the receiver explicitly when wrapping a prototype method for instrumentation.
  const original: (this: Checkpointer) => Promise<Checkpointed> = Reflect.get(
    Checkpointer.prototype,
    'checkpoint',
  );
  const checkpoint = vi.spyOn(Checkpointer.prototype, 'checkpoint');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  checkpoint.mockImplementation(async function (this: Checkpointer) {
    await held;
    return original.call(this);
  });
  const freed = free();
  idle?.();
  const written = store.write(() => {
    store.exec('UPDATE canvas SET used_at = used_at + 1');
  });
  release();
  await written;
  expect(free()).toBe(freed);
});

it('commits a write arriving during one vacuum pass before another pass', async () => {
  await prunedMessages();
  const original: (this: Checkpointer) => Promise<number> = Reflect.get(
    Checkpointer.prototype,
    'vacuum',
  );
  const passes = vi.spyOn(Checkpointer.prototype, 'vacuum');
  const flushing = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  beforeFlush = () => {
    flushing.resolve(undefined);
    return release.promise;
  };
  const order: string[] = [];
  let written: Promise<void> | undefined;
  passes.mockImplementation(async function (this: Checkpointer) {
    order.push('vacuum');
    const pass = original.call(this);
    written = store
      .write(() => {
        order.push('write');
        store.exec('UPDATE canvas SET used_at = used_at + 1');
      })
      .then(() => {
        order.push('committed');
      });
    const remaining = await pass;
    order.push('vacuum finished');
    return remaining;
  });
  try {
    idle?.();
    await flushing.promise;
    // A slow drive may hold the flush arbitrarily long: no second vacuum may get ahead of it,
    // and the write must not be acknowledged until its flush completes.
    expect(order).toEqual(['vacuum', 'vacuum finished', 'write']);
    expect(passes).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(undefined);
  }
  await written;
  expect(passes).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['vacuum', 'vacuum finished', 'write', 'committed']);
});
