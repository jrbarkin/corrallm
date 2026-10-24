import { platform } from 'node:os';
import type { Locator, Page } from '@playwright/test';

/** Click a link only after xterm has found it. Discovery is asynchronous, notably with software
 * rendering: an immediate click can precede the provider's answer on every polling attempt. */
export async function clickTerminalLink(
  page: Page,
  view: Locator,
  size: { cols: number; rows: number },
  col: number,
  row: number,
): Promise<void> {
  // Re-read the actual screen each time: the window may have finished growing since the CLI
  // reported its size. The test's fake places its reply at known cells, not fixed pixel offsets.
  const screen = await view.locator('.xterm-screen').boundingBox();
  if (!screen) throw new Error('No terminal screen for the link click.');
  const cell = (column: number) => ({
    x: screen.x + ((column + 0.5) * screen.width) / size.cols,
    y: screen.y + ((row + 0.5) * screen.height) / size.rows,
  });
  const away = cell(2);
  const at = cell(col);
  await page.mouse.move(away.x, away.y);
  await page.mouse.move(at.x, at.y, { steps: 2 });
  // xterm 6's Linkifier decorates screenElement, not the outer .xterm element (WebGL too).
  await view
    .locator('.xterm-screen.xterm-cursor-pointer')
    .waitFor({ state: 'visible', timeout: 5000 });
  const modifier = platform() === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  try {
    await page.mouse.click(at.x, at.y);
  } finally {
    await page.keyboard.up(modifier);
  }
}
