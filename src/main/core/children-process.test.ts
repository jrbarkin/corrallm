import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawn } from '../sessions/process';
import { Children } from './children';
import { isProcessStart } from './process-identity';

let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-child-process-'));
});
afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

// These use only a short-lived Node stand-in, never an installed agent CLI.
describe.skipIf(process.platform === 'win32')('owned POSIX processes', () => {
  it('records a real stdio child before returning, then removes it on natural exit', async () => {
    const children = new Children(profile);
    await children.recover();
    const child = children.run(() =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: 'ignore' }),
    );
    const exited = once(child, 'exit');
    try {
      const file = path.join(profile, 'sessions', 'pids.json');
      const state = JSON.parse(await readFile(file, 'utf8')) as {
        children: { pid: number; started: unknown }[];
      };
      expect(state.children).toHaveLength(1);
      expect(state.children[0]?.pid).toBe(child.pid);
      expect(isProcessStart(state.children[0]?.started)).toBe(true);
      if (process.platform === 'linux') {
        expect(typeof state.children[0]?.started).toBe('object');
      }
      await exited;
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, children: [] });
    } finally {
      await exited;
    }
  });

  it('ends a matching stale child’s real process group at restart', async () => {
    const children = new Children(profile);
    await children.recover();
    const child = children.run(() =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' }),
    );
    const exited = once(child, 'exit');
    try {
      await new Children(profile).recover();
      await exited;
      expect(child.signalCode).toBe('SIGTERM');
      expect(
        JSON.parse(await readFile(path.join(profile, 'sessions', 'pids.json'), 'utf8')),
      ).toEqual({ version: 1, children: [] });
    } finally {
      await exited;
    }
  });
});
