import { expect, it } from 'vitest';

import { diskDeltas, formatSystem, readSystem } from '../../e2e/g2-system.ts';
import type { ProcSource } from '../../e2e/g2-system.ts';

function fixture(): ProcSource {
  const files: Record<string, string> = {
    '/proc/loadavg': '4.25 2.00 1.00 3/100 999',
    '/proc/10/status':
      'Name:\telectron\nState:\tS (sleeping)\nPPid:\t1\nThreads:\t4\nVmRSS:\t2048 kB',
    '/proc/10/cmdline': '/opt/electron\0--type=utility\0--secret=argument-canary\0',
    '/proc/10/task/10/comm': 'electron',
    '/proc/10/task/11/comm': '[worker 1]',
    '/proc/10/task/12/comm': 'WorkerThread',
    '/proc/10/task/13/comm': 'V8Worker',
    '/proc/20/status': 'Name:\telectron\nState:\tZ (zombie)\nPPid:\t1\nThreads:\t1',
    '/proc/20/cmdline': '',
    '/proc/20/task/20/comm': 'electron',
    '/proc/30/status': 'Name:\tnode\nState:\tS (sleeping)\nPPid:\t1\nThreads:\t1',
    '/proc/30/cmdline': '/usr/bin/node\0/work/fake-backend.mjs\0',
    '/proc/30/task/30/comm': 'node',
  };
  const lists: Record<string, string[]> = {
    '/proc': ['10', '20', '30', '40', 'self', 'diskstats'],
    '/proc/10/task': ['10', '11', '12', '13'],
    '/proc/20/task': ['20'],
    '/proc/30/task': ['30'],
  };
  return {
    read: (file) =>
      files[file] === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(files[file]),
    list: (file) =>
      lists[file] === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(lists[file]),
  };
}

it('counts live app processes and named workers while retaining zombies and other thread names', async () => {
  const snapshot = await readSystem(fixture());
  expect(snapshot.processes).toHaveLength(3);
  const text = formatSystem('before-start', snapshot);
  expect(text).toContain('live corrallm processes=1');
  expect(text).toContain('corrallm kernel threads=4');
  expect(text).toContain('corrallm named worker threads=2');
  expect(text).toContain('native-fake processes=1');
  expect(text).toContain('V8Worker');
  expect(text).toContain('state=Z');
  expect(text).toContain('loadavg=4.25 2.00 1.00 3/100 999');
  expect(text).toContain('unreadable/disappeared processes=1');
  expect(text).not.toContain('argument-canary');
});

it('reports disk counter deltas in sectors and milliseconds without counting a reset or a new device', () => {
  const before = '8 0 sda 10 0 100 4 20 0 200 5 0 6 7\n8 1 sdb 99 0 100 4 20 0 200 5 0 6 7';
  const after =
    '8 0 sda 14 0 2148 14 23 0 4296 25 2 36 47\n8 1 sdb 1 0 2 3 4 0 5 6 0 7 8\n8 2 sdc 500 0 9999 0 2 0 4 0 0 0 0';
  const text = diskDeltas(before, after, 1000);
  expect(text).toContain('sda reads=4 writes=3 readMiB=1.00 writeMiB=2.00');
  expect(text).toContain('readMs=10 writeMs=20 busyMs=30 weightedMs=40 inFlight=2');
  expect(text).toContain('sdb counter reset');
  expect(text).toContain('sdc new device');
});

it('distinguishes an app and a headless core from a repository test process', async () => {
  const source = fixture();
  const original = source.read;
  source.read = (file) => {
    if (file === '/proc/10/status')
      return Promise.resolve('Name:\tnode\nState:\tS\nPPid:\t1\nThreads:\t4');
    if (file === '/proc/10/cmdline')
      return Promise.resolve('/usr/bin/node\0/work/corrallm/node_modules/playwright/cli.js\0');
    if (file === '/proc/30/cmdline')
      return Promise.resolve('/usr/bin/node\0/work/corrallm/dist-cli/corrallm.cjs\0serve\0');
    return original(file);
  };
  const snapshot = await readSystem(source);
  expect(snapshot.processes.find(({ pid }) => pid === 10)?.kind).toBe('test-tool');
  expect(snapshot.processes.find(({ pid }) => pid === 30)?.kind).toBe('corrallm-core');
  expect(formatSystem('before-start', snapshot)).toContain('live corrallm processes=1');
  const running = source.read;
  source.read = (file) =>
    file === '/proc/10/cmdline'
      ? Promise.resolve('/opt/electron\0/work/corrallm/.vite/build/main.cjs\0')
      : running(file);
  expect((await readSystem(source)).processes.find(({ pid }) => pid === 10)?.kind).toBe(
    'corrallm-app',
  );
});
