import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { afterEach, describe, expect, it } from 'vitest';

import { CoreLink } from './link';
import type { LinkPort } from './link';

/*
 * CoreLink over a Node MessageChannel pair, as the app's ports (Electron's, structured-cloned the
 * same way) will carry it: a window's calls, the core's changes, and HostServices requests to main.
 */

/** What the core side answers and sends, in these tests. */
interface CoreSide {
  requests: {
    add: { args: [a: number, b: number]; result: number };
    later: { args: [ms: number, value: string]; result: string };
    fail: { args: []; result: never };
    leak: { args: [what: 'function' | 'instance']; result: unknown };
    echo: { args: [value: unknown]; result: unknown };
  };
  events: { changed: [topic: string, rev: number] };
}

/** What the host side answers and sends, in these tests. */
interface HostSide {
  requests: { confirm: { args: [question: string]; result: boolean } };
  events: { gone: [] };
}

/** A side that asks what the host has no handler for. */
interface Stranger {
  requests: { nope: { args: []; result: null } };
  events: Record<string, never>;
}

function portOf(port: MessagePort): LinkPort {
  return {
    post: (message) => {
      port.postMessage(message);
    },
    start: (receive, gone) => {
      port.on('message', receive);
      port.once('close', () => {
        gone('the port closed');
      });
    },
    close: () => {
      port.close();
    },
  };
}

class Thing {
  readonly name = 'thing';
}

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function pair() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const core = new CoreLink<CoreSide, HostSide>(portOf(port1), {
    add: (a, b) => a + b,
    later: (ms, value) =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(value);
        }, ms),
      ),
    fail: () => {
      throw new Error('the core could not');
    },
    leak: (what) => (what === 'function' ? () => 'no' : new Thing()),
    echo: (value) => value,
  });
  const host = new CoreLink<HostSide, CoreSide>(portOf(port2), {
    confirm: (question) => Promise.resolve(question.endsWith('?')),
  });
  return { core, host, port1, port2 };
}

describe('CoreLink', () => {
  it('returns each request’s result as a value, in both directions', async () => {
    const { core, host } = pair();

    await expect(host.request('add', 2, 3)).resolves.toEqual({ ok: true, value: 5 });
    await expect(core.request('confirm', 'Quit?')).resolves.toEqual({ ok: true, value: true });
  });

  it('matches answers to their requests by id, whatever order they come back in', async () => {
    const { host } = pair();

    const slow = host.request('later', 40, 'slow');
    const fast = host.request('later', 0, 'fast');

    expect(await fast).toEqual({ ok: true, value: 'fast' });
    expect(await slow).toEqual({ ok: true, value: 'slow' });
  });

  it('returns a handler’s error as a value, and keeps working', async () => {
    const { host } = pair();

    await expect(host.request('fail')).resolves.toEqual({
      ok: false,
      error: { message: 'the core could not' },
    });
    await expect(host.request('add', 1, 1)).resolves.toEqual({ ok: true, value: 2 });
  });

  it('answers a request it has no handler for with an error', async () => {
    const { core } = pair();
    // As a peer built against another contract would ask.
    const stranger = core as unknown as CoreLink<CoreSide, Stranger>;

    await expect(stranger.request('nope')).resolves.toEqual({
      ok: false,
      error: { message: 'No handler for “nope”.' },
    });
  });

  it('delivers events to the other side’s listeners until they stop listening', async () => {
    const { core, host } = pair();
    const heard: [string, number][] = [];
    const stop = host.on('changed', (topic, rev) => heard.push([topic, rev]));

    core.emit('changed', 'canvas', 1);
    // A request after the event: answered only once the event has arrived (one port, in order).
    await host.request('add', 0, 0);
    stop();
    core.emit('changed', 'canvas', 2);
    await host.request('add', 0, 0);

    expect(heard).toEqual([['canvas', 1]]);
  });

  it('rejects what is pending when the other end dies, and every request after', async () => {
    const { host, port1 } = pair();

    const pending = host.request('later', 10_000, 'never');
    port1.close();

    await expect(pending).rejects.toThrow('the port closed');
    await expect(host.request('add', 1, 2)).rejects.toThrow('the port closed');
  });

  it('carries plain data: objects, arrays, Map, Set, Date and Uint8Array', async () => {
    const { host } = pair();
    const value = {
      list: [1, 'two', null, undefined, true],
      nested: { map: new Map([['a', { b: 1 }]]), set: new Set([1, 2]) },
      when: new Date(0),
      bytes: new Uint8Array([1, 2, 3]),
      bare: Object.assign(Object.create(null) as object, { x: 1 }),
    };

    const answer = await host.request('echo', value);

    expect(answer).toEqual({ ok: true, value: { ...value, bare: { x: 1 } } });
  });

  it('refuses to send a class instance or a function, saying where it is', async () => {
    const { host } = pair();

    await expect(host.request('echo', { items: [new Thing()] })).rejects.toThrow(
      'args[0].items[0] is a Thing, not plain data',
    );
    await expect(host.request('echo', { run: () => 1 })).rejects.toThrow(
      'args[0].run is a function, not plain data',
    );
    expect(() => {
      host.emit('gone', ...([new Thing()] as unknown as []));
    }).toThrow('args[0] is a Thing, not plain data');
  });

  it('answers with an error when a handler returns what is not plain data', async () => {
    const { host } = pair();

    await expect(host.request('leak', 'instance')).resolves.toEqual({
      ok: false,
      error: { message: 'The result is a Thing, not plain data.' },
    });
    await expect(host.request('leak', 'function')).resolves.toEqual({
      ok: false,
      error: { message: 'The result is a function, not plain data.' },
    });
  });

  it('ignores messages that are not its own', async () => {
    const { host, port1 } = pair();

    port1.postMessage('hello');
    port1.postMessage({ kind: 'answer', id: 999, answer: { ok: true, value: 1 } });
    port1.postMessage({ kind: 'request', name: 'confirm' });

    await expect(host.request('add', 1, 2)).resolves.toEqual({ ok: true, value: 3 });
  });
});
