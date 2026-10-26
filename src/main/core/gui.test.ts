import { TerminalEvents } from './terminal-events';
import { CANVAS, OTHER_CANVAS } from './test-registry';
import { MessageChannel } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import { GUI_OPS } from '../../shared/api/surface';
import type { Dispatcher } from './call';
import { partyOf } from './caller';
import { WindowPorts } from './gui';
import { coreEnd, openWindow } from './test-window';

/*
 * A window's port, as the core serves it (B8 Design §4), over MessageChannel pairs: the core's end
 * as core/gui.ts holds it, the window's as the preload links it. That a GUI op answers through a
 * port as core.call does for you is T3a's (core/transport.test.ts).
 */

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** A core whose calls say who made them, unless a test answers otherwise. */
function fakeCore() {
  const call = vi.fn<Dispatcher['call']>((name, raw, caller) =>
    Promise.resolve({ ok: true, value: { name, raw, caller } }),
  );
  return { call };
}

/** Serves a new port as `window`'s: the window's end of it. */
function connect(served: WindowPorts, window: number) {
  const { link, close } = openWindow(served, window);
  closing.push(close);
  return link;
}

/** An operation a window may call. */
const OP = 'app.info';

describe('a window’s port', () => {
  it('routes a main native dialog’s release link through link.open as that connected window', async () => {
    const core = fakeCore();
    core.call.mockResolvedValue({ ok: true, value: { opened: true } });
    const served = new WindowPorts(core);
    connect(served, 7);
    await served.openLink(7, 'https://github.com/jrbarkin/corrallm/releases/tag/v1.0.0');
    expect(core.call).toHaveBeenCalledExactlyOnceWith(
      'link.open',
      { url: 'https://github.com/jrbarkin/corrallm/releases/tag/v1.0.0' },
      { kind: 'human', window: 7 },
    );
    await expect(served.openLink(8, 'https://github.com/')).rejects.toThrow(/window/);
    expect(core.call).toHaveBeenCalledOnce();
    core.call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'refused', sentence: 'No link now' },
    });
    await expect(served.openLink(7, 'bad')).rejects.toThrow('No link now');
  });
  it('calls each operation as you, at the window the port is for', async () => {
    const core = fakeCore();
    const served = new WindowPorts(core);
    const seven = connect(served, 7);
    const eight = connect(served, 8);

    await expect(seven.request('call', OP, { x: 1 })).resolves.toEqual({
      ok: true,
      value: { ok: true, value: { name: OP, raw: { x: 1 }, caller: { kind: 'human', window: 7 } } },
    });
    await eight.request('call', OP, undefined);

    const callers = core.call.mock.calls.map(([, , caller]) => caller);
    expect(callers).toEqual([
      { kind: 'human', window: 7 },
      { kind: 'human', window: 8 },
    ]);
    expect(callers.map((caller) => partyOf(caller))).toEqual(['you', 'you']);
  });

  it('serves only GUI_OPS: every operation whose audience includes you', () => {
    expect(GUI_OPS).toContain('app.info');
    // Not yours: an outside token's long poll.
    expect(GUI_OPS).not.toContain('wait');
    for (const name of ['agents', 'status', 'needs', 'messages']) expect(GUI_OPS).toContain(name);
    // Your composer's message is hosted (B11 §16.6).
    expect(GUI_OPS).toContain('message');
  });

  it.each([
    ['an operation that isn’t yours', 'wait'],
    ['no operation at all', 'nonsense'],
    ['a name that isn’t text', 42],
  ])('refuses %s before it is dispatched', async (_label, op) => {
    const core = fakeCore();
    const window = connect(new WindowPorts(core), 1);

    const answer = await window.request('call', op as string, {});

    expect(answer).toEqual({
      ok: true,
      value: {
        ok: false,
        error: {
          code: 'not-found',
          sentence: `corrallm’s window has no operation named ${String(op)}.`,
        },
      } satisfies OpResult<unknown>,
    });
    expect(core.call).not.toHaveBeenCalled();
  });

  it('keeps the fixed terminal stream scoped to the shown canvas across port replacement', async () => {
    const showing = new Map([
      [7, CANVAS],
      [8, OTHER_CANVAS],
    ]);
    const terminals = new TerminalEvents({
      showing: (canvas) => [...showing].filter(([, id]) => id === canvas).map(([window]) => window),
    });
    const served = new WindowPorts({ ...fakeCore(), terminals });
    const first = connect(served, 7),
      other = connect(served, 8);
    const heard = vi.fn(),
      elsewhere = vi.fn();
    first.on('event', heard);
    other.on('event', elsewhere);
    terminals.emit(CANVAS, 'a', { type: 'output', data: 'first' });
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledExactlyOnceWith('terminal', [
        'a',
        { type: 'output', data: 'first' },
      ]);
    });
    expect(elsewhere).not.toHaveBeenCalled();
    const next = connect(served, 7),
      fresh = vi.fn();
    next.on('event', fresh);
    terminals.emit(CANVAS, 'a', { type: 'output', data: 'after reload' });
    await vi.waitFor(() => {
      expect(fresh).toHaveBeenCalledExactlyOnceWith('terminal', [
        'a',
        { type: 'output', data: 'after reload' },
      ]);
    });
    expect(heard).toHaveBeenCalledOnce();
    showing.set(8, CANVAS);
    served.gone(7);
    terminals.emit(CANVAS, 'a', { type: 'exit', code: 0 });
    await vi.waitFor(() => {
      expect(elsewhere).toHaveBeenCalledExactlyOnceWith('terminal', [
        'a',
        { type: 'exit', code: 0 },
      ]);
    });
    expect(fresh).toHaveBeenCalledOnce();
  });

  it('has no hand-written request dispatcher left on a window’s port', async () => {
    const core = fakeCore();
    const window = connect(new WindowPorts(core), 7);
    expect(await window.request('channel' as 'call', 'session:close', ['a'])).toEqual({
      ok: false,
      error: { message: 'No handler for “channel”.' },
    });
    expect(core.call).not.toHaveBeenCalled();
  });

  it('closes a window’s port when it goes, cancelling its calls still going', async () => {
    const core = fakeCore();
    const signals: AbortSignal[] = [];
    core.call.mockImplementation((_name, _raw, _caller, signal) => {
      if (signal) signals.push(signal);
      return new Promise<never>(() => undefined);
    });
    const served = new WindowPorts(core);
    const window = connect(served, 3);

    const pending = window.request('call', OP, {});
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    served.gone(3);

    await expect(pending).rejects.toThrow('the port closed');
    expect(signals[0]?.aborted).toBe(true);
    // Gone again, or never served: nothing to do.
    served.gone(3);
    served.gone(4);
  });

  it('takes a window’s new port in place of the one before (a reload)', async () => {
    const core = fakeCore();
    const served = new WindowPorts(core);
    const before = connect(served, 5);
    const after = connect(served, 5);

    await expect(before.request('call', OP, {})).rejects.toThrow('the port closed');
    await expect(after.request('call', OP, {})).resolves.toMatchObject({
      ok: true,
      value: { ok: true },
    });
    expect(core.call).toHaveBeenCalledOnce();
  });

  it('forgets a window whose port closed at the other end', async () => {
    const core = fakeCore();
    const served = new WindowPorts(core);
    const { port1, port2 } = new MessageChannel();
    closing.push(() => {
      port2.close();
    });
    const end = coreEnd(port1);
    const close = vi.spyOn(end, 'close');
    served.open(6, end);
    // Heard after the core's own listener, which was there first.
    const closed = new Promise((resolve) => port1.once('close', resolve));

    port2.close();
    await closed;
    served.gone(6);

    expect(close).not.toHaveBeenCalled();
    expect(core.call).not.toHaveBeenCalled();
  });
});

