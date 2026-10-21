import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { newCanvasId } from '../src/shared/canvas';
import { launchApp } from './launch';

let app: ElectronApplication;
let page: Page;
let closeApp: () => Promise<void>;
let dir: string;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-canvases-'));
  await mkdir(path.join(dir, 'project'));
  ({ app, close: closeApp } = await launchApp());
  page = await app.firstWindow();
  problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  await page.waitForLoadState('load');
  await expect(page.getByRole('button', { name: 'Open…', exact: true })).toBeVisible();
});
test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});
async function fixture(name: string, label: string) {
  const file = path.join(dir, name);
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: newCanvasId(),
      nodes: [{ id: 'agent', kind: 'agent', label, position: { x: 300, y: 200 } }],
      links: [],
    }),
  );
  return file;
}
async function open(file: string) {
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, file);
  await page.getByRole('button', { name: 'Open…', exact: true }).click();
  await expect(page.locator('.graph-file-name')).toHaveText(path.basename(file));
}
const node = (label: string) =>
  page.locator('.react-flow__node').filter({ hasText: new RegExp(`^${label}$`) });
async function list() {
  await page.getByRole('button', { name: 'Canvases', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Canvases', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the Canvases list shows and closes a canvas, keeping its unsaved changes', async () => {
  const first = await fixture('first.corral', 'First');
  const second = await fixture('second.corral', 'Second');
  await open(first);
  await node('First').click();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Changed');
  await page.keyboard.press('Enter');
  await expect(node('Changed')).toBeVisible();
  await open(second);
  let canvases = await list();
  const kept = canvases
    .getByRole('listitem')
    .filter({ has: page.getByText('first.corral', { exact: true }) });
  await expect(kept).toContainText('Edited');
  await expect(kept).toContainText('Open');
  await kept.getByRole('button', { name: 'Show first.corral', exact: true }).click();
  await expect(node('Changed')).toBeVisible();
  canvases = await list();
  await canvases.getByRole('button', { name: 'Close first.corral', exact: true }).click();
  await expect(node('Second')).toBeVisible();
  const closed = page
    .getByRole('dialog', { name: 'Canvases', exact: true })
    .getByRole('listitem')
    .filter({ has: page.getByText('first.corral', { exact: true }) });
  await expect(closed).toContainText('Closed');
  await expect(closed).toContainText('Edited');
  await closed.getByRole('button', { name: 'Show first.corral', exact: true }).click();
  await expect(node('Changed')).toBeVisible();
  expect(
    (JSON.parse(await readFile(first, 'utf8')) as { nodes: { label: string }[] }).nodes[0]?.label,
  ).toBe('First');
});

test('a file changed on disk raises one review in the app, applied or kept', async () => {
  const file = await fixture('review.corral', 'Before');
  await open(file);
  const original = JSON.parse(await readFile(file, 'utf8')) as { nodes: { label: string }[] };
  const external = (label: string) =>
    JSON.stringify({ ...original, nodes: original.nodes.map((agent) => ({ ...agent, label })) });
  await writeFile(file, external('Applied'));
  const sidebar = page.getByRole('complementary', { name: 'Needs you' });
  const reviews = sidebar.getByRole('article');
  await expect(reviews).toHaveCount(1);
  await expect(reviews).toContainText('review.corral changed on disk');
  await expect(reviews).toContainText('Before');
  await reviews.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(node('Applied')).toBeVisible();
  await expect(reviews.getByRole('status')).toHaveText('Applied.');
  await reviews.getByRole('button', { name: /^Dismiss / }).click();
  await expect(sidebar).toHaveCount(0);
  await writeFile(file, external('Kept on disk'));
  await expect(reviews).toHaveCount(1);
  await reviews.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(reviews.getByRole('status')).toHaveText('Kept.');
  await expect(node('Applied')).toBeVisible();
  await expect(node('Kept on disk')).toHaveCount(0);
  await reviews.getByRole('button', { name: /^Dismiss / }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      async () =>
        (JSON.parse(await readFile(file, 'utf8')) as { nodes: { label: string }[] }).nodes[0]
          ?.label,
    )
    .toBe('Applied');
  await expect(sidebar).toHaveCount(0);
});
