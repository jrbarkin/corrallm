import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, expect, it, vi } from 'vitest';

const folders: string[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

it('keeps a requested G2 CPU profile and ordered spans across a slow result publication', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-load-profile-'));
  folders.push(folder);
  const profile = path.join(folder, 'core.cpuprofile');
  const delay = path.join(folder, 'loop.json');
  const probe = new URL('../../e2e/loop-delay.mjs', import.meta.url).href;
  const worker = new Worker(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const write = fs.writeFile;
        const rename = fs.rename;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let first = true;
        fs.writeFile = async (file, ...args) => {
          if (file === workerData.delay + '.part' && first) {
            first = false;
            parentPort.postMessage('held');
            await held;
          }
          return write(file, ...args);
        };
        fs.rename = async (from, to) => {
          await rename(from, to);
          if (to === workerData.delay) parentPort.postMessage('published');
        };
        syncBuiltinESMExports();
        await import(workerData.probe);
        parentPort.on('message', message => {
          if (message === 'release') { release(); return; }
          process.emit('SIGUSR2');
          parentPort.postMessage('marked');
        });
        parentPort.postMessage('ready');
      `)}`,
    ),
    {
      workerData: { probe, delay },
      env: { LOOP_DELAY_FILE: delay, CORRALLM_LOAD_CPU_PROFILE: profile },
    },
  );
  workers.push(worker);
  const ready = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  let marked: (() => void) | undefined;
  let published = 0;
  worker.on('message', (message: string) => {
    if (message === 'ready') ready.resolve(undefined);
    if (message === 'held') held.resolve(undefined);
    if (message === 'marked') marked?.();
    if (message === 'published') published++;
  });
  const heard = new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    void ready.promise.then(() => {
      resolve();
    });
  });
  await heard;
  for (let span = 0; span < 4; span++) {
    const acknowledged = new Promise<void>((resolve) => {
      // Only the mark's acknowledgement, never a publication event, releases this request.
      marked = resolve;
    });
    worker.postMessage('mark');
    await acknowledged;
    // Separate the measurement spans; their duration is not a pass condition.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await held.promise;
  expect(published).toBe(0);
  worker.postMessage('release');
  await vi.waitFor(async () => {
    const loop = JSON.parse(await readFile(delay, 'utf8')) as { spans: unknown[] };
    expect(loop.spans).toHaveLength(3);
  });
  const cpu = JSON.parse(await readFile(profile, 'utf8')) as {
    nodes: unknown[];
    samples: number[];
    startTime: number;
    endTime: number;
  };
  expect(cpu.nodes.length).toBeGreaterThan(0);
  expect(cpu.samples.length).toBeGreaterThan(0);
  expect(cpu.endTime).toBeGreaterThan(cpu.startTime);
});
