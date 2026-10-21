import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Canvas tests start on the graph, by closing the same Start window a user sees. */
export async function dismissStart(page: Page) {
  await expect(page.locator('.graph-editor')).toHaveAttribute('aria-busy', 'false');
  const close = page.getByRole('button', { name: 'Close Start a session', exact: true });
  if (await close.isVisible()) await close.click();
}

/** File commands moved into the canvas menu; use their original accessible names. */
export async function canvasAction(
  page: Page,
  name: 'New' | 'Open…' | 'Save' | 'Save as…' | 'Canvases',
) {
  const action = page.getByRole('button', { name, exact: true });
  if (!(await action.isVisible()))
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click();
  await action.click();
  // These file-command tests continue on the bare canvas after New. The Start flow tests
  // exercise New directly, keeping its first screen visible.
  if (name === 'New') {
    await expect(page.getByRole('dialog', { name: 'Start a session', exact: true })).toBeVisible();
    await dismissStart(page);
  }
}

export async function openNeeds(page: Page) {
  const button = page.getByRole('button', { name: 'Needs you', exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}