/*
 * Before a quit's shutdown barrier (B11 Design §16.5), main asks each window, over its own port, to
 * finish the drafts it is composing: a fixed request of the window's link, `drafts.flush`, with no
 * run data, bounded per window. One that doesn't answer is reported (the failed-save dialog); one
 * with no port, or whose port goes as it is asked (it crashed), is skipped.
 */
describe('a window’s drafts, flushed before quitting', () => {
  it('asks each window over its own port, answered once its drafts are', async () => {
    const served = new WindowPorts(fakeCore());
    const flushed: number[] = [];
    const later = Promise.withResolvers<null>();
    for (const window of [7, 8]) {
      const { close } = openWindow(served, window, () => {
        flushed.push(window);
        return window === 8 ? later.promise : null;
      });
      closing.push(close);
    }
    const asking = served.flushDrafts([7, 8, 7]);
    let done = false;
    void asking.then(() => {
      done = true;
    });
    await vi.waitFor(() => {
      expect(flushed.sort()).toEqual([7, 8]);
    });
    expect(done).toBe(false);
    later.resolve(null);
    expect(await asking).toEqual([]);
  });

  it('reports a window that doesn’t answer in time, or answers with an error', async () => {
    const served = new WindowPorts(fakeCore());
    closing.push(openWindow(served, 7, () => new Promise<null>(() => undefined)).close);
    closing.push(
      openWindow(served, 8, () => Promise.reject(new Error('The field could not save'))).close,
    );
    closing.push(openWindow(served, 9).close);
    expect(await served.flushDrafts([7, 8, 9], 50)).toEqual([7, 8]);
  });

  it('skips a window with no port, and one whose port goes as it is asked', async () => {
    const served = new WindowPorts(fakeCore());
    const crashing = Promise.withResolvers<null>();
    const window = openWindow(served, 7, () => crashing.promise);
    const asking = served.flushDrafts([7, 12], 5000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    window.close();
    expect(await asking).toEqual([]);
  });
});

it('sends a show destination only to the named window, and never dispatches a gesture itself', async () => {
  const core = fakeCore();
  const served = new WindowPorts(core);
  const seven = connect(served, 7);
  const eight = connect(served, 8);
  const shown = vi.fn();
  const other = vi.fn();
  seven.on('show', shown);
  eight.on('show', other);
  const target = { canvas: CANVAS, need: 'prompt/a/1/p' };
  served.show(7, target);
  await vi.waitFor(() => {
    expect(shown).toHaveBeenCalledExactlyOnceWith(target);
  });
  expect(other).not.toHaveBeenCalled();
  expect(core.call).not.toHaveBeenCalled();
  served.gone(7);
  served.show(7, target);
  served.show(99, target);
  expect(shown).toHaveBeenCalledOnce();
});
