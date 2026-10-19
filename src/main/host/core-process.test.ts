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
  /** What each message posted transferred with it, by the message's place in `posted`. */
  readonly transferred: unknown[][] = [];
  readonly kill = vi.fn(() => true);
  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push(message);
    this.transferred.push(transfer);
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

/** What main answers the core of the desktop: the dialogs' picks, faked. */
const host = {
  pickCanvasToOpen: vi.fn(() => Promise.resolve(null)),
  pickCanvasToSave: vi.fn(() => Promise.resolve(null)),
  pickFolder: vi.fn((_window: number, current?: string) =>
    Promise.resolve(current === undefined ? null : `${current}/picked`),
  ),
};

function start() {
  const output: [string, string][] = [];
  const core = forkCore({
    entry: '/app/.vite/build/core.cjs',
    output: (line, stream) => output.push([stream, line]),
    check: true,
    host,
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

  it('hands the core a window’s end of its port beside the link, tagged with the window', () => {
    const { core, child } = start();
    const port = { end: 'the core’s' };

    core.connect(7, port as unknown as Electron.MessagePortMain);

    expect(child.posted).toEqual([{ kind: 'window', window: 7 }]);
    expect(child.transferred).toEqual([[port]]);
  });

  it('tells the core a window is gone, over the link', () => {
    const { core, child } = start();

    core.windowGone(7);

    expect(child.posted).toEqual([{ kind: 'event', name: 'windowGone', args: [7] }]);
  });

  it('answers what the core asks of the desktop with the host’s services', async () => {
    const { child } = start();

    child.emit('message', { kind: 'request', id: 1, name: 'pickFolder', args: [7, '/work'] });
    child.emit('message', { kind: 'request', id: 2, name: 'pickCanvasToOpen', args: [7] });

    await vi.waitFor(() => {
      expect(child.posted).toHaveLength(2);
    });
    expect(host.pickFolder).toHaveBeenCalledWith(7, '/work');
    expect(child.posted).toEqual(
      expect.arrayContaining([
        { kind: 'answer', id: 1, answer: { ok: true, value: '/work/picked' } },
        { kind: 'answer', id: 2, answer: { ok: true, value: null } },
      ]),
    );
  });

  it('kills the process', () => {
    const { core, child } = start();

    core.kill();

    expect(child.kill).toHaveBeenCalledOnce();
  });
});
