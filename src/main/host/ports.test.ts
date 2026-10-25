import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import { WindowPorts } from '../core/gui';
import { coreEnd } from '../core/test-window';
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
  readonly id: number;
  readonly setWindowOpenHandler = vi.fn();
  readonly reload = vi.fn();
  destroyed = false;
  constructor(id = 7) {
    super();
    this.id = id;
  }
  isDestroyed() {
    return this.destroyed;
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
    epoch: 1,
  };
  const ports = new CorePorts(core, ORIGIN);
  const window = new FakeContents();
  const connect = () => {
    ports.connect(window as unknown as WebContents);
  };
  return { core, ports, window, connect };
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

  it('keeps the port after a blocked navigation so a quit’s drafts.flush still reaches the window', async () => {
    const contents = new FakeContents();
    const native = contents as unknown as WebContents;
    installNavigationGuards(ORIGIN);
    appOn.mock.calls.find(([name]) => name === 'web-contents-created')?.[1]({}, contents);
    const order: string[] = [];
    const served = new WindowPorts({
      call: () => Promise.resolve({ ok: true, value: {} }),
      channels: {
        call: () => {
          throw new Error('unexpected channel');
        },
        gone: () => undefined,
        listen: () => () => undefined,
      },
    });
    const core = {
      epoch: 1,
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
      new CoreLink<GuiSide, CoreGuiSide>(
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
        {
          'drafts.flush': () => {
            order.push('drafts.flush');
            return null;
          },
        },
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

    // The quit's drafts are asked over the same port, answered before the core is closed.
    expect(await served.flushDrafts([7])).toEqual([]);
    order.push('core:close');
    served.gone(7, true);
    expect(order).toEqual(['drafts.flush', 'core:close']);
  });

  it('follows each window once, however often it asks', () => {
    const { core, window, connect } = setup();
    connect();
    connect();

    window.emit('destroyed');

    expect(core.windowGone).toHaveBeenCalledOnce();
  });

  it('names the epoch of the core the port reaches: each new core’s is the next', () => {
    const { core, window, connect } = setup();
    core.epoch = 3;

    connect();

    expect(window.postMessage).toHaveBeenCalledExactlyOnceWith('core:port', { epoch: 3 }, [
      channels[0]?.port2,
    ]);
  });
});

describe('a new core, after one crashed', () => {
  it('reloads every window it follows, so each restores its canvas from the new core', () => {
    const { ports, window, connect } = setup();
    const other = new FakeContents(8);
    const gone = new FakeContents(9);
    connect();
    ports.connect(other as unknown as WebContents);
    ports.connect(gone as unknown as WebContents);
    gone.destroyed = true;
    gone.emit('destroyed');

    ports.reconnect();

    expect(window.reload).toHaveBeenCalledOnce();
    expect(other.reload).toHaveBeenCalledOnce();
    expect(gone.reload).not.toHaveBeenCalled();
  });
});
