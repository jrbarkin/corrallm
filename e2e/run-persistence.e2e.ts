import { dismissStart } from './canvas-actions';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * Durable runs through the real app, a real PTY and the fake Claude CLI. The visible queue is
 * the user's record of work; the fake's log independently proves which prompts were dispatched
 * and which exact native conversation was resumed. No real coding-agent CLI is launched.
 */
test.skip(process.platform === 'win32', 'The fake claude is a Node script run through sh.');

let dir: string;
let folder: string;
let profile: string;
let config: string;
let claude: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-run-persistence-'));
  folder = path.join(dir, 'shop');
  profile = path.join(dir, 'profile');
  config = path.join(dir, 'claude-config');
  await Promise.all([mkdir(folder), mkdir(profile), mkdir(config)]);
  claude = path.join(dir, 'claude');
  const fake = path.join(import.meta.dirname, 'fake-claude.mjs');
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(claude, 0o755);
  problems = [];
  await launch();
});

test.afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

async function launch() {
  ({ app, close: closeApp } = await launchApp({
    profile,
    env: { CORRALLM_CLAUDE_PATH: claude, CLAUDE_CONFIG_DIR: config },
  }));
  page = await app.firstWindow();
  page.on('pageerror', (error) => problems.push(error.message));
  await page.waitForLoadState('load');
  await dismissStart(page);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await app.evaluate(
    ({ dialog }, { folder, canvas }) => {
      Object.assign(dialog, {
        showOpenDialog: (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          return Promise.resolve({
            canceled: false,
            filePaths: [options.properties?.includes('openDirectory') ? folder : canvas],
          });
        },
        showSaveDialog: () => Promise.resolve({ canceled: false, filePath: canvas }),
      });
    },
    { folder, canvas: path.join(dir, 'team.corral') },
  );
}

async function close() {
  const closing = closeApp;
  closeApp = undefined;
  await closing?.();
}

async function logged(): Promise<{ event: string; args?: string[]; text?: string }[]> {
  const file = path.join(folder, '.fake-claude', 'log.jsonl');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string });
}

const prompts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'prompt' ? [entry.text] : []));
const starts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'start' ? [entry.args ?? []] : []));

async function ready(count: number) {
  await expect
    .poll(async () => (await logged()).filter((entry) => entry.event === 'ready').length)
    .toBe(count);
}

const view = () => page.getByRole('dialog', { name: 'Agent 1', exact: true });
const queues = () => page.getByRole('dialog', { name: 'All queues' });
const task = (message: string) =>
  queues()
    .getByRole('group', { name: `Agent 1: Message “${message}”`, exact: true })
    .locator('.graph-queue-message');
const submitted = (root: Locator, message: string) =>
  root.locator('.graph-queue-message[data-submission]').filter({ hasText: message });

/** Creates the graph and queue through the UI, then opens its native terminal. */
async function createRun(message: string, named: boolean) {
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  await view()
    .getByRole('button', { name: /^Agent: Claude/ })
    .click();
  await page.keyboard.type('terminal');
  await page.keyboard.press('Enter');
  await expect(view().getByRole('button', { name: 'Agent: Claude · Terminal' })).toBeVisible();
  await expect(view().locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
  await ready(1);
  await view().getByRole('textbox', { name: 'Message to the agent' }).fill(message);
  await view().getByRole('button', { name: 'Back to the canvas' }).click();
  if (named) {
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('team.corral', { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Show all queues' }).click();
  await queues().getByRole('button', { name: 'Run', exact: true }).click();
}

async function nativeMessage(message: string, status: 'running' | 'completed' = 'completed') {
  await view().locator('.agent-terminal').click();
  await page.keyboard.type(message);
  await page.keyboard.press('Enter');
  await expect(submitted(view(), message)).toHaveAttribute('data-run', status);
}

async function originalSession() {
  const [args] = await starts();
  const id = args?.[args.indexOf('--session-id') + 1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id ?? '';
}

async function openResumed(run: number, id: string) {
  await queues().getByRole('button', { name: 'Open Agent 1' }).click();
  await expect(view().locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
  await ready(run);
  const args = (await starts()).at(-1);
  expect(args).toContain(`--resume=${id}`);
  expect(args).not.toContain('--continue');
}

async function restored(named: boolean) {
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    'Agent 1, Claude · Terminal',
  );
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await expect(page.getByText('team.corral', { exact: true })).toHaveCount(named ? 1 : 0);
  await page.getByRole('button', { name: 'Show all queues' }).click();
  await expect(queues().locator('.queues-run-status')).toHaveText('Paused');
  await expect(queues().getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
}

for (const named of [false, true]) {
  test(`restores a ${named ? 'named' : 'draft'} run paused after reload and quit, without replaying its prompts`, async () => {
    const first = 'Finish this once';
    const manual = 'A direct native follow-up';
    await createRun(first, named);
    await expect(task(first)).toHaveAttribute('data-run', 'succeeded');
    const id = await originalSession();
    await queues().getByRole('button', { name: 'Open Agent 1' }).click();
    await nativeMessage(manual);
    await expect.poll(prompts).toEqual([first, manual]);

    // Reload restores both the workflow outcome and the user's separate manual Message row.
    await page.reload();
    await restored(named);
    await expect(task(first)).toHaveAttribute('data-run', 'succeeded');
    await expect(submitted(queues(), manual)).toHaveAttribute('data-run', 'completed');
    expect(await starts()).toHaveLength(1);
    await openResumed(2, id);
    await nativeMessage('After reload');
    await expect.poll(prompts).toEqual([first, manual, 'After reload']);

    // A manual turn cut off by shutdown remains an unresolved record, without replay.
    await nativeMessage('slow manual follow-up', 'running');
    await expect.poll(prompts).toEqual([first, manual, 'After reload', 'slow manual follow-up']);

    // A fresh application process reopens the same profile, including a canvas never saved.
    await close();
    await launch();
    await restored(named);
    await expect(task(first)).toHaveAttribute('data-run', 'succeeded');
    await expect(submitted(queues(), manual)).toHaveAttribute('data-run', 'completed');
    await expect(submitted(queues(), 'After reload')).toHaveAttribute('data-run', 'completed');
    await expect(submitted(queues(), 'slow manual follow-up')).toHaveAttribute(
      'data-unresolved',
      '',
    );
    await expect(submitted(queues(), 'slow manual follow-up')).toContainText('Unresolved');
    expect(await starts()).toHaveLength(2);
    await openResumed(3, id);
    await nativeMessage('After reopen');
    await expect
      .poll(prompts)
      .toEqual([first, manual, 'After reload', 'slow manual follow-up', 'After reopen']);
  });
}

test('restores an interrupted attempt as uncertain and never resends it on Resume', async () => {
  const message = 'slow persistent task';
  await createRun(message, true);
  await expect(task(message)).toHaveAttribute('data-run', 'running');
  await expect.poll(prompts).toEqual([message]);
  const id = await originalSession();

  await page.reload();
  await restored(true);
  await expect(task(message)).toHaveAttribute('data-problem', 'uncertain');
  await expect(task(message).locator('.graph-queue-problem')).toContainText(
    'Inspect its native conversation before resolving or retrying.',
  );
  await expect(task(message).locator('.graph-queue-attempts summary')).toContainText('Uncertain');
  await queues().getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(task(message)).toHaveAttribute('data-problem', 'uncertain');
  await openResumed(2, id);
  await expect.poll(prompts).toEqual([message]);
});
