import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * A Claude agent connected through the Agent SDK, in the built app: the SDK bundled into main
 * runs a fake `claude` (src/main/sessions/sdk/fake-claude.mjs, found through
 * CORRALLM_CLAUDE_PATH) that speaks the CLI's protocol, never Claude itself.
 */

const FAKE_CLAUDE = path.resolve('src/main/sessions/sdk/fake-claude.mjs');

let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let dir: string;
let problems: string[];

test.beforeEach(async () => {
  await chmod(FAKE_CLAUDE, 0o755);
  ({ app, close: closeApp } = await launchApp({ env: { CORRALLM_CLAUDE_PATH: FAKE_CLAUDE } }));
  page = await app.firstWindow();
  problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.waitForLoadState('load');
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-sdk-'));
});

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

test('runs a Claude agent through the Agent SDK: a turn, a prompt, completions, an interrupt', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await writeFile(path.join(folder, 'README.md'), '# Shop\n');
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();

  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('agent sdk');
  await page.keyboard.press('Enter');
  // The session started: the CLI's models are offered.
  await expect(view.getByRole('button', { name: 'Model: Default (recommended)' })).toBeVisible();

  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  const transcript = view.getByRole('log', { name: 'Transcript' });

  // Slash commands and the project's files complete as they are typed.
  await composer.fill('/co');
  await expect(view.getByRole('listbox', { name: 'Commands' }).getByRole('option')).toHaveText([
    /^\/compact/,
    /^\/context/,
  ]);
  await composer.fill('see @READ');
  await expect(
    view.getByRole('listbox', { name: 'Files' }).getByRole('option', { name: 'README.md' }),
  ).toBeVisible();
  await composer.press('Tab');
  await expect(composer).toHaveValue('see @README.md ');

  // A turn: it asks before running a command, runs it once allowed, and says what it cost.
  await composer.fill('please run it');
  await composer.press('Enter');
  await expect(transcript.getByText('You said: please run it')).toBeVisible();
  const prompt = transcript.getByRole('group', { name: 'Bash command: echo hello' });
  await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(transcript.getByRole('button', { name: 'Bash echo hello' })).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();
  await expect(view.getByText('$0.01 · 1% context')).toBeVisible();

  // Escape interrupts a turn.
  await composer.fill('a slow story');
  await composer.press('Enter');
  await expect(transcript.getByText(/^0 1 /)).toBeVisible();
  await composer.press('Escape');
  await expect(transcript.getByText(/^Interrupted · \d+s$/)).toBeVisible();
});
