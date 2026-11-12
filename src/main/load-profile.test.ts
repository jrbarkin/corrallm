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
        parentPort.on('message', async message => {
          if (message === 'release') { release(); return; }
          if (message === 'work') {
            const threads = await import('node:worker_threads');
            const { port1, port2 } = new threads.MessageChannel();
            const flag = new Int32Array(new SharedArrayBuffer(4));
            const native = new threads.Worker(\`
              const { workerData } = require('node:worker_threads');
              const { port, flag } = workerData;
              port.on('message', message => {
                port.postMessage({ id: message.id, changes: 1 });
                Atomics.store(flag, 0, 1);
                Atomics.notify(flag, 0);
              });
              port.postMessage({ ready: true });
            \`, { eval: true, workerData: { port: port2, flag }, transferList: [port2] });
            await new Promise(resolve => port1.once('message', resolve));
            port1.postMessage({ id: 17, op: 'sync', request: { op: 'run', statement: {
              id: 1, sql: 'INSERT INTO message (body) VALUES (?)', params: ['g2-credential-canary']
            } } });
            while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
            const reply = threads.receiveMessageOnPort(port1)?.message;
            if (reply?.id !== 17 || reply.changes !== 1) throw new Error('Diagnostic changed the synchronous reply');
            await native.terminate();
            port1.close();
            const handle = await fs.open(workerData.delay + '.fsync', 'w');
            await handle.writeFile('fixture');
            const raw = await import('node:fs');
            await new Promise((resolve, reject) => raw.fsync(handle.fd, error => error ? reject(error) : resolve()));
            await handle.close();
            parentPort.postMessage('worked');
            return;
          }
          process.emit('SIGUSR2');
          parentPort.postMessage('marked');
        });
        parentPort.postMessage('ready');
      `)}`,
    ),
    {
      workerData: { probe, delay },
      env: { LOOP_DELAY_FILE: delay, CORRALLM_LOAD_CPU_PROFILE: profile, CORRALLM_G2_DIAG: '1' },
    },
  );
  workers.push(worker);
  const ready = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  const worked = Promise.withResolvers<undefined>();
  let marked: (() => void) | undefined;
  let published = 0;
  worker.on('message', (message: string) => {
    if (message === 'ready') ready.resolve(undefined);
    if (message === 'held') held.resolve(undefined);
    if (message === 'worked') worked.resolve(undefined);
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
    if (span === 0) {
      worker.postMessage('work');
      await worked.promise;
    }
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
  const trace = await readFile(`${profile}.activity.json`, 'utf8');
  expect(trace).not.toContain('g2-credential-canary');
  const activity = JSON.parse(trace) as {
    marks: number[];
    clockUncertaintyUs: number;
    events: { lane: string; op: string; start: number; end: number }[];
  };
  expect(activity.marks).toHaveLength(4);
  expect(activity.marks[0]).toBeGreaterThanOrEqual(
    cpu.startTime - activity.clockUncertaintyUs - 1000,
  );
  expect(activity.marks[3]).toBeLessThanOrEqual(cpu.endTime + activity.clockUncertaintyUs + 1000);
  expect(activity.events).toContainEqual(
    expect.objectContaining({ lane: 'writer', op: 'sync run INSERT message' }),
  );
  expect(activity.events).toContainEqual(
    expect.objectContaining({ lane: 'writer-wait', op: 'sync run' }),
  );
  expect(activity.events).toContainEqual(expect.objectContaining({ lane: 'fsync', op: 'flush' }));
  for (const event of activity.events) expect(event.end).toBeGreaterThanOrEqual(event.start);
});
