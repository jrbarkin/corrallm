import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appProfile, NODE_HOST } from './node';

/*
 * The core's host under plain Node (`corrallm serve`): no desktop, so no dialog, and the app's own
 * profile folder unless told another.
 */

describe('NODE_HOST', () => {
  it('has no dialogs: whatever needs one is yours, in the app', async () => {
    for (const ask of [
      () => NODE_HOST.pickCanvasToOpen(1),
      () => NODE_HOST.pickCanvasToSave(1, '/tmp/canvas.corral'),
      () => NODE_HOST.pickFolder(1),
    ]) {
      const refused = (await ask().catch((error: unknown) => error)) as {
        code: string;
        message: string;
      };
      expect(refused.code).toBe('human-only');
      expect(refused.message).toMatch(/in corrallm’s window/);
    }
  });
});

describe('appProfile', () => {
  it('is the folder the app keeps its profile in, on each OS', () => {
    expect(appProfile({ platform: 'darwin', env: {}, home: '/Users/me' })).toBe(
      '/Users/me/Library/Application Support/corrallm',
    );
    expect(
      appProfile({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
        home: 'C:\\Users\\me',
      }),
    ).toBe(path.win32.join('C:\\Users\\me\\AppData\\Roaming', 'corrallm'));
    expect(appProfile({ platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      path.win32.join('C:\\Users\\me', 'AppData', 'Roaming', 'corrallm'),
    );
    expect(
      appProfile({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/me' }),
    ).toBe('/xdg/corrallm');
    expect(appProfile({ platform: 'linux', env: {}, home: '/home/me' })).toBe(
      '/home/me/.config/corrallm',
    );
    // Only an absolute XDG_CONFIG_HOME counts, as the XDG spec says.
    expect(
      appProfile({ platform: 'linux', env: { XDG_CONFIG_HOME: 'rel' }, home: '/home/me' }),
    ).toBe('/home/me/.config/corrallm');
  });
});
