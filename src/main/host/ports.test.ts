import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import { WindowPorts } from '../core/gui';
import { coreEnd } from '../core/test-window';
import { RunShutdown } from '../run-shutdown';
import { installNavigationGuards } from '../security';

/*
 * Main's half of the handshake (B8 Design §3), against a fake core process and fake windows. That
 * only a trusted window gets here is ipc.ts's handle() (ipc.test.ts); the real ports cross in e2e
 * (smoke.e2e.ts reads app.info through one).
 */

const { MessageChannelMain, channels, appOn } = vi.hoisted(() => {
  const channels: { port1: MessagePort; port2: MessagePort }[] = [];
  class MessageChannelMain {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
    constructor() {
      const { port1, port2 } = new MessageChannel();
      this.port1 = port1;
      this.port2 = port2;
      channels.push(this);
    }
  }
  return {
    MessageChannelMain,
    channels,
    appOn: vi.fn<(name: string, listener: (...args: unknown[]) => void) => void>(),
  };
});
vi.mock('electron', () => ({
  MessageChannelMain,
  app: { on: appOn },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}));

const { CorePorts } = await import('./ports');

const ORIGIN = 'app://main_window';

class FakeContents extends EventEmitter {
  readonly id = 7;
  readonly setWindowOpenHandler = vi.fn();
  isDestroyed() {
    return false;
  }
  isCrashed() {
    return false;
  }
  readonly postMessage = vi.fn<(channel: string, message: unknown, transfer: unknown[]) => void>();
}

function setup() {
  const core = {
    connect: vi.fn<(window: number, port: unknown) => void>(),
    windowGone: vi.fn<(window: number) => void>(),
  };
  const ports = new CorePorts(core, ORIGIN);
  const window = new FakeContents();
  const connect = () => {
    ports.connect(window as unknown as WebContents);
  };
  return { core, window, connect };
}

beforeEach(() => {
  appOn.mockClear();
});

afterEach(() => {
  for (const { port1, port2 } of channels.splice(0)) {
    port1.close();
    port2.close();
  }
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
    [
      'reloads',
      'did-start-navigation',
      [{ url: `${ORIGIN}/index.html`, isMainFrame: true, isSameDocument: false }],
    ],
  ])('tells the core when a window %s', (_label, event, args) => {
    const { core, window, connect } = setup();
    connect();

    window.emit(event, ...args);

    expect(core.windowGone).toHaveBeenCalledExactlyOnceWith(7, event === 'destroyed');
  });

  it('keeps a window’s port while it navigates within its page or a frame does', () => {
    const { core, window, connect } = setup();
    connect();

    window.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    window.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });

    expect(core.windowGone).not.toHaveBeenCalled();
  });

  it('keeps the port after a blocked navigation so run:ready reaches main before the core stops', async () => {
    const contents = new FakeContents();
    const native = contents as unknown as WebContents;
    installNavigationGuards(ORIGIN);
    appOn.mock.calls.find(([name]) => name === 'web-contents-created')?.[1]({}, contents);
    const order: string[] = [];
    let renderer: CoreLink<GuiSide, CoreGuiSide>;
    const failed: unknown[] = [];
    const shutdown = new RunShutdown((_window, request) => {
      order.push('run:stopping');
      void renderer.request('channel', 'run:ready', [request, null]).catch((error: unknown) => {
        failed.push(error);
      });
    });
    const served = new WindowPorts({
      call: () => Promise.resolve({ ok: true, value: {} }),
      channels: {
        call: (window, name, args) => {
          if (window !== 7 || name !== 'run:ready') throw new Error('unexpected acknowledgement');
          order.push('run:ready');
          shutdown.ready(native, args[0] as string, args[1] as null);
          return null;
        },
        gone: () => undefined,
        listen: () => () => undefined,
      },
    });
    const core = {
      connect: (window: number, port: Electron.MessagePortMain) => {
        served.open(window, coreEnd(port as unknown as MessagePort));
      },
      windowGone: (window: number, closed?: boolean) => {
        order.push('windowGone');
        served.gone(window, closed);
      },
    };
    contents.postMessage.mockImplementation((_name, _data, [port]) => {
      const end = port as MessagePort;
      renderer = new CoreLink<GuiSide, CoreGuiSide>(
        {
          post: (message) => {
            end.postMessage(message);
          },
          start: (receive, gone) => {
            end.on('message', receive);
            end.once('close', () => {
              gone('the port closed');
            });
          },
        },
        {},
      );
    });
    new CorePorts(core, ORIGIN).connect(native);

    // Electron emits the start before will-navigate, even when the guard cancels it.
    const url = 'https://attacker.invalid/leave';
    contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    const navigation = { url, preventDefault: vi.fn() };
    contents.emit('will-navigate', navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    await new Promise((resolve) => setImmediate(resolve));

    await shutdown.stop(native);
    // Main flushes/closes the core only after its freeze/save acknowledgement.
    order.push('core:close');
    served.gone(7, true);
    expect(order).toEqual(['run:stopping', 'run:ready', 'core:close']);
    expect(failed).toEqual([]);
  });

  it('follows each window once, however often it asks', () => {
    const { core, window, connect } = setup();
    connect();
    connect();

    window.emit('destroyed');

    expect(core.windowGone).toHaveBeenCalledOnce();
  });
});
