import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Inspect our config without loading maker binaries, Electron or the build plugins.
const configClass = vi.hoisted(() =>
  // A maker records the settings it was made with.
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

import { FUSES } from '../../build/fuses';
import { rpmVersion } from '../../build/linux-version';
import config from '../../forge.config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('bundle identity', () => {
  it('names the app under a namespace the project holds, with its category and copyright', () => {
    expect(config.packagerConfig).toMatchObject({
      appBundleId: 'io.github.jrbarkin.corrallm',
      appCategoryType: 'public.app-category.developer-tools',
      appCopyright: 'Copyright 2026 corrallm contributors',
    });
  });

  it('keeps the copyright line NOTICE carries', async () => {
    expect(await readFile(path.join(ROOT, 'NOTICE'), 'utf8')).toContain(
      'Copyright 2026 corrallm contributors',
    );
  });

  it('points the packages at the repository, and stays unpublished to npm', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg).toMatchObject({
      private: true,
      homepage: 'https://github.com/jrbarkin/corrallm',
      repository: 'https://github.com/jrbarkin/corrallm',
    });
  });
});

function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('icon', () => {
  it('gives the packager an .icns at the configured path (no extension: packager appends it)', async () => {
    const icon = (config.packagerConfig as { icon?: string }).icon;
    if (!icon) throw new Error('packagerConfig.icon must be set');
    expect(path.extname(icon)).toBe('');
    const icns = await readFile(`${icon}.icns`);
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  it.each([16, 32, 64, 128, 256, 512, 1024])('commits a %i px render', async (size) => {
    const bytes = await readFile(path.join(ROOT, `build/icons/corrallm-${String(size)}.png`));
    expect(pngSize(bytes)).toEqual([size, size]);
  });

  it('gives the deb and the rpm the 512 px render for hicolor, not pixmaps', () => {
    const makers = config.makers as unknown as {
      settings?: { options?: { icon?: Record<string, string> } };
    }[];
    const icons = makers.map((maker) => maker.settings?.options?.icon).filter(Boolean);
    expect(icons).toEqual([
      { '512x512': path.join(ROOT, 'build/icons/corrallm-512.png') },
      { '512x512': path.join(ROOT, 'build/icons/corrallm-512.png') },
    ]);
  });

  it('keeps the source drawing beside its renders', async () => {
    const svg = await readFile(path.join(ROOT, 'build/icons/corrallm.svg'), 'utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).not.toMatch(/<script|on\w+=|href=/i);
  });
});

describe('fuses', () => {
  it('flips exactly the fuses build/fuses.ts names, which the release check reads back', () => {
    const plugins = config.plugins as unknown as { settings?: Record<string, unknown> }[];
    const fuses = plugins.find((plugin) => plugin.settings?.strictlyRequireAllFuses === true);
    expect(fuses?.settings).toEqual({ version: '1', strictlyRequireAllFuses: true, ...FUSES });
  });
});

describe('package versions', () => {
  it('gives the rpm a version that sorts a prerelease before its release', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const makers = config.makers as unknown as { settings?: { options?: { version?: string } } }[];
    expect(makers.map((maker) => maker.settings?.options?.version).filter(Boolean)).toEqual([
      rpmVersion(pkg.version),
    ]);
  });
});
