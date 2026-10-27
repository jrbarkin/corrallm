import { expect, it, vi } from 'vitest';

import type { CoreProcess } from './core-process';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));
vi.mock('electron', () => ({
  BrowserWindow: {},
  dialog: {},
  webContents: {},
  shell: { openExternal },
}));
import { hostServices } from './services';

it('refuses desktop requests from a replaced core before using a native service', async () => {
  const old = { link: { on: vi.fn() } } as unknown as CoreProcess;
  const next = { link: { on: vi.fn() } } as unknown as CoreProcess;
  let current = old;
  const services = hostServices(old, (source) => source === current);
  await services.openExternal('https://example.com/first');
  current = next;
  await expect(
    Promise.resolve().then(() => services.openExternal('https://example.com/late')),
  ).rejects.toThrow(/replaced/);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/first');
});

it('validates native presentation payloads and ignores events from a replaced core', async () => {
  const events = new Map<string, (value: unknown) => void>();
  const core = {
    link: { on: (name: string, hear: (value: unknown) => void) => events.set(name, hear) },
  } as unknown as CoreProcess;
  let current = true;
  const native = {
    presence: vi.fn(),
    unnotify: vi.fn(),
    notify: vi.fn(() => Promise.resolve('shown' as const)),
  };
  const host = hostServices(core, () => current, native);
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
  events.get('presence')?.(snapshot);
  events.get('presence')?.({ ...snapshot, revision: 1, jobs: 10000 });
  events.get('unnotify')?.(notification.handle);
  expect(native.presence).toHaveBeenCalledExactlyOnceWith(snapshot);
  expect(native.unnotify).toHaveBeenCalledExactlyOnceWith(notification.handle);
  await expect(host.notify(notification)).resolves.toBe('shown');
  await expect(host.notify({ ...notification, body: '🐴'.repeat(41) })).rejects.toThrow();
  expect(native.notify).toHaveBeenCalledExactlyOnceWith(notification);
  current = false;
  events.get('presence')?.({ ...snapshot, revision: 2 });
  events.get('unnotify')?.(notification.handle);
  await expect(host.notify(notification)).rejects.toThrow(/replaced/);
  expect(native.presence).toHaveBeenCalledOnce();
  expect(native.unnotify).toHaveBeenCalledOnce();
  expect(native.notify).toHaveBeenCalledOnce();
});
