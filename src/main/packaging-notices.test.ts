import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Inspect our config without loading maker binaries, Electron or the build plugins.
const configClass = vi.hoisted(() =>
  vi.fn(function (settings: unknown) {
    return { settings };
  }),
);
vi.mock('electron', () => ({}));
vi.mock('@electron-forge/maker-deb', () => ({ MakerDeb: configClass }));
vi.mock('@electron-forge/maker-dmg', () => ({ MakerDMG: configClass }));
vi.mock('@electron-forge/maker-rpm', () => ({ MakerRpm: configClass }));
vi.mock('@electron-forge/maker-squirrel', () => ({ MakerSquirrel: configClass }));
vi.mock('@electron-forge/maker-zip', () => ({ MakerZIP: configClass }));
vi.mock('@electron-forge/plugin-fuses', () => ({ FusesPlugin: configClass }));
vi.mock('@electron-forge/plugin-vite', () => ({ VitePlugin: configClass }));

import config from '../../forge.config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const resources = () => config.packagerConfig.extraResource;

describe('third-party notices', () => {
  it('ships the joined notices and Electron’s own two license files in the resources', () => {
    expect(resources().map((file) => path.basename(file))).toEqual(
      expect.arrayContaining([
        'THIRD-PARTY-NOTICES.txt',
        'electron-LICENSE',
        'LICENSES.chromium.html',
      ]),
    );
  });

  it('takes Electron’s license files from the build being packaged', async () => {
    const hooks = config.hooks as unknown as {
      packageAfterExtract: (config: unknown, extracted: string) => Promise<void>;
    };
    const extracted = await mkdtemp(path.join(tmpdir(), 'corrallm-electron-'));
    try {
      await writeFile(path.join(extracted, 'LICENSE'), 'Electron license text');
      await writeFile(path.join(extracted, 'LICENSES.chromium.html'), '<html>Chromium</html>');
      await hooks.packageAfterExtract({}, extracted);
      const find = (name: string) => resources().find((file) => path.basename(file) === name) ?? '';
      expect(await readFile(find('electron-LICENSE'), 'utf8')).toBe('Electron license text');
      expect(await readFile(find('LICENSES.chromium.html'), 'utf8')).toBe('<html>Chromium</html>');
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
  });

  it('starts every package build with no record of bundled packages', async () => {
    const stale = path.join(ROOT, 'node_modules/.cache/corrallm-notices/main.json');
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, '[]');
    await config.hooks.generateAssets();
    await expect(readFile(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
