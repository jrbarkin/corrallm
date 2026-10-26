import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-dmg-background-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

// Exercise appdmg's actual dimension-reading step and installed image-size dependency, without
// importing its native addons or invoking hdiutil. A worker bounds a vulnerable parser's loop.
const reader = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const load = createRequire(workerData.entry);
class Pipeline {
  addStep(title, run) { if (title === 'Reading background dimensions') this.read = run; }
  expectAdditional() {}
  run() {
    return new Promise((resolve, reject) => {
      this.read(Object.assign(error => error ? reject(error) : resolve(), {
        skip: () => reject(new Error('Background was skipped')),
      }));
    });
  }
}
const module = { exports: {} };
runInNewContext(readFileSync(workerData.entry, 'utf8'), {
  module, exports: module.exports, process: { platform: 'darwin' },
  require(id) {
    if (id === './pipeline') return Pipeline;
    if (id.startsWith('image-size') || ['fs', 'os', 'path'].includes(id)) return load(id);
    if (id === 'is-my-json-valid') return () => () => true;
    return {};
  },
}, { filename: workerData.entry });
Promise.resolve().then(() => module.exports({
  target: workerData.image + '.dmg', basepath: workerData.folder,
  specification: { background: workerData.image, contents: [] },
})).then(() => parentPort.postMessage({ ok: true }),
  error => parentPort.postMessage({ error: error.message }));
`;

async function dimensions(bytes: Buffer): Promise<{ ok?: true; error?: string }> {
  const image = path.join(folder, 'background');
  await writeFile(image, bytes);
  const worker = new Worker(reader, {
    eval: true,
    workerData: { entry: require.resolve('appdmg/lib/appdmg.js'), folder, image },
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The background reader did not finish.'));
      }, 5000);
      worker.once('message', (result: { ok?: true; error?: string }) => {
        clearTimeout(timer);
        resolve(result);
      });
      worker.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
}

// appdmg is a macOS-only optional dependency and is absent from Linux/Windows installs.
it.runIf(process.platform === 'darwin')(
  'reads a DMG background with the installed image-size API',
  { timeout: 10_000 },
  async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
      'base64',
    );
    expect(await dimensions(png)).toEqual({ ok: true });
  },
);

it.runIf(process.platform === 'darwin')(
  'rejects a zero-length ICNS entry instead of looping in the DMG reader',
  { timeout: 10_000 },
  async () => {
    const icns = Buffer.alloc(16);
    icns.write('icns');
    icns.writeUInt32BE(16, 4);
    icns.write('icp4', 8);
    expect((await dimensions(icns)).error).toMatch(/invalid|corrupt|icns/i);
  },
);
