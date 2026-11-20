import type * as Fs from 'node:fs';
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

  it.each(['corrallm.svg', 'corrallm-small.svg', 'corrallm-mark.svg'])(
    'keeps the source drawing beside its renders: %s',
    async (file) => {
      const svg = await readFile(path.join(ROOT, 'build/icons', file), 'utf8');
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg).not.toMatch(/<script\b|\bon\w+\s*=|\bhref\s*=/i);
    },
  );

  it('renders the small drawing at 16 and 32 px and uses those pixels in the iconset', async () => {
    const rendered = new Map<number, string>();
    const written = new Map<string, Buffer>();
    let size = 0;
    const launch = vi.fn(() =>
      Promise.resolve({
        newPage: () =>
          Promise.resolve({
            setViewportSize: (viewport: { width: number; height: number }) => {
              expect(viewport.width).toBe(viewport.height);
              size = viewport.width;
            },
            setContent: (html: string) => {
              rendered.set(size, html);
            },
            screenshot: () => Promise.resolve(Buffer.from(`png:${String(size)}`)),
          }),
        close: () => Promise.resolve(),
      }),
    );
    const iconutil = vi.fn();
    vi.doMock('@playwright/test', () => ({ chromium: { launch } }));
    vi.doMock('node:child_process', () => ({ execFileSync: iconutil }));
    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof Fs>('node:fs')),
      mkdirSync: vi.fn(),
      mkdtempSync: () => path.join(ROOT, 'node_modules/.cache/probes/iconset-test'),
      writeFileSync: (file: string, bytes: Buffer) => {
        written.set(file, bytes);
      },
      rmSync: vi.fn(),
    }));
    vi.stubEnv('CORRALLM_ICON_CHROMIUM', '/test/chromium');
    try {
      // Run the script itself with a fake rasterizer and no filesystem writes or iconutil.
      await import(path.join(ROOT, 'scripts/render-icons.mjs'));
      expect(launch).toHaveBeenCalledExactlyOnceWith({ executablePath: '/test/chromium' });
      expect([...rendered.keys()]).toEqual([16, 32, 64, 128, 256, 512, 1024]);
      for (const [pixels, html] of rendered) {
        const drawing = await readFile(
          path.join(ROOT, 'build/icons', pixels <= 32 ? 'corrallm-small.svg' : 'corrallm.svg'),
          'utf8',
        );
        expect(html.endsWith(drawing), `${String(pixels)} px uses its source drawing`).toBe(true);
        expect(written.get(path.join(ROOT, `build/icons/corrallm-${String(pixels)}.png`))).toEqual(
          Buffer.from(`png:${String(pixels)}`),
        );
      }
      for (const base of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          expect(
            written.get(
              path.join(
                ROOT,
                'node_modules/.cache/probes/iconset-test/corrallm.iconset',
                `icon_${String(base)}x${String(base)}${scale === 2 ? '@2x' : ''}.png`,
              ),
            ),
          ).toEqual(Buffer.from(`png:${String(base * scale)}`));
        }
      }
      expect(iconutil).toHaveBeenCalledExactlyOnceWith('iconutil', [
        '--convert',
        'icns',
        '--output',
        path.join(ROOT, 'build/icons/corrallm.icns'),
        path.join(ROOT, 'node_modules/.cache/probes/iconset-test/corrallm.iconset'),
      ]);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock('@playwright/test');
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('ships the icon attribution and ISC permission in the packaged NOTICE', async () => {
    expect(config.packagerConfig.extraResource).toContain(path.join(ROOT, 'NOTICE'));
    const notice = await readFile(path.join(ROOT, 'NOTICE'), 'utf8');
    expect(notice).toContain('https://github.com/lucide-icons/lucide');
    expect(notice).toContain('Copyright (c) 2026 Lucide Icons and Contributors');
    expect(notice).toContain(
      'Permission to use, copy, modify, and/or distribute this software for any\n' +
        'purpose with or without fee is hereby granted, provided that the above\n' +
        'copyright notice and this permission notice appear in all copies.',
    );
    expect(notice).toContain('OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.');
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
