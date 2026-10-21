import type { Page } from '@playwright/test';

/** File commands moved into the canvas menu; use their original accessible names. */
export async function canvasAction(
  page: Page,
  name: 'New' | 'Open…' | 'Save' | 'Save as…' | 'Canvases',
) {
  const action = page.getByRole('button', { name, exact: true });
  if (!(await action.isVisible()))
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click();
  await action.click();
}

export async function openNeeds(page: Page) {
  const button = page.getByRole('button', { name: 'Needs you', exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}
