import { dismissStart } from './canvas-actions';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * Usage readings and rules through the real app: they are the core's (src/main/usage.ts), set over the
 * generated usage operations, heard back through the usage topic, and remembered across a restart with their time.
 */

/** Opens a template with Claude agents, so the canvas shows Claude's usage gauge. */
async function claudeCanvas(page: Page) {
  await page.getByRole('button', { name: 'Start from a template…' }).click();
  await page
    .getByRole('dialog', { name: 'Templates' })
    .getByRole('button', { name: /^Independent cross-check/ })
    .click();
  await page.getByRole('button', { name: 'Create canvas' }).click();
}

test('simulates usage and sets a rule in main, remembered across a restart', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-usage-'));
  try {
    let { app, close } = await launchApp({ profile });
    let page = await app.firstWindow();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    await dismissStart(page);
    await claudeCanvas(page);
    const gauge = () => page.getByRole('button', { name: /^Claude usage:/ });
    await expect(gauge()).toHaveAttribute('aria-label', 'Claude usage: no reading');

    await gauge().click();
    const panel = () => page.getByRole('dialog', { name: 'Claude usage' });
    await panel().getByRole('button', { name: 'Add a rule…' }).click();
    await page.getByRole('option', { name: /^Finish the task, then wait for the reset/ }).click();
    await panel().getByRole('button', { name: 'Simulate usage…' }).click();
    await panel().getByRole('textbox', { name: '5-hour window: share used (%)' }).fill('92');
    await panel().getByRole('textbox', { name: 'Weekly window: share used (%)' }).fill('');
    await panel().getByRole('button', { name: 'Simulate' }).click();
    await expect(gauge()).toHaveAttribute('aria-label', 'Claude usage: 92% of 5-hour window');
    await expect(gauge()).toHaveAttribute('data-over', '');

    // Main remembers both: after a restart, the gauge shows them again, as simulated.
    await close();
    ({ app, close } = await launchApp({ profile }));
    page = await app.firstWindow();
    // The unsaved template canvas is restored too; it already supplies Claude's gauge.
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__node-frame')).toContainText('Independent cross-check');
    await expect(page.locator('.react-flow__node-agent')).toHaveCount(2);
    await expect(gauge()).toHaveAttribute('aria-label', 'Claude usage: 92% of 5-hour window');
    await gauge().click();
    await expect(panel().getByText(/^Simulated /)).toBeVisible();
    await expect(
      panel().getByRole('button', {
        name: 'Change what happens: Finish the task, then wait for the reset',
      }),
    ).toBeVisible();

    // Clearing the reading, and taking the rule off, go back to main too.
    await panel().getByRole('button', { name: 'Take the usage rule off' }).click();
    await panel().getByRole('button', { name: 'Simulate usage…' }).click();
    await panel().getByRole('button', { name: 'Clear reading' }).click();
    await expect(gauge()).toHaveAttribute('aria-label', 'Claude usage: no reading');
    await expect(panel().getByRole('button', { name: 'Add a rule…' })).toBeVisible();
    await close();
    expect(problems).toEqual([]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
