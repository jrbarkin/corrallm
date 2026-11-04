import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { inspectProcess } from '../core/process-identity';
import { TestChildren } from './test-children';
import { stopTestGroup } from './test-process-groups';

let directory: string;
let children: TestChildren;
beforeEach(async () => {
  const cache = path.resolve('node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'worker-death-'));
  children = new TestChildren();
});
afterEach(async () => {
  await children.close();
  await rm(directory, { recursive: true, force: true });
}, 30_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

it.skipIf(process.platform === 'win32')(
  'stops what a group’s exited leader left running in it, then passes',
  async () => {
    // G3's crash test: a fake codex's sleeping command, in the codex's own group, outlived it.
    const file = path.join(directory, 'left.json');
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
         require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: child.pid }));
         setTimeout(() => process.exit(0), 300);`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    const group = leader.pid ?? 0;
    const exited = new Promise((resolve) => leader.once('exit', resolve));
    try {
      const started = inspectProcess(group)?.started;
      if (started === undefined) throw new Error('The leader exited before it was recorded.');
      await exited;
      const left = (JSON.parse(await readFile(file, 'utf8')) as { pid: number }).pid;
      expect(alive(left)).toBe(true);
      expect(inspectProcess(group)).toBeUndefined();
      await expect(stopTestGroup({ pid: group, started })).resolves.toBeUndefined();
      expect(alive(left)).toBe(false);
    } finally {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // Already gone, as it should be.
      }
    }
  },
  30_000,
);

it.skipIf(process.platform === 'win32').each(['stdio', 'terminal'])(
  'kills the %s server and its descendants after SIGKILL of its test worker',
  async (mode) => {
    const target = path.join(directory, 'server.json');
    const wrapper = path.join(directory, 'wrapper.json');
    const owner = path.join(directory, 'owner.mjs');
    const fixture = pathToFileURL(path.resolve('node_modules/.cache/test-lifetime/entry.mjs')).href;
    const body = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const { Worker } = require('node:worker_threads');
      process.on('SIGHUP', () => {});
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const thread = new Worker('require("node:worker_threads").parentPort.postMessage("ready")', { eval: true });
      thread.once('message', () => {
        writeFileSync(${JSON.stringify(target)}, JSON.stringify({ pid: process.pid, descendant: child.pid }));
      });
      setInterval(() => {}, 1000);
    `;
    await writeFile(
      owner,
      `
      import { writeFileSync } from 'node:fs';
      import { TestChildren } from ${JSON.stringify(fixture)};
      const children = new TestChildren();
      const command = [process.execPath, '-e', ${JSON.stringify(body)}];
      const child = ${mode === 'terminal' ? 'children.terminal(command, process.env).child' : 'children.spawn(command[0], command.slice(1))'};
      child.stdout.resume(); child.stderr.resume();
      writeFileSync(${JSON.stringify(wrapper)}, JSON.stringify({ pid: child.pid }));
      setInterval(() => {}, 1000);
    `,
    );
    const unrelated = children.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    unrelated.stdout.resume();
    unrelated.stderr.resume();
    const worker = children.spawn(process.execPath, [owner]);
    worker.stdout.resume();
    let said = '';
    worker.stderr.setEncoding('utf8').on('data', (text: string) => {
      said += text;
    });
    let server: { pid: number; descendant: number } | undefined;
    await vi.waitFor(
      async () => {
        if (worker.exitCode !== null || worker.signalCode !== null)
          throw new Error(`Stand-in worker exited before startup: ${said}`);
        server = JSON.parse(await readFile(target, 'utf8')) as typeof server;
        expect(server?.pid).toBeGreaterThan(1);
      },
      { timeout: 10_000 },
    );
    if (server === undefined) throw new Error('The stand-in server did not start.');
    // Even a failing regression must stop its stand-in tree during ordinary teardown.
    children.target(worker, server.pid);
    if (mode === 'terminal') {
      const script = JSON.parse(await readFile(wrapper, 'utf8')) as { pid: number };
      process.kill(script.pid, 'SIGKILL');
      // The inner process ignores hangup; closing its wrapper alone is not ownership.
      expect(alive(server.pid)).toBe(true);
    }
    worker.kill('SIGKILL');
    await children.exited(worker);
    await vi.waitFor(
      () => {
        expect(alive(server?.pid ?? 0)).toBe(false);
        expect(alive(server?.descendant ?? 0)).toBe(false);
      },
      { timeout: 15_000 },
    );
    expect(alive(unrelated.pid ?? 0)).toBe(true);
  },
  30_000,
);
