import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreLink } from '../../../shared/link';
import type { Handlers, LinkPort } from '../../../shared/link';
import type { CoreSide, HostSide } from '../protocol';
import { appHost } from './app';

/*
 * The core's host in the app: what needs the desktop, asked of main over the core process's link,
 * here a MessageChannel pair with main's end answering as host/services.ts does.
 */

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

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
  };
}

/** The core's link to main, whose end answers with `main`'s services. */
function linked(main: Handlers<HostSide>) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  new CoreLink<HostSide, CoreSide>(portOf(port2), main);
  return new CoreLink<CoreSide, HostSide>(portOf(port1), {} as Handlers<CoreSide>);
}

/** Main's dialogs, each picking `picked`. */
function dialogs(picked: string | null) {
  const pick = () => Promise.resolve(picked);
  return {
    askOpenLink: () => Promise.resolve({ open: false, always: false }),
    openExternal: () => Promise.resolve(null),
    showFile: () => Promise.resolve(null),
    notify: () => Promise.resolve('unsupported' as const),
    pickCanvasToOpen: vi.fn<(window: number) => Promise<string | null>>(pick),
    pickCanvasToSave: vi.fn<(window: number, defaultPath: string) => Promise<string | null>>(pick),
    pickFolder: vi.fn<(window: number, current?: string) => Promise<string | null>>(pick),
  };
}

describe('the core’s host in the app', () => {
  it('asks main’s dialogs, for the window named, and takes what was picked as trusted', async () => {
    const main = dialogs('/Users/me/work');
    const host = appHost(linked(main));

    await expect(host.pickFolder(7, '/Users/me')).resolves.toBe('/Users/me/work');
    await expect(host.pickFolder(7)).resolves.toBe('/Users/me/work');
    await expect(host.pickCanvasToOpen(8)).resolves.toBe('/Users/me/work');
    await expect(host.pickCanvasToSave(9, 'plan.corral')).resolves.toBe('/Users/me/work');

    expect(main.pickFolder.mock.calls).toEqual([[7, '/Users/me'], [7]]);
    expect(main.pickCanvasToOpen).toHaveBeenCalledWith(8);
    expect(main.pickCanvasToSave).toHaveBeenCalledWith(9, 'plan.corral');
  });

  it('answers null for a dialog cancelled', async () => {
    const host = appHost(linked(dialogs(null)));

    await expect(host.pickFolder(7)).resolves.toBeNull();
  });

  it('rejects, saying why, when main’s dialog failed', async () => {
    const main = dialogs(null);
    main.pickCanvasToOpen.mockRejectedValue(new Error('The window is gone.'));
    const host = appHost(linked(main));

    await expect(host.pickCanvasToOpen(7)).rejects.toThrow('The window is gone.');
  });
});

it('sends presence and withdrawals as events and asks only the bounded notification request', async () => {
  const events: unknown[] = [];
  const notify = vi.fn(() => Promise.resolve('shown' as const));
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const main = new CoreLink<HostSide, CoreSide>(portOf(port2), { ...dialogs(null), notify });
  main.on('presence', (snapshot) => events.push(snapshot));
  main.on('unnotify', (handle) => events.push(handle));
  const link = new CoreLink<CoreSide, HostSide>(portOf(port1), {} as Handlers<CoreSide>);
  const host = appHost(link);
  const snapshot = {
    revision: 0,
    working: 0,
    runs: 0,
    jobs: 0,
    needs: 0,
    busy: false,
    awake: false,
  };
  const notification = {
    handle: 'ad9ee798-f2dc-40cf-a1e2-b0073ddfb316',
    title: 'corrallm',
    body: 'Needs you',
  };
  host.presence(snapshot);
  host.unnotify(notification.handle);
  await expect(host.notify(notification)).resolves.toBe('shown');
  expect(events).toEqual([snapshot, notification.handle]);
  expect(notify).toHaveBeenCalledExactlyOnceWith(notification);
  await expect(host.notify({ ...notification, body: '🐴'.repeat(41) })).rejects.toThrow();
  expect(notify).toHaveBeenCalledOnce();
});
