// Remakes build/icons/*.png and corrallm.icns from build/icons/corrallm.svg:
//   node scripts/render-icons.mjs
// Uses only what the repository already has: Playwright's Chromium to rasterize, and macOS's
// iconutil for the .icns. The renders are committed, so a build needs neither.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../build/icons');
const svg = readFileSync(path.join(folder, 'corrallm.svg'), 'utf8');
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

const browser = await chromium.launch(
  process.env.CORRALLM_ICON_CHROMIUM ? { executablePath: process.env.CORRALLM_ICON_CHROMIUM } : {},
);
const png = new Map();
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    png.set(size, await page.screenshot({ omitBackground: true, type: 'png' }));
  }
} finally {
  await browser.close();
}
for (const [size, bytes] of png) writeFileSync(path.join(folder, `corrallm-${size}.png`), bytes);

// iconutil wants an .iconset of fixed names: each size, and its @2x at double the pixels.
const scratch = mkdtempSync(path.join(tmpdir(), 'corrallm-iconset-'));
try {
  const iconset = path.join(scratch, 'corrallm.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), png.get(size));
    writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), png.get(size * 2));
  }
  execFileSync('iconutil', [
    '--convert',
    'icns',
    '--output',
    path.join(folder, 'corrallm.icns'),
    iconset,
  ]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
