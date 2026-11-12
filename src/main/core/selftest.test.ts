import { fork } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkForkRefused,
  checkLoopbackHttp,
  checkSpawn,
  checkSqlite,
  checkStore,
  checkTerminalScreen,
  runChecks,
  selfTestChecks,
} from './selftest';
import { openStore } from './store/open';

/*
 * The native self-test's checks, run here as they run in the packaged app's main process, in its
 * core process and in the CLI bundle, so that a change to the Agent SDK's protocol, the terminal's
 * screen or what the core needs of Node breaks them here first. node-pty's check is not run here:
 * unit tests never load native modules.
 */

/** What the core database's check reports, as it reports it on this platform. */
const STORE_CHECKED = new RegExp(
  [
    '^SQLite \\d+\\.\\d+\\.\\d+, WAL, synchronous NORMAL',
    process.platform === 'darwin' ? ', fullfsync' : '',
    ', its other pragmas as set, a write through the lane flushed and read back, a checkpoint off the loop, its log begun anew there, a snapshot read back',
    process.platform === 'win32' ? '' : ', core\\.db, -wal and -shm 0600',
    '$',
  ].join(''),
);

describe('the native self-test', () => {
  it('opens the core’s database as the core does, reporting what it checked', async () => {
    const check = selfTestChecks({ packaged: false }).find(({ name }) => name === 'node:sqlite');
    expect(check).toBeDefined();
    await expect(check?.run()).resolves.toMatch(STORE_CHECKED);
  });

  it('removes the temporary profile after checking the database', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-sqlite-test-'));
    try {
      await expect(checkSqlite(folder)).resolves.toMatch(STORE_CHECKED);
      expect(await readdir(folder)).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names a pragma of the database that isn’t as the core sets it', async () => {
    const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-sqlite-test-'));
    try {
      const { store } = await openStore(profile);
      try {
        store?.exec('PRAGMA trusted_schema = ON');
        await expect(store && checkStore(store)).rejects.toThrow('trusted_schema is 1, not 0');
      } finally {
        await store?.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('says why the database failed when its temporary profile cannot be written', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-sqlite-test-'));
    const blocked = path.join(folder, 'not-a-folder');
    await writeFile(blocked, 'a file cannot hold the profile');
    try {
      await expect(checkSqlite(blocked)).rejects.toThrow(/^The core’s database check failed: /);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('finds a copy of a terminal screen working', async () => {
    await expect(checkTerminalScreen()).resolves.toBe('@xterm/headless ok (40×5)');
  });

  it('serves HTTP on 127.0.0.1 and calls it, as the hook and MCP servers are called', async () => {
    await expect(checkLoopbackHttp()).resolves.toMatch(/^loopback HTTP ok \(127\.0\.0\.1:\d+\)$/);
  });

  it('spawns a child process and reads what it printed', async () => {
    await expect(checkSpawn()).resolves.toMatch(/^spawn ok \(pid \d+, exit 0\)$/);
  });

  it('passes where child_process.fork throws, as the RunAsNode fuse makes it', async () => {
    const refusing = () => {
      throw new Error('fork is not supported');
    };

    await expect(checkForkRefused(refusing)).resolves.toBe(
      'child_process.fork refused (fork is not supported)',
    );
  });

  it('fails where child_process.fork starts a process, as plain Node does', async () => {
    await expect(checkForkRefused(fork)).rejects.toThrow(
      'child_process.fork started a process: the RunAsNode fuse is off?',
    );
  });

  it('checks child_process.fork only in a packaged app, whose fuses refuse it', () => {
    const names = (packaged: boolean) => selfTestChecks({ packaged }).map(({ name }) => name);

    expect(names(false)).toEqual([
      'node-pty',
      'terminal screen',
      'Agent SDK',
      'node:sqlite',
      'loopback HTTP',
      'spawn',
    ]);
    expect(names(true)).toEqual([...names(false), 'child_process.fork']);
  });

  it('runs every check, reporting each one’s result or failure', async () => {
    const results = await runChecks([
      { name: 'first', run: () => Promise.resolve('first ok') },
      { name: 'second', run: () => Promise.reject(new Error('it broke')) },
      { name: 'third', run: () => Promise.resolve('third ok') },
    ]);

    expect(results).toEqual([
      { name: 'first', ok: true, said: 'first ok' },
      { name: 'second', ok: false, said: 'second failed: it broke' },
      { name: 'third', ok: true, said: 'third ok' },
    ]);
  });
});
