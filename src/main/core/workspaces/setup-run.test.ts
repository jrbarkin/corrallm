import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spawnOwned } from '../../sessions/process';
import { mintTrustedPath } from '../host';
import { MAX_LOG_HEAD, MAX_LOG_TAIL, SetupProcess } from './setup-run';
import type { SetupProcesses } from './setup-run';

vi.mock('../../sessions/process', () => ({ spawnOwned: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof files>()) }));

class Child extends EventEmitter {
  readonly pid = 12345;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

let dir: string;
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(path.join(tmpdir(), 'corrallm-setup-run-')));
});
afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('SetupProcess completion', () => {
  it('refuses a checkout exchanged while its log is opening, before spawning anything', async () => {
    const child = new Child();
    vi.mocked(spawnOwned).mockReturnValue(child as unknown as ReturnType<typeof spawnOwned>);
    const cwd = path.join(dir, 'checkout');
    const outside = path.join(dir, 'outside');
    mkdirSync(cwd);
    mkdirSync(outside);
    const open = files.open;
    const opening = Promise.withResolvers<undefined>();
    const swapped = Promise.withResolvers<undefined>();
    vi.spyOn(files, 'open').mockImplementation(async (file, flags, mode) => {
      const fd = await open(file, flags, mode);
      opening.resolve(undefined);
      await swapped.promise;
      return fd;
    });
    const log = path.join(dir, 'setup.log');
    const started = SetupProcess.start(
      { run: (work) => work(), stop: () => Promise.resolve() },
      {
        executable: '/fake/setup',
        args: [],
        cwd: mintTrustedPath(cwd),
        env: {},
        log,
        timeoutMs: 60_000,
      },
    );
    const refused = expect(started).rejects.toThrow('checkout');
    await opening.promise;
    renameSync(cwd, `${cwd}.kept`);
    symlinkSync(outside, cwd);
    swapped.resolve(undefined);
    try {
      await refused;
    } finally {
      const running = await started.catch(() => undefined);
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      await running?.exited;
    }
    expect(spawnOwned).not.toHaveBeenCalled();
    expect(existsSync(log)).toBe(false);
  });

  it('bounds multibyte output by bytes, including its last 64 KiB', async () => {
    const child = new Child();
    vi.mocked(spawnOwned).mockReturnValue(child as unknown as ReturnType<typeof spawnOwned>);
    const log = path.join(dir, 'setup.log');
    const running = await SetupProcess.start(
      { run: (work) => work(), stop: () => Promise.resolve() },
      {
        executable: '/fake/setup',
        args: [],
        cwd: mintTrustedPath(dir),
        env: {},
        log,
        timeoutMs: 60_000,
      },
    );
    child.stdout.emit('data', Buffer.from('€'.repeat(MAX_LOG_HEAD)));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await running.exited;
    expect(Buffer.byteLength(running.tail(), 'utf8')).toBeLessThanOrEqual(MAX_LOG_TAIL);
    expect((await stat(log)).size).toBeLessThanOrEqual(MAX_LOG_HEAD + MAX_LOG_TAIL + 200);
  });

  it('ends remaining group members before reporting completion, even after stdio closes', async () => {
    const child = new Child();
    vi.mocked(spawnOwned).mockReturnValue(child as unknown as ReturnType<typeof spawnOwned>);
    const killed = Promise.withResolvers<undefined>();
    let owned = true;
    // The owner registers this before SetupProcess sees the child. Cleanup must start while
    // the group still has its recovery record, even when the leader and its pipes are gone.
    child.once('close', () => {
      owned = false;
    });
    const stop = vi.fn(() => {
      expect(owned).toBe(true);
      return killed.promise;
    });
    const processes: SetupProcesses = { run: (work) => work(), stop };
    const running = await SetupProcess.start(processes, {
      executable: '/fake/setup',
      args: [],
      cwd: mintTrustedPath(dir),
      env: {},
      log: path.join(dir, 'setup.log'),
      timeoutMs: 60_000,
    });
    let finished = false;
    void running.exited.then(() => {
      finished = true;
    });
    // A shell can leave a background child in its group with all output redirected.
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    try {
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledWith(child, 'SIGTERM');
      });
      expect(finished).toBe(false);
    } finally {
      killed.resolve(undefined);
      await running.exited;
    }
    expect(await running.exited).toMatchObject({ code: 0 });
  });
});
