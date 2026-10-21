import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execFile, spawn, withProcesses } from './process';

const { spawnProcess, execProcess } = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
  execProcess: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: spawnProcess, execFile: execProcess }));
let child: ChildProcess;
let kill = vi.fn();
const owner = () => ({ beforeSpawn: vi.fn(), node: vi.fn(), pty: vi.fn(), stop: vi.fn() });
beforeEach(() => {
  kill = vi.fn();
  child = Object.assign(new EventEmitter(), {
    pid: 42,
    kill,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess;
  spawnProcess.mockReturnValue(child);
  execProcess.mockReturnValue(child);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('owned process spawns', () => {
  it.each(['spawn', 'execFile'] as const)(
    'refuses %s before starting an OS process once closing',
    (kind) => {
      const children = {
        ...owner(),
        beforeSpawn: () => {
          throw new Error('closing');
        },
      };
      expect(() =>
        withProcesses(children, () =>
          kind === 'spawn' ? spawn('fake-cli') : execFile('fake-cli', [], {}, vi.fn()),
        ),
      ).toThrow('closing');
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(execProcess).not.toHaveBeenCalled();
      expect(children.node).not.toHaveBeenCalled();
    },
  );

  it('starts owned stdio children in private POSIX groups and records them before returning', () => {
    const children = owner();
    const spawned = withProcesses(children, () =>
      spawn('fake-cli', ['--stdio'], { stdio: 'pipe' }),
    );
    expect(spawned).toBe(child);
    expect(spawnProcess).toHaveBeenCalledWith('fake-cli', ['--stdio'], {
      stdio: 'pipe',
      detached: true,
    });
    expect(children.node).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('tracks execFile helpers too and leaves unowned callers alone', () => {
    const children = owner();
    const done = vi.fn();
    withProcesses(children, () => execFile('fake-cli', ['--version'], { timeout: 100 }, done));
    expect(execProcess).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      'fake-cli',
      ['--version'],
      expect.objectContaining({ detached: true }),
    );
    child.stdout?.emit('data', Buffer.from('1.2.3'));
    child.emit('close', 0, null);
    expect(done).toHaveBeenCalledWith(null, '1.2.3', '');
    expect(children.node).toHaveBeenCalledExactlyOnceWith(child, 'close');
    spawn('unowned', [], {});
    expect(spawnProcess).toHaveBeenLastCalledWith('unowned', [], {});
    expect(children.node).toHaveBeenCalledTimes(1);
  });

  it('keeps simultaneous cores’ ownership separate through asynchronous work', async () => {
    const first = owner();
    const second = owner();
    await Promise.all(
      [first, second].map((children) =>
        withProcesses(children, async () => {
          await Promise.resolve();
          spawn('fake-cli', [], {});
        }),
      ),
    );
    expect(first.node).toHaveBeenCalledTimes(1);
    expect(second.node).toHaveBeenCalledTimes(1);
  });

  it('supports Node’s spawn(command, options) overload for an owned child', () => {
    const children = owner();
    withProcesses(children, () => spawn('fake-cli', { stdio: 'ignore' }));
    expect(spawnProcess).toHaveBeenCalledWith('fake-cli', [], { stdio: 'ignore', detached: true });
  });

  it('keeps helper exit codes and stderr, and bounds output and time', async () => {
    const children = owner();
    const done = vi.fn();
    withProcesses(children, () => execFile('fake-cli', [], { maxBuffer: 3 }, done));
    child.stderr?.emit('data', Buffer.from('why'));
    child.stdout?.emit('data', Buffer.from('abcdef'));
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      'abc',
      'why',
    );
    expect(children.stop).toHaveBeenCalledExactlyOnceWith(child, 'SIGTERM');
    child.emit('close', 1, null);
    expect(done).toHaveBeenCalledOnce();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.useFakeTimers();
    const timed = vi.fn();
    withProcesses(children, () => execFile('fake-cli', [], { timeout: 10 }, timed));
    await vi.advanceTimersByTimeAsync(10);
    expect(timed).toHaveBeenCalledWith(expect.objectContaining({ killed: true }), '', '');
    expect(children.stop).toHaveBeenLastCalledWith(child, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    expect(timed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create a detached console or POSIX group on Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const children = owner();
    withProcesses(children, () => spawn('fake-cli.exe', [], { windowsHide: true }));
    expect(spawnProcess).toHaveBeenCalledWith('fake-cli.exe', [], {
      windowsHide: true,
      detached: false,
    });
    expect(children.node).toHaveBeenCalledTimes(1);
  });
});
