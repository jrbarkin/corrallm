import { dismissStart, canvasAction } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';
import { crashCoreAndReload } from './core-crash';

// The real app, IPC and native connectors, using only protocol-speaking fake CLIs. Independent
// prompt/process logs distinguish holding a queue from interrupting or closing its conversation.
interface Agent {
  id: string;
  label: string;
  queue: unknown[];
}
interface NativeLog {
  event: string;
  text?: string;
}

let dir: string;
let folder: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-agent-controls-'));
  folder = path.join(dir, 'shop');
  await Promise.all([
    mkdir(folder),
    mkdir(path.join(dir, 'profile')),
    mkdir(path.join(dir, 'config')),
  ]);
  problems = [];
});

test.afterEach(async () => {
  await closeApp?.();
  closeApp = undefined;
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

async function launch(
  connection: 'claude-code.sdk' | 'claude-code.terminal',
  gates: Record<string, string> = {},
) {
  let claude = path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs');
  if (connection === 'claude-code.terminal') {
    claude = path.join(dir, 'claude');
    const fake = path.join(import.meta.dirname, 'fake-claude.mjs');
    await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  }
  await chmod(claude, 0o755);
  ({ app, close: closeApp } = await launchApp({
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    profile: path.join(dir, 'profile'),
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': claude }),
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      FAKE_CLAUDE_PROMPTS: path.join(dir, 'prompts.jsonl'),
      FAKE_CLAUDE_TURN_GATES: JSON.stringify(gates),
    },
  }));
  page = await app.firstWindow();
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    // xterm reports a long glyph-cache warmup as a warning on busy machines; the existing
    // Terminal suites exclude this timing diagnostic too, while checking every other warning.
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  await page.waitForLoadState('load');
  await dismissStart(page);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
}

async function openCanvas(connection: 'claude-code.sdk' | 'claude-code.terminal', agents: Agent[]) {
  const canvas = path.join(dir, 'controls.corral');
  await writeFile(
    canvas,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: agents.map((agent, index) => ({
        ...agent,
        kind: 'agent',
        adapter: 'claude-code',
        connection,
        position: { x: index * 350, y: 0 },
      })),
      links: [],
    }),
  );
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
      });
    },
    { folder, canvas },
  );
  await canvasAction(page, 'Open…');
  await expect(page.getByText('controls.corral', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all queues' }).click();
  return page.getByRole('dialog', { name: 'All queues', exact: true });
}

function row(scope: Locator, agent: string, item: string) {
  return scope.locator(`[data-at='${JSON.stringify([agent, item])}']`);
}

const heading = (queues: Locator) => queues.locator('.queues-head[data-agent-menu="builder"]');
const menu = () => page.getByRole('menu', { name: 'Builder controls', exact: true });

async function control(queues: Locator, action: 'Pause' | 'Kill' | 'Resume') {
  await heading(queues).click({ button: 'right' });
  await menu()
    .getByRole('menuitem', { name: new RegExp(`^${action}`) })
    .click();
  await expect(menu()).toHaveCount(0);
}

async function sdkPrompts(): Promise<string[]> {
  const text = await readFile(path.join(dir, 'prompts.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { text: string }).text);
}

async function nativeLog(): Promise<NativeLog[]> {
  const text = await readFile(path.join(folder, '.fake-claude', 'log.jsonl'), 'utf8').catch(
    () => '',
  );
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NativeLog);
}

const nativePrompts = async () =>
  (await nativeLog()).flatMap((entry) => (entry.event === 'prompt' ? [entry.text] : []));

test('Pause finishes the current turn while independent work continues and a dependent waits; Resume releases once', async () => {
  const first = 'control first';
  const release = path.join(dir, 'finish-first');
  await launch('claude-code.sdk', { [first]: release });
  const next = 'control second';
  const parallel = 'control parallel';
  const dependent = 'control dependent';
  const queues = await openCanvas('claude-code.sdk', [
    {
      id: 'builder',
      label: 'Builder',
      queue: [
        { id: 'first', message: first },
        { id: 'next', message: next },
      ],
    },
    { id: 'independent', label: 'Independent', queue: [{ id: 'parallel', message: parallel }] },
    {
      id: 'dependent',
      label: 'Verifier',
      queue: [
        { id: 'wait', waitFor: [{ agent: 'builder', item: 'next' }] },
        { id: 'verify', message: dependent },
      ],
    },
  ]);
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  // Native startup (a Node process and its handshake) can outlast Playwright's default five seconds.
  await expect.poll(sdkPrompts, { timeout: 15_000 }).toContain(first);
  await expect.poll(() => readFile(`${release}.waiting`, 'utf8').catch(() => '')).toBe('waiting');
  await expect(row(queues, 'builder', 'first')).toHaveAttribute('data-run', 'running');
  await control(queues, 'Pause');
  await expect(heading(queues).getByText('Pausing', { exact: true })).toBeVisible();
  await expect(queues.getByRole('status')).toContainText('1 pausing');
  await expect(row(queues, 'independent', 'parallel')).toHaveAttribute('data-run', 'succeeded');
  await expect(row(queues, 'dependent', 'wait')).toHaveAttribute('data-run', 'waiting');
  // Release only after Pause was observed and independent work finished. The former "slow"
  // prompt needed forty separate 100 ms timers; their scheduling delays accumulated under load.
  await writeFile(release, 'go');
  await expect(row(queues, 'builder', 'first')).toHaveAttribute('data-run', 'succeeded', {
    timeout: 10_000,
  });
  await expect(heading(queues).getByText('Paused', { exact: true })).toBeVisible();
  await expect(queues.getByRole('status')).toContainText('1 waiting');
  await expect(queues.getByRole('status')).toContainText('1 paused');
  expect((await sdkPrompts()).sort()).toEqual([first, parallel].sort());
  await expect(row(queues, 'dependent', 'wait')).toHaveAttribute('data-run', 'waiting');

  // The same scoped menu is available from the keyboard, and Escape leaves the queue intact.
  await heading(queues).getByRole('button', { name: 'Open Builder', exact: true }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu().getByRole('menuitem', { name: /^Resume/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await expect(queues).toBeVisible();

  await control(queues, 'Resume');
  await expect(queues.getByRole('status')).toHaveText('All done');
  await expect(row(queues, 'builder', 'next')).toHaveAttribute('data-run', 'succeeded');
  await expect(row(queues, 'dependent', 'wait')).toHaveAttribute('data-run', 'succeeded');
  await expect(row(queues, 'dependent', 'verify')).toHaveAttribute('data-run', 'succeeded');
  expect((await sdkPrompts()).sort()).toEqual([first, next, parallel, dependent].sort());
});

test('Kill interrupts the native turn while retaining its live console for a manual Message and later Resume', async () => {
  test.skip(process.platform === 'win32', 'The fake claude is a Node script run through sh.');
  await launch('claude-code.terminal');
  const first = 'slow control current';
  const next = 'control after resume';
  const correction = 'A native correction completes the objective';
  const queues = await openCanvas('claude-code.terminal', [
    {
      id: 'builder',
      label: 'Builder',
      queue: [
        { id: 'first', message: first },
        { id: 'next', message: next },
      ],
    },
  ]);
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  // Native startup includes login-shell discovery and the first-run hook handshake. Parallel
  // connection suites can take longer than Playwright's default five-second assertion window.
  await expect.poll(nativePrompts, { timeout: 15_000 }).toEqual([first]);
  await expect(row(queues, 'builder', 'first')).toHaveAttribute('data-run', 'running');
  await control(queues, 'Kill');
  await expect(row(queues, 'builder', 'first')).toHaveAttribute('data-problem', 'cancelled');
  await expect(heading(queues).getByText('Paused', { exact: true })).toBeVisible();
  await queues.getByRole('button', { name: 'Open Builder', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'Builder', exact: true });
  const terminal = view.locator('.agent-terminal');
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await expect(view.locator('.agent-terminal-status')).toHaveText('Idle');

  await terminal.click();
  await page.keyboard.type(correction);
  await page.keyboard.press('Enter');
  const submitted = view
    .locator('.graph-queue-message[data-submission]')
    .filter({ hasText: correction });
  await expect(submitted).toHaveAttribute('data-run', 'completed');
  await expect(submitted).toContainText('Message');
  await expect(row(view, 'builder', 'first')).toHaveAttribute('data-run', 'succeeded');
  await expect.poll(nativePrompts).toEqual([first, correction]);
  await expect(terminal).toHaveAttribute('data-state', 'live');
  expect((await nativeLog()).filter(({ event }) => event === 'start')).toHaveLength(1);
  expect((await nativeLog()).filter(({ event }) => event === 'signal' || event === 'exit')).toEqual(
    [],
  );

  await view.getByRole('button', { name: 'All queues', exact: true }).click();
  await expect(heading(queues).getByText('Paused', { exact: true })).toBeVisible();
  await control(queues, 'Resume');
  await expect(queues.getByRole('status')).toHaveText('All done');
  await expect(row(queues, 'builder', 'next')).toHaveAttribute('data-run', 'succeeded');
  expect(await nativePrompts()).toEqual([first, correction, next]);
  expect((await nativeLog()).filter(({ event }) => event === 'start')).toHaveLength(1);
  expect((await nativeLog()).filter(({ event }) => event === 'signal' || event === 'exit')).toEqual(
    [],
  );
});

test('a canvas pause chosen before Run survives a core crash and global Resume until that agent is resumed', async () => {
  await launch('claude-code.sdk');
  const held = 'control held before start';
  const parallel = 'control other completes';
  let queues = await openCanvas('claude-code.sdk', [
    { id: 'builder', label: 'Builder', queue: [{ id: 'held', message: held }] },
    { id: 'independent', label: 'Independent', queue: [{ id: 'parallel', message: parallel }] },
  ]);
  await queues.getByRole('button', { name: 'Back', exact: true }).click();
  const builder = page.locator('.react-flow__node-agent[data-id="builder"]');
  await builder.click({ button: 'right' });
  await menu()
    .getByRole('menuitem', { name: /^Pause/ })
    .click();
  await expect(
    builder.locator('.graph-agent-control').filter({ hasText: /^Paused$/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Show all queues' }).click();
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(row(queues, 'independent', 'parallel')).toHaveAttribute('data-run', 'succeeded');
  await expect(heading(queues).getByText('Paused', { exact: true })).toBeVisible();
  expect(await sdkPrompts()).toEqual([parallel]);

  await crashCoreAndReload(app, page);
  await expect(page.locator('.react-flow__node-agent')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show all queues' }).click();
  queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  await expect(queues.getByRole('status')).toHaveText('Paused');
  await queues.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(heading(queues).getByText('Paused', { exact: true })).toBeVisible();
  await expect(row(queues, 'independent', 'parallel')).toHaveAttribute('data-run', 'succeeded');
  expect(await sdkPrompts()).toEqual([parallel]);

  await control(queues, 'Resume');
  await expect(queues.getByRole('status')).toHaveText('All done');
  await expect(row(queues, 'builder', 'held')).toHaveAttribute('data-run', 'succeeded');
  expect(await sdkPrompts()).toEqual([parallel, held]);
});
