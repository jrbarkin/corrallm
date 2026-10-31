import path from 'node:path';

import { app, Menu, nativeImage, Notification, powerSaveBlocker, Tray } from 'electron';
import type { NativeImage } from 'electron';

import type { NotificationBackend } from './notifications';
import type { PresenceBackend, PresenceMenu } from './presence';

/** Source resources copied as a directory outside app.asar; Electron selects the 2x variants. */
export const PRESENCE_IMAGES = {
  'idleTemplate.png': 16,
  'idleTemplate@2x.png': 32,
  'needsTemplate.png': 16,
  'needsTemplate@2x.png': 32,
  'idle.png': 32,
  'idle@2x.png': 64,
  'needs.png': 32,
  'needs@2x.png': 64,
} as const;

/** All names and paths are the app's resources, never supplied by the core or a page. */
export function electronPresence(platform: NodeJS.Platform, resources: string): PresenceBackend {
  const images = new Map<boolean, NativeImage>();
  const image = (needs: boolean) => {
    const previous = images.get(needs);
    if (previous !== undefined) return previous;
    const stem = needs ? 'needs' : 'idle';
    const loaded = nativeImage.createFromPath(
      path.join(resources, `${stem}${platform === 'darwin' ? 'Template' : ''}.png`),
    );
    if (loaded.isEmpty()) throw new Error('The native presence image is missing.');
    if (platform === 'darwin') loaded.setTemplateImage(true);
    images.set(needs, loaded);
    return loaded;
  };
  const menu = (items: PresenceMenu) => Menu.buildFromTemplate([...items]);
  return {
    dock: (items) => {
      // C1 adds status and Pause all above the Dock's own Open and Quit items.
      app.dock?.setMenu(menu(items.filter(({ id }) => id !== 'open' && id !== 'quit')));
    },
    dockBadge: (label) => {
      app.dock?.setBadge(label);
    },
    launcherBadge: (count) => {
      app.setBadgeCount(count);
    },
    tray: (open) => {
      const tray = new Tray(image(false));
      tray.setToolTip('corrallm');
      // macOS opens the item's menu. Linux activation also opens the app; Open stays in its menu.
      if (platform === 'linux') tray.on('click', open);
      return {
        update: (items, title, needs) => {
          tray.setImage(image(needs));
          tray.setContextMenu(menu(items));
          if (platform === 'darwin') tray.setTitle(title);
        },
        destroy: () => {
          tray.destroy();
        },
      };
    },
    startAwake: () => powerSaveBlocker.start('prevent-app-suspension'),
    stopAwake: (id) => {
      powerSaveBlocker.stop(id);
    },
  };
}

export function electronNotifications(platform: NodeJS.Platform): NotificationBackend {
  let checked = false;
  let supported = false;
  return {
    supported: () => {
      if (!checked) {
        checked = true;
        supported = platform !== 'win32' && Notification.isSupported();
      }
      return supported;
    },
    create: (options) => new Notification(options),
  };
}
