import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Main's half of the handshake (B8 Design §3), against a fake core process and fake windows. That
 * only a trusted window gets here is ipc.ts's handle() (ipc.test.ts); the real ports cross in e2e
 * (smoke.e2e.ts reads app.info through one).
 */

const { MessageChannelMain, channels } = vi.hoisted(() => {
  const channels: { port1: { end: string }; port2: { end: string } }[] = [];
  class MessageChannelMain {
    readonly port1 = { end: 'the core’s' };
    readonly port2 = { end: 'the window’s' };
    constructor() {
      channels.push(this);
    }
  }
  return { MessageChannelMain, channels };
});
vi.mock('electron', () => ({ MessageChannelMain }));

const { CorePorts } = await import('./ports');

class FakeContents extends EventEmitter {
  readonly id = 7;
  readonly postMessage = vi.fn<(channel: string, message: unknown, transfer: unknown[]) => void>();
}

function setup() {
  const core = {
    connect: vi.fn<(window: number, port: unknown) => void>(),
    windowGone: vi.fn<(window: number) => void>(),
  };
  const ports = new CorePorts(core);
  const window = new FakeContents();
  const connect = () => {
    ports.connect(window as unknown as WebContents);
  };
  return { core, window, connect };
}

beforeEach(() => {
  channels.splice(0);
});

describe('windows’ ports to the core', () => {
  it('hands the core one end of a new channel, tagged with the window, and the window the other', () => {
    const { core, window, connect } = setup();

    connect();

    const [channel] = channels;
    expect(core.connect).toHaveBeenCalledExactlyOnceWith(7, channel?.port1);
    expect(window.postMessage).toHaveBeenCalledExactlyOnceWith('core:port', { epoch: 1 }, [
      channel?.port2,
    ]);
  });

  it('makes a new channel each time a window asks (its page reloaded)', () => {
    const { core, window, connect } = setup();

    connect();
    connect();

    expect(channels).toHaveLength(2);
    expect(core.connect.mock.calls.map(([, port]) => port)).toEqual(
      channels.map(({ port1 }) => port1),
    );
    expect(window.postMessage.mock.calls.map(([, , [port]]) => port)).toEqual(
      channels.map(({ port2 }) => port2),
    );
  });

  it.each([
    ['closes', 'destroyed', []],
    ['crashes', 'render-process-gone', [{}, { reason: 'crashed' }]],
    ['reloads', 'did-start-navigation', [{ isMainFrame: true, isSameDocument: false }]],
  ])('tells the core when a window %s', (_label, event, args) => {
    const { core, window, connect } = setup();
    connect();

    window.emit(event, ...args);

    expect(core.windowGone).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('keeps a window’s port while it navigates within its page or a frame does', () => {
    const { core, window, connect } = setup();
    connect();

    window.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    window.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });

    expect(core.windowGone).not.toHaveBeenCalled();
  });

  it('follows each window once, however often it asks', () => {
    const { core, window, connect } = setup();
    connect();
    connect();

    window.emit('destroyed');

    expect(core.windowGone).toHaveBeenCalledOnce();
  });
});
