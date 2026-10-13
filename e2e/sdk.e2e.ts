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
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-sdk-'));
  // An API key (the fake's: it reaches only the fake), which the Agent SDK connection needs; and
  // a Claude config folder of the test's own, where the fake keeps its conversations' transcripts
  // and main's Agent SDK reads them.
  ({ app, close: closeApp } = await launchApp({
    env: {
      CORRALLM_CLAUDE_PATH: FAKE_CLAUDE,
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
    },
  }));
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

  // Slash commands and the project's files complete as they are typed: the session's, then
  // Claude Code's own screens, which run in Terminal.
  await composer.fill('/co');
  await expect(view.getByRole('listbox', { name: 'Commands' }).getByRole('option')).toHaveText([
    /^\/compact/,
    /^\/context/,
    /^\/configIn Terminal/,
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

test('opens a link in a reply in the browser once main has asked, and not again for that site', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  // Main's dialogs and browser, for the user: the folder picked, links allowed always.
  await app.evaluate(({ dialog, shell }, picked) => {
    const seen = globalThis as unknown as { asked: string[]; opened: string[] };
    seen.asked = [];
    seen.opened = [];
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
      showMessageBox: (...args: unknown[]) => {
        seen.asked.push((args.at(-1) as { message: string }).message);
        return Promise.resolve({ response: 0, checkboxChecked: true });
      },
    });
    Object.assign(shell, {
      openExternal: (url: string) => {
        seen.opened.push(url);
        return Promise.resolve();
      },
    });
  }, folder);
  const seen = () =>
    app
      .evaluate(() => globalThis as unknown as { asked: string[]; opened: string[] })
      .then(({ asked, opened }) => ({ asked, opened }));
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('agent sdk');
  await page.keyboard.press('Enter');
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  await composer.fill('markdown, please');
  await composer.press('Enter');

  const link = view.getByRole('log', { name: 'Transcript' }).getByRole('link', {
    name: 'the queue docs',
  });
  await link.click();
  await expect.poll(seen).toEqual({
    asked: ['Open docs.example.com in your browser?'],
    opened: ['https://docs.example.com/queues'],
  });
  // "Always for this site": it opens without asking now. The app never navigated away.
  await link.click();
  await expect.poll(async () => (await seen()).opened).toHaveLength(2);
  expect((await seen()).asked).toHaveLength(1);
  await expect(view).toBeVisible();
});

test('opens another conversation of the project folder in an agent with /resume', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  const connect = async (name: string) => {
    const view = page.getByRole('dialog', { name });
    await view.getByRole('button', { name: /^Agent: Claude/ }).click();
    await page.keyboard.type('agent sdk');
    await page.keyboard.press('Enter');
    await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
    return view;
  };

  // Agent 1 has a conversation.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 300, y: 300 } });
  await page.locator('.react-flow__node').first().dblclick();
  const first = await connect('Agent 1');
  await first.getByRole('textbox', { name: 'Message Agent 1' }).fill('Remember the shop');
  await first.getByRole('textbox', { name: 'Message Agent 1' }).press('Enter');
  await expect(first.getByText('You said: Remember the shop')).toBeVisible();
  await expect(first.getByText(/^Worked for \d+s$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first).toHaveCount(0);

  // Agent 2 opens it.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 600, y: 420 } });
  await page.locator('.react-flow__node').nth(1).dblclick();
  const second = await connect('Agent 2');
  const composer = second.getByRole('textbox', { name: 'Message Agent 2' });
  await composer.fill('/resume');
  await composer.press('Enter');
  const picker = second.getByRole('listbox', { name: 'Resume a conversation' });
  await expect(picker.getByRole('option')).toHaveText([/^Remember the shop just now/]);
  await picker.getByRole('option').click();
  const transcript = second.getByRole('log', { name: 'Transcript' });
  await expect(transcript.getByText('Remember the shop', { exact: true })).toBeVisible();
  await expect(transcript.getByText('You said: Remember the shop')).toBeVisible();

  // It goes on from there.
  await composer.fill('And the cart');
  await composer.press('Enter');
  await expect(transcript.getByText('You said: And the cart')).toBeVisible();
});
