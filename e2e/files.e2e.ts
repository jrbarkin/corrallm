import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { launchApp } from './launch';

let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let dir: string;

test.beforeEach(async () => {
  ({ app, close: closeApp } = await launchApp());
  page = await app.firstWindow();
  await page.waitForLoadState('load');
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-files-'));
});

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
});

/** The native window's title, which follows the page's. */
const windowTitle = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());

test('saves a canvas as a .corral file, and opens it again', async () => {
  // Playwright cannot click native dialogs: these answer for the user, in the main process.
  const chosen = path.join(dir, 'team');
  await app.evaluate(({ dialog }, file) => {
    Object.assign(dialog, {
      showSaveDialog: () => Promise.resolve({ canceled: false, filePath: file }),
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [`${file}.corral`] }),
    });
  }, chosen);

  const pane = page.locator('.react-flow__pane');
  const nodes = page.locator('.react-flow__node');
  await pane.dblclick({ position: { x: 300, y: 200 } });
  await pane.dblclick({ position: { x: 600, y: 400 } });
  await expect(nodes).toHaveCount(2);
  await expect.poll(windowTitle).toBe('Untitled (edited) — corrallm');

  // Saved where the dialog said, with the extension added.
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(windowTitle).toBe('team.corral — corrallm');
  const saved = JSON.parse(await readFile(`${chosen}.corral`, 'utf8')) as {
    format: string;
    nodes: { label: string }[];
  };
  expect(saved.format).toBe('corrallm');
  expect(saved.nodes.map((n) => n.label)).toEqual(['Agent 1', 'Agent 2']);

  // A new canvas, then the file opened again.
  await page.getByRole('button', { name: 'New' }).click();
  await expect(nodes).toHaveCount(0);
  await expect.poll(windowTitle).toBe('Untitled — corrallm');
  await page.keyboard.press('ControlOrMeta+o');
  await expect(nodes).toHaveText(['Agent 1', 'Agent 2']);
  await expect.poll(windowTitle).toBe('team.corral — corrallm');
});
