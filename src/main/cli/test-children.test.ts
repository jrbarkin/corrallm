import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { TestChildren } from './test-children';
import type { ChildSystem, TestChild } from './test-children';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const alive = new Set([42, -42]);
  const finish = () => {
    alive.clear();
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
  };
  const system: ChildSystem = {
    spawn: vi.fn(() => child as unknown as TestChild),
    signal: vi.fn(() => {
      finish();
    }),
    alive: (pid) => alive.has(pid),
    groups: true,
  };
  child.kill.mockImplementation(() => {
    finish();
    return true;
  });
  return { child, system, alive, finish, children: new TestChildren(system) };
}

afterEach(() => {
  vi.useRealTimers();
});

it.each(['fails', 'times out'])(
  'tears down a child when its test %s before startup completes',
  async (why) => {
    vi.useFakeTimers();
    const { children, alive } = fixture();
    // Startup remains pending: no address or ready callback ever arrives.
    const startup = new Promise<void>(() => {
      children.spawn('test-server', []);
    });
    const ended =
      why === 'fails'
        ? Promise.reject(new Error(why))
        : Promise.race([
            startup,
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => {
                reject(new Error(why));
              }, 15_000);
            }),
          ]);
    const rejected = expect(ended).rejects.toThrow(why);
    if (why === 'times out') await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    await children.close();
    expect(alive.size).toBe(0);
  },
);

it('waits for graceful shutdown and pipe closure before the folder can be removed', async () => {
  vi.useFakeTimers();
  const { child, children, system, alive } = fixture();
  children.spawn('test-server', []);
  system.signal = vi.fn(() => {
    setTimeout(() => {
      alive.clear();
      child.emit('exit', 0, null);
      // The last output and close may arrive after exit.
      setTimeout(() => {
        child.emit('close', 0, null);
      }, 100);
    }, 1500);
  });
  let removed = false;
  const closing = children.close().then(() => {
    removed = true;
  });
  await vi.advanceTimersByTimeAsync(1599);
  expect(removed).toBe(false);
  await vi.advanceTimersByTimeAsync(26);
  await closing;
  expect(removed).toBe(true);
  expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
});

it.each([true, false])(
  'bounds a stuck shutdown, killing the owned group on POSIX (%s)',
  async (groups) => {
    vi.useFakeTimers();
    const { children, system, finish } = fixture();
    system.groups = groups;
    system.signal = vi.fn((_pid, signal) => {
      if (signal === 'SIGKILL') finish();
    });
    children.spawn('test-server', []);
    const closing = children.close();
    await vi.advanceTimersByTimeAsync(4999);
    expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(system.signal).toHaveBeenCalledWith(groups ? -42 : 42, 'SIGKILL');
  },
);

it('kills a surviving descendant group even after its leader exited', async () => {
  vi.useFakeTimers();
  const { child, children, system, alive, finish } = fixture();
  children.spawn('test-server', []);
  alive.delete(42);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  system.signal = vi.fn((_pid, signal) => {
    if (signal === 'SIGKILL') finish();
  });
  const closing = children.close();
  await vi.advanceTimersByTimeAsync(5000);
  await closing;
  expect(system.signal).toHaveBeenCalledExactlyOnceWith(-42, 'SIGKILL');
});

it('still owns the terminal server after its script wrapper has exited', async () => {
  const { child, children, system, alive } = fixture();
  children.spawn('script', []);
  children.target(child as unknown as TestChild, 84);
  alive.delete(42);
  alive.delete(-42);
  alive.add(84);
  alive.add(-84);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await children.close();
  expect(system.signal).toHaveBeenCalledExactlyOnceWith(84, 'SIGTERM');
  expect(alive.size).toBe(0);
});

it('refuses another spawn once teardown starts', async () => {
  const { children, system } = fixture();
  await children.close();
  expect(() => children.spawn('too-late', [])).toThrow(/teardown/);
  expect(system.spawn).not.toHaveBeenCalled();
});

it('reports a child that cannot be stopped instead of allowing folder removal', async () => {
  vi.useFakeTimers();
  const { children, system } = fixture();
  system.signal = vi.fn();
  children.spawn('test-server', []);
  const rejected = expect(children.close()).rejects.toThrow(/did not exit/);
  await vi.advanceTimersByTimeAsync(7000);
  await rejected;
});

it('handles a spawn error without waiting for an exit that never comes', async () => {
  const { child, children, system } = fixture();
  children.spawn('missing-server', []);
  Object.defineProperty(child, 'pid', { value: undefined });
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  child.emit('close', -2, null);
  await children.close();
  expect(system.signal).not.toHaveBeenCalled();
});

it('tracks exec-style commands immediately and keeps their last output', async () => {
  const { child, children, finish } = fixture();
  const pending = children.run('test-command', []);
  child.stdout.write('last line');
  child.stderr.write('why');
  finish();
  await expect(pending).rejects.toMatchObject({
    code: 'SIGTERM',
    stdout: 'last line',
    stderr: 'why',
  });
  await children.close();
});

it.each(['', '^D\b\b'])(
  'learns the terminal pid before readiness despite script’s prefix %j',
  async (prefix) => {
    const { child, children, system, alive, finish } = fixture();
    const terminal = children.terminal(['test-server', 'an argument'], {});
    alive.add(84);
    alive.add(-84);
    child.stdout.write(`${prefix}corrallm-test-`);
    system.signal = vi.fn((pid) => {
      if (pid === 42) {
        child.stdout.write('pid:84\r\nordinary output\r\n');
        alive.delete(42);
        alive.delete(-42);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      } else if (pid === 84) finish();
    });
    await children.close();
    expect(system.signal).toHaveBeenCalledWith(84, 'SIGTERM');
    expect(terminal.printed()).toBe(`${prefix}ordinary output\n`);
    expect(alive.size).toBe(0);
  },
);
