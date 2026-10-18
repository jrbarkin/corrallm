import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Forking the core process, against a fake utility process: the real one is forked by e2e's
 * self-test (e2e/selftest.e2e.ts) and the packaged app's.
 */

class FakeUtilityProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly posted: unknown[] = [];
  readonly kill = vi.fn(() => true);
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

const { fork, forked } = vi.hoisted(() => {
  const forked: FakeUtilityProcess[] = [];
  return {
    forked,
    fork: vi.fn((): unknown => {
      const child = new FakeUtilityProcess();
      forked.push(child);
      return child;
    }),
  };
});
vi.mock('electron', () => ({ utilityProcess: { fork } }));

const { forkCore } = await import('./core-process');

beforeEach(() => {
  forked.splice(0);
  fork.mockClear();
});

function start() {
  const output: [string, string][] = [];
  const core = forkCore({
    entry: '/app/.vite/build/core.cjs',
    output: (line, stream) => output.push([stream, line]),
    check: true,
  });
  const child = forked[0];
  if (!child) throw new Error('nothing was forked');
  return { core, child, output };
}

describe('forking the core process', () => {
  it('forks its bundle as a named utility process, its stdio piped', () => {
    start();

    expect(fork).toHaveBeenCalledWith('/app/.vite/build/core.cjs', [], {
      serviceName: 'corrallm core',
      stdio: 'pipe',
    });
  });

  it('passes on each line the core prints, and on which stream', async () => {
    const { child, output } = start();

    child.stdout.write('one\ntw');
    child.stdout.write('o\n');
    child.stderr.write('oops\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).toEqual([
      ['stdout', 'one'],
      ['stdout', 'two'],
      ['stderr', 'oops'],
    ]);
  });

  it('asks over the process’s port and hears the answer', async () => {
    const { core, child } = start();

    const answer = core.link.request('selftest', { packaged: false });
    const [request] = child.posted as [{ id: number; name: string; args: unknown[] }];
    expect(request).toMatchObject({
      kind: 'request',
      name: 'selftest',
      args: [{ packaged: false }],
    });
    child.emit('message', {
      kind: 'answer',
      id: request.id,
      answer: { ok: true, value: { checks: [], memory: 'rss 1 MB, heap 1 MB' } },
    });

    await expect(answer).resolves.toEqual({
      ok: true,
      value: { checks: [], memory: 'rss 1 MB, heap 1 MB' },
    });
  });

  it('rejects what is pending once the process exits, saying how', async () => {
    const { core, child } = start();

    const answer = core.link.request('selftest', { packaged: false });
    child.emit('exit', 11);

    await expect(core.exited).resolves.toBe(11);
    await expect(answer).rejects.toThrow('the core process exited with code 11');
  });

  it('kills the process', () => {
    const { core, child } = start();

    core.kill();

    expect(child.kill).toHaveBeenCalledOnce();
  });
});
