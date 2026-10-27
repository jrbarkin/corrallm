import type { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  dock: vi.fn(),
  badge: vi.fn(),
  launcher: vi.fn(),
  start: vi.fn(() => 1),
  stop: vi.fn(),
  image: vi.fn<
    (path: string) => {
      path: string;
      setTemplateImage: ReturnType<typeof vi.fn>;
      isEmpty: () => boolean;
    }
  >(),
  menus: vi.fn(),
  supported: vi.fn(() => true),
  notification: vi.fn(),
}));
const trays: FakeTray[] = [];
interface FakeTray extends EventEmitter {
  image: unknown;
  menu: unknown;
  title: string;
  destroyed: boolean;
}
vi.mock('electron', async () => {
  const { EventEmitter: Events } = await import('node:events');
  return {
    app: { dock: { setMenu: native.dock, setBadge: native.badge }, setBadgeCount: native.launcher },
    Menu: { buildFromTemplate: native.menus },
    Tray: class extends Events {
      image: unknown;
      menu: unknown;
      title = '';
      destroyed = false;
      constructor(image: unknown) {
        super();
        this.image = image;
        trays.push(this);
      }
      setImage(image: unknown): void {
        this.image = image;
      }
      setContextMenu(menu: unknown): void {
        this.menu = menu;
      }
      setTitle(title: string): void {
        this.title = title;
      }
      setToolTip(): void {
        /* The fake has no OS tooltip. */
      }
      destroy(): void {
        this.destroyed = true;
      }
    },
    nativeImage: { createFromPath: native.image },
    powerSaveBlocker: { start: native.start, stop: native.stop },
    Notification: Object.assign(
      function (options: unknown) {
        native.notification(options);
      },
      { isSupported: native.supported },
    ),
  };
});

import { electronNotifications, electronPresence, PRESENCE_IMAGES } from './electron-presence';

beforeEach(() => {
  vi.clearAllMocks();
  trays.length = 0;
  native.image.mockImplementation((path: string) => ({
    path,
    setTemplateImage: vi.fn(),
    isEmpty: () => false,
  }));
  native.menus.mockImplementation((items: unknown) => ({ items }));
});

describe('Electron presence backend', () => {
  it('loads only fixed shipped template images on macOS and builds the Dock and tray from the same menu model', () => {
    const backend = electronPresence('darwin', '/own/resources');
    const status = { id: 'status', label: 'Idle', enabled: false };
    const pause = { id: 'pause', label: 'Pause all', enabled: true, click: vi.fn() };
    const menu = [
      status,
      { id: 'open', label: 'Open corrallm', enabled: true, click: vi.fn() },
      pause,
      { id: 'quit', label: 'Quit corrallm', enabled: true, click: vi.fn() },
    ];
    backend.dock(menu);
    backend.dockBadge('99+');
    const open = vi.fn();
    const tray = backend.tray(open);
    tray.update(menu, '3', true);
    expect(native.dock).toHaveBeenCalledWith({ items: [status, pause] });
    expect(trays[0]?.menu).toEqual({ items: menu });
    expect(native.badge).toHaveBeenCalledExactlyOnceWith('99+');
    expect(native.image.mock.calls.map(([path]) => path)).toEqual([
      '/own/resources/idleTemplate.png',
      '/own/resources/needsTemplate.png',
    ]);
    expect(
      (trays[0]?.image as { setTemplateImage: ReturnType<typeof vi.fn> }).setTemplateImage,
    ).toHaveBeenCalledWith(true);
    expect(trays[0]?.title).toBe('3');
    trays[0]?.emit('click');
    expect(open).not.toHaveBeenCalled();
    tray.destroy();
    expect(trays[0]?.destroyed).toBe(true);
  });

  it('uses PNGs, a menu and click-to-Open on Linux; the power blocker prevents app suspension only', () => {
    const backend = electronPresence('linux', '/own/resources');
    const open = vi.fn();
    const tray = backend.tray(open);
    tray.update([], '', true);
    trays[0]?.emit('click');
    expect(open).toHaveBeenCalledOnce();
    expect(native.image.mock.calls.map(([path]) => path)).toEqual([
      '/own/resources/idle.png',
      '/own/resources/needs.png',
    ]);
    backend.launcherBadge(8);
    expect(native.launcher).toHaveBeenCalledWith(8);
    const id = backend.startAwake();
    backend.stopAwake(id);
    expect(native.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension');
    expect(native.stop).toHaveBeenCalledWith(1);
    tray.destroy();
  });

  it('ships every idle/Needs image at 1x and 2x, with valid PNG dimensions', async () => {
    for (const [name, size] of Object.entries(PRESENCE_IMAGES)) {
      const data = await readFile(new URL(`../../../build/presence/${name}`, import.meta.url));
      expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(data.readUInt32BE(16)).toBe(size);
      expect(data.readUInt32BE(20)).toBe(size);
    }
  });

  it('uses only the native Notification constructor and holds Windows delivery for B29', () => {
    const backend = electronNotifications('darwin');
    expect(backend.supported()).toBe(true);
    expect(backend.supported()).toBe(true);
    backend.create({ title: 'corrallm', body: 'A worktree’s setup is waiting for you' });
    expect(native.notification).toHaveBeenCalledExactlyOnceWith({
      title: 'corrallm',
      body: 'A worktree’s setup is waiting for you',
    });
    expect(electronNotifications('win32').supported()).toBe(false);
    expect(native.supported).toHaveBeenCalledOnce();
  });
});
