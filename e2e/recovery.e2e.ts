import { dismissStart, canvasAction, openNeeds } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';
import { crashCore } from './core-crash';

// The real renderer, IPC and Agent SDK, against a protocol-speaking CLI fake. Its prompt log
// proves a held task does not resend work or release dependent queues before the user decides.
const FAKE_CLAUDE = path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs');

interface Prompt {
  sessionId: string;
  text: string;
}

let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let dir: string;
let log: string;
let problems: string[];

test.beforeEach(async () => {
  await chmod(FAKE_CLAUDE, 0o755);
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-recovery-'));
  log = path.join(dir, 'prompts.jsonl');
  ({ app, close: closeApp } = await launchApp({
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': FAKE_CLAUDE }),
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
      FAKE_CLAUDE_PROMPTS: log,
      FAKE_CLAUDE_TURN_GATES: JSON.stringify({ 'continuity-first': path.join(dir, 'continue') }),
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
  await dismissStart(page);
});

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

async function prompts(): Promise<Prompt[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Prompt);
}

/** Authored tasks are loaded as a canvas; the run itself is never mocked or called by the test. */
async function openCanvas(queue: unknown[], dependent = false) {
  const folder = path.join(dir, 'shop');
  const canvas = path.join(dir, 'recovery.corral');
  await mkdir(folder);
  await writeFile(
    canvas,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: [
        {
          id: 'builder',
          kind: 'agent',
          label: 'Builder',
          position: { x: 0, y: 0 },
          adapter: 'claude-code',
          connection: 'claude-code.sdk',
          queue,
        },
        ...(dependent
          ? [
              {
                id: 'dependent',
                kind: 'agent',
                label: 'Verifier',
                position: { x: 400, y: 0 },
                adapter: 'claude-code',
                connection: 'claude-code.sdk',
                queue: [
                  { id: 'wait', waitFor: [{ agent: 'builder', item: 'objective' }] },
                  { id: 'verify', message: 'recovery-dependent' },
                ],
              },
            ]
          : []),
      ],
      links: [],
    }),
  );
  await app.evaluate(
    ({ dialog }, { folder, canvas }) => {
      Object.assign(dialog, {
        showOpenDialog: (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          const picked = options.properties?.includes('openDirectory') ? folder : canvas;
          return Promise.resolve({ canceled: false, filePaths: [picked] });
        },
      });
    },
    { folder, canvas },
  );
  await canvasAction(page, 'Open…');
  await expect(page.getByText('recovery.corral', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all queues' }).click();
  return page.getByRole('dialog', { name: 'All queues', exact: true });
}

function row(scope: Locator, agent: string, item: string) {
  return scope.locator(`[data-at='${JSON.stringify([agent, item])}']`);
}

test('corrects a failed task in its same console, retaining attempts and releasing a dependent only on success', async () => {
  const instruction = 'recovery-failed: inspect the release checklist';
  const queues = await openCanvas(
    [
      { id: 'objective', action: 'Read', instruction },
      { id: 'follow', message: 'recovery-followup' },
    ],
    true,
  );
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  const objective = row(queues, 'builder', 'objective');
  await expect(objective).toHaveAttribute('data-run', 'asking');
  await expect(objective).toHaveAttribute('data-problem', 'failed');
  await expect(row(queues, 'dependent', 'wait')).toHaveAttribute('data-run', 'waiting');
  await expect(queues.getByRole('status')).toContainText('1 needs you');
  expect(await prompts()).toHaveLength(1);

  // The same hold appears on the canvas and in the actual agent view, beside its conversation.
  await queues.getByRole('button', { name: 'Back', exact: true }).click();
  await openNeeds(page);
  const needs = page.getByRole('complementary', { name: 'Needs you' });
  await expect(needs.getByText('The agent reported that this step failed.')).toBeVisible();
  await expect(needs.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await needs.getByRole('button', { name: 'Open Builder' }).click();
  const view = page.getByRole('dialog', { name: 'Builder', exact: true });
  const task = row(view, 'builder', 'objective');
  await task.locator('summary').click();
  await expect(task.getByText('Attempt 1 · Failed', { exact: true })).toBeVisible();
  await expect(view.getByRole('log', { name: 'Transcript' })).toContainText(
    'The original task needs a correction.',
  );
  const before = (await prompts())[0];

  const correction = 'recovery-corrected: include the missing release note';
  const composer = view.getByRole('textbox', { name: 'Message Builder', exact: true });
  await composer.fill(correction);
  await composer.press('Enter');
  await expect(task).toHaveAttribute('data-run', 'succeeded');
  await expect(task.getByText('Attempt 2 · Succeeded', { exact: true })).toBeVisible();
  await expect(task.getByText(correction, { exact: true })).toBeVisible();
  const submitted = view.locator('.graph-queue-message[data-submission]');
  await expect(submitted).toHaveCount(1);
  await expect(submitted).toContainText(correction);
  await expect(submitted).toHaveAttribute('data-run', 'completed');
  await expect(submitted.getByRole('button')).toHaveCount(0);
  await view.getByRole('button', { name: 'All queues', exact: true }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  await expect(row(queues, 'dependent', 'wait')).toHaveAttribute('data-run', 'succeeded');
  await expect(row(queues, 'dependent', 'verify')).toHaveAttribute('data-run', 'succeeded');
  const sent = await prompts();
  expect(sent).toHaveLength(4);
  expect(sent[1]).toMatchObject({ sessionId: before?.sessionId });
  expect(sent[1]?.text).toContain(correction);
  expect(sent[1]?.text).toContain(instruction);
  expect(
    sent
      .slice(2)
      .map(({ text }) => text)
      .sort(),
  ).toEqual(['recovery-dependent', 'recovery-followup']);
});

test('holds a missing verdict and retries only when asked, retaining both unresolved attempts', async () => {
  const queues = await openCanvas([
    { id: 'objective', action: 'Read', instruction: 'recovery-missing: inspect the checklist' },
    { id: 'follow', message: 'recovery-followup' },
  ]);
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  const objective = row(queues, 'builder', 'objective');
  await expect(objective).toHaveAttribute('data-problem', 'uncertain');
  await expect(objective).toHaveAttribute('data-problem-reason', 'missing-verdict');
  await expect(objective).toHaveAttribute('data-run', 'asking');
  expect(await prompts()).toHaveLength(1);
  await objective.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(objective.locator('summary')).toContainText('2 attempts');
  await expect(objective).toHaveAttribute('data-run', 'asking');
  await expect(objective).toHaveAttribute('data-problem', 'uncertain');
  const sent = await prompts();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ sessionId: sent[0]?.sessionId, text: sent[0]?.text });
  await objective.locator('summary').click();
  await expect(objective.getByText('Attempt 1 · Uncertain', { exact: true })).toBeVisible();
  await expect(objective.getByText('Attempt 2 · Uncertain', { exact: true })).toBeVisible();
  // Resolving is a human decision, without another backend attempt or replay of the old prompt.
  await objective.getByRole('button', { name: 'Mark resolved', exact: true }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  expect((await prompts()).map(({ text }) => text)).toEqual([
    sent[0]?.text,
    sent[0]?.text,
    'recovery-followup',
  ]);
});

test('Stop preserves a cancelled attempt, and accepting cancellation skips an If failed branch', async () => {
  const queues = await openCanvas([
    { id: 'objective', action: 'Read', instruction: 'recovery-slow: inspect the checklist' },
    {
      id: 'failed',
      if: { kind: 'failed' },
      then: [{ id: 'repair', message: 'recovery-failure-branch' }],
    },
    { id: 'follow', message: 'recovery-after-cancel' },
  ]);
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  const objective = row(queues, 'builder', 'objective');
  await expect.poll(async () => (await prompts()).length).toBe(1);
  await expect(objective).toHaveAttribute('data-run', 'running');
  await queues.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(queues.getByRole('status')).toHaveText('Paused');
  await expect(objective).toHaveAttribute('data-problem', 'cancelled');
  await expect(objective.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(objective.locator('summary')).toContainText('Cancelled');
  expect(await prompts()).toHaveLength(1);
  await queues.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(objective).toHaveAttribute('data-run', 'asking');
  expect(await prompts()).toHaveLength(1);
  await objective.getByRole('button', { name: 'Continue cancelled', exact: true }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  await expect(objective).toHaveAttribute('data-run', 'cancelled');
  await expect(row(queues, 'builder', 'failed')).toHaveAttribute('data-run', 'skipped');
  expect((await prompts()).map(({ text }) => text)).toEqual([
    expect.stringContaining('recovery-slow'),
    'recovery-after-cancel',
  ]);
});

test('keeps an unclear condition held across a core crash until the user decides it', async () => {
  let queues = await openCanvas([
    {
      id: 'check',
      if: { kind: 'freeText', text: 'recovery-missing: is the checklist complete?' },
      then: [{ id: 'objective', message: 'recovery-condition-branch' }],
    },
    { id: 'follow', message: 'recovery-condition-followup' },
  ]);
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(row(queues, 'builder', 'check')).toHaveAttribute('data-problem', 'uncertain');
  expect(await prompts()).toHaveLength(1);

  await crashCore(app);
  // All queues stays open while the window binds the replacement core (§8).
  queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  await expect(queues.getByRole('status')).toHaveText('Paused');
  await queues.getByRole('button', { name: 'Resume', exact: true }).click();
  const check = row(queues, 'builder', 'check');
  await expect(check).toHaveAttribute('data-problem', 'uncertain');
  await expect(check.getByRole('button', { name: 'Condition holds', exact: true })).toBeVisible();
  expect(await prompts()).toHaveLength(1);
  await check.getByRole('button', { name: 'Condition holds', exact: true }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  expect((await prompts()).slice(1).map(({ text }) => text)).toEqual([
    'recovery-condition-branch',
    'recovery-condition-followup',
  ]);
});

for (const leaving of ['reload', 'close'] as const) {
  test(`a window ${leaving} leaves its turn and the next task running in the core`, async () => {
    let queues = await openCanvas([
      { id: 'first', message: 'continuity-first' },
      { id: 'next', message: 'continuity-next' },
    ]);
    await queues.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(row(queues, 'builder', 'first')).toHaveAttribute('data-run', 'running');
    await expect
      .poll(async () =>
        readFile(path.join(dir, 'continue.waiting'), 'utf8').then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    if (leaving === 'reload') await page.reload();
    else {
      const closed = page.waitForEvent('close');
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
      await closed;
    }
    // Release by an observed backend event, not a race against a fixed-duration turn.
    await writeFile(path.join(dir, 'continue'), 'go');
    await expect
      .poll(async () => (await prompts()).map(({ text }) => text))
      .toEqual(['continuity-first', 'continuity-next']);
    if (leaving === 'close') {
      const reopened = app.waitForEvent('window');
      await app.evaluate(({ app }) => {
        app.emit('second-instance', {}, [], process.cwd());
      });
      page = await reopened;
      page.on('pageerror', (error) => problems.push(error.message));
      await page.waitForLoadState('load');
    }
    await page.getByRole('button', { name: 'Show all queues' }).click();
    queues = page.getByRole('dialog', { name: 'All queues', exact: true });
    await expect(row(queues, 'builder', 'first')).toHaveAttribute('data-run', 'succeeded');
    await expect(row(queues, 'builder', 'next')).toHaveAttribute('data-run', 'succeeded');
    await expect(queues.getByRole('status')).toHaveText('All done');
    expect(new Set((await prompts()).map(({ sessionId }) => sessionId)).size).toBe(1);
  });
}
