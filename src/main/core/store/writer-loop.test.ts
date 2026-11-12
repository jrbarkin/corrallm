import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { afterEach, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import { CATALOG } from '../../sessions/adapters';
import { Documents } from '../canvas/documents';
import { FileReviews } from '../canvas/reviews';
import { MessageStore, MessageTable } from '../delivery/messages';
import { mintTrustedPath } from '../host';
import { openStore } from './open';
import { SYSTEM_DEPS } from './store';
import type { Store } from './store';

const io = vi.hoisted((): { file: string; published: () => void } => ({
  file: '',
  published: () => undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === `${io.file}.part`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args);
      if (args[1] === io.file) io.published();
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (args[0] === `${io.file}.part`) await new Promise((resolve) => setTimeout(resolve, 500));
      return fs.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (args[1] === io.file) io.published();
    },
  };
});

let profile: string | undefined;
let store: Store | undefined;
const before = process.listeners('SIGUSR2');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const listener of process.listeners('SIGUSR2'))
    if (!before.includes(listener)) process.removeListener('SIGUSR2', listener);
  vi.unstubAllEnvs();
  io.file = '';
  io.published = () => undefined;
  await store?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

it('keeps Needs, authentication and canvas metadata responsive during a slow WAL flush', async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-needs-loop-'));
  let slow = false;
  let flushing = false;
  const started = Promise.withResolvers<undefined>();
  const opened = await openStore(profile, {
    ...SYSTEM_DEPS,
    later: () => () => undefined,
    flush: async (fd) => {
      if (slow) {
        flushing = true;
        started.resolve(undefined);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      try {
        await SYSTEM_DEPS.flush(fd);
      } finally {
        flushing = false;
      }
    },
  });
  store = opened.store;
  if (store === undefined) throw new Error(opened.said.join(' '));
  const database = store;
  const canvas = '11111111-1111-4111-8111-111111111111' as CanvasId;
  const memory = new CanvasMemory(database);
  const reviews = new FileReviews({ store: database, memory });
  const documents = new Documents({ store: database, memory, catalog: CATALOG });
  documents.create(canvas, 'outside:load');
  await documents.keep(canvas);
  await memory.setFile(canvas, mintTrustedPath('/work/load.corral'));
  const raised = await database.write(() =>
    reviews.raiseWithin(canvas, 'f'.repeat(64), { file: 'load.corral', from: null }),
  );
  raised();
  let reads = 0;
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    // Model the Linux VFS wait seen in G2 when entering the reader during WAL fsync.
    // Delaying fsync alone cannot force this kernel behaviour on every developer filesystem.
    if (flushing && /^\s*SELECT/i.test(sql)) {
      reads++;
      if (reads === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    return prepare(sql);
  });
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  let samples = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    slow = true;
    const writing = database.write(() => {
      database.run('UPDATE document SET changed_at = changed_at + 1 WHERE canvas_id = ?', canvas);
    });
    await started.promise;
    timer = setInterval(() => {
      expect(reviews.items(canvas)).toHaveLength(1);
      expect(documents.createdBy('outside:load')).toEqual([canvas]);
      expect(documents.created('outside:load')).toBe(0);
      expect(documents.hasRows(canvas)).toBe(true);
      expect(memory.fileOf(canvas)).toBe('/work/load.corral');
      samples++;
    }, 5);
    await writing;
    clearInterval(timer);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const max = histogram.max / 1e6;
    console.info(
      `Needs/flush: loop max ${max.toFixed(2)} ms; ${String(reads)} disk reads; ${String(samples)} samples`,
    );
    expect(samples).toBeGreaterThan(0);
    expect(max).toBeLessThan(100);
    expect(reads).toBe(0);
  } finally {
    clearInterval(timer);
    histogram.disable();
  }
}, 30_000);

it('keeps writer work and its measurement responsive across warmup and slow result publication', async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-writer-loop-'));
  const started = vi.fn();
  const opened = await openStore(profile, {
    ...SYSTEM_DEPS,
    writerStarted: started,
    later: () => () => undefined,
    flush: async (fd) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await SYSTEM_DEPS.flush(fd);
    },
  });
  store = opened.store;
  if (store === undefined) throw new Error(opened.said.join(' '));
  expect(started).toHaveBeenCalledOnce();
  const database = store;
  const canvas = '11111111-1111-4111-8111-111111111111' as CanvasId;
  const memory = new CanvasMemory(database);
  await memory.update(canvas, (remembered) => remembered);
  const messages = new MessageStore(canvas, new MessageTable(database, memory), Date.now);
  await messages.load();
  database.exec('CREATE TABLE load_document (id INTEGER PRIMARY KEY, body TEXT) STRICT');
  io.file = path.join(profile, 'loop.json');
  vi.stubEnv('LOOP_DELAY_FILE', io.file);
  vi.stubEnv('CORRALLM_LOAD_CPU_PROFILE', '');
  vi.stubEnv('CORRALLM_G2_DIAG', '');
  const probe = new URL('../../../../e2e/loop-delay.mjs', import.meta.url).href;
  await import(probe);
  // A slow warmup before the first mark must never become a measured core interval.
  await new Promise((resolve) => setTimeout(resolve, 10));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  process.emit('SIGUSR2');
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  try {
    const writing = (async () => {
      for (let wave = 0; wave < 32; wave++) {
        messages.add({
          from: 'outside:load',
          to: 'agent:worker',
          kind: 'text',
          origin: 'party',
          body: 'x'.repeat(200 + wave * 97),
          state: 'pending',
        });
        await Promise.all([
          messages.durable(),
          database.write(() => {
            database.run(
              'INSERT INTO load_document VALUES (?, ?)',
              wave,
              JSON.stringify({ paused: wave % 2 === 0 }),
            );
          }),
        ]);
        database.prepare('SELECT count(*) FROM message').get();
        if (wave === 16) await database.checkpoint();
      }
    })();
    for (let mark = 0; mark < 2; mark++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const published = Promise.withResolvers<undefined>();
      io.published = () => {
        published.resolve(undefined);
      };
      process.emit('SIGUSR2');
      await published.promise;
    }
    await writing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const measured = JSON.parse(await readFile(io.file, 'utf8')) as {
      max: number;
      spans: unknown[];
    };
    const max = histogram.max / 1e6;
    console.info(
      `Writer/probe: loop max ${max.toFixed(2)} ms; reported max ${measured.max.toFixed(2)} ms`,
    );
    expect(database.prepare('SELECT count(*) AS n FROM message').get()?.n).toBe(32);
    expect(database.prepare('SELECT count(*) AS n FROM load_document').get()?.n).toBe(32);
    expect(measured.spans).toHaveLength(2);
    expect(max).toBeLessThan(100);
    expect(measured.max).toBeLessThan(100);
  } finally {
    histogram.disable();
  }
}, 30_000);
