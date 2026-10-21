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

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-vacuum-'));
  store = await openTestStore(profile, {
    ...SYSTEM_DEPS,
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

it('lets a write arriving during one vacuum pass commit promptly, before another pass', async () => {
  await prunedMessages();
  const original: (this: Checkpointer) => Promise<number> = Reflect.get(
    Checkpointer.prototype,
    'vacuum',
  );
  const passes = vi.spyOn(Checkpointer.prototype, 'vacuum');
  let written: Promise<void> | undefined;
  let delay = 0;
  passes.mockImplementation(function (this: Checkpointer) {
    const pass = original.call(this);
    const began = performance.now();
    written = store
      .write(() => {
        store.exec('UPDATE canvas SET used_at = used_at + 1');
      })
      .then(() => {
        delay = performance.now() - began;
      });
    return pass;
  });
  idle?.();
  await vi.waitFor(() => {
    expect(written).toBeDefined();
  });
  await written;
  expect(passes).toHaveBeenCalledTimes(1);
  expect(delay).toBeLessThan(250);
  console.info(`write queued during vacuum: ${delay.toFixed(1)} ms`);
});
