import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Inspect our config without loading maker binaries, Electron or the build plugins.
const configClass = vi.hoisted(() =>
  vi.fn(function () {
    return {};
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
const SDK_LICENSE = 'claude-agent-sdk-LICENSE.md';

function resources(): string[] {
  return config.packagerConfig.extraResource;
}

describe('packaged license notices', () => {
  it('ships corrallm’s notice and license beside the clearly named SDK license as resources', () => {
    expect(resources()).toContain(path.join(ROOT, 'NOTICE'));
    expect(resources()).toContain(path.join(ROOT, 'LICENSE'));
    expect(resources().map((file) => path.basename(file))).toContain(SDK_LICENSE);
  });

  it('stages the installed SDK’s own license byte for byte on every build', async () => {
    const prepare = config.hooks.generateAssets;
    expect(prepare).toBeTypeOf('function');
    await prepare();
    const shipped = resources().find((file) => path.basename(file) === SDK_LICENSE);
    if (!shipped) throw new Error('The SDK license must be a packaged resource.');
    await writeFile(shipped, 'An older build’s license');
    await prepare();
    expect(await readFile(shipped)).toEqual(
      await readFile(path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md')),
    );
  });
});
