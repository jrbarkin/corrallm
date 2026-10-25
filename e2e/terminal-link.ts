import { platform } from 'node:os';
import type { Locator, Page } from '@playwright/test';

/** How long a hover waits for xterm to show a link: well inside the caller's poll, to hover again. */
const LINK_SHOWN_WITHIN = 1000;

/**
 * Cmd-clicks (Ctrl-clicks off macOS) a terminal cell once xterm shows it is a link, and says
 * whether it clicked. xterm asks its link providers for a row's links as the pointer comes onto the
 * row, and keeps their answer while the pointer stays on it: a pointer that reached the row before
 * the CLI's text did (the view can lag the CLI under software rendering) finds no link there,
 * however long it waits. So each hover comes onto the row from the next one, and a link not shown
 * in time is left for the caller to hover again (`expect.poll`).
 */
export async function clickTerminalLink(
  page: Page,
  view: Locator,
  size: { cols: number; rows: number },
  col: number,
  row: number,
): Promise<boolean> {
  // Re-read the actual screen each time: the window may have finished growing since the CLI
  // reported its size. The test's fake places its reply at known cells, not fixed pixel offsets.
  const screen = await view.locator('.xterm-screen').boundingBox();
  if (!screen) throw new Error('No terminal screen for the link click.');
  const cell = (column: number, line: number) => ({
    x: screen.x + ((column + 0.5) * screen.width) / size.cols,
    y: screen.y + ((line + 0.5) * screen.height) / size.rows,
  });
  const away = cell(col, row + 1 < size.rows ? row + 1 : row - 1);
  const at = cell(col, row);
  await page.mouse.move(away.x, away.y);
  await page.mouse.move(at.x, at.y, { steps: 2 });
  // xterm 6's Linkifier decorates screenElement, not the outer .xterm element (WebGL too).
  const shown = await view
    .locator('.xterm-screen.xterm-cursor-pointer')
    .waitFor({ state: 'visible', timeout: LINK_SHOWN_WITHIN })
    .then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && error.name === 'TimeoutError') return false;
        throw error;
      },
    );
  if (!shown) return false;
  const modifier = platform() === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  try {
    await page.mouse.click(at.x, at.y);
  } finally {
    await page.keyboard.up(modifier);
  }
  return true;
}
