import { dismissStart, canvasAction } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { launchApp } from './launch';
import { crashCore } from './core-crash';

// Group ownership through the real renderer, IPC and Agent SDK, against a fake CLI only.
// Its independent prompt log proves that nested/individual holds do not leak or replay work.
interface Node {
  id: string;
  kind: 'agent' | 'group';
  label: string;
  position: { x: number; y: number };
  parent?: string;
  queue?: unknown[];
}
interface Prompt {
  sessionId: string;
  text: string;
}

let dir: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-group-controls-'));
  await Promise.all([
    mkdir(path.join(dir, 'shop')),
    mkdir(path.join(dir, 'profile')),
    mkdir(path.join(dir, 'config')),
  ]);
  problems = [];
  ({ app, close: closeApp } = await launchApp({
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    profile: path.join(dir, 'profile'),
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({
        'claude-code': path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs'),
      }),
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      FAKE_CLAUDE_PROMPTS: path.join(dir, 'prompts.jsonl'),
    },
  }));
  page = await app.firstWindow();
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  await page.waitForLoadState('load');
  await dismissStart(page);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
});

test.afterEach(async () => {
  await closeApp?.();
  closeApp = undefined;
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

const queues = () => page.getByRole('dialog', { name: 'All queues', exact: true });
const menu = (name: string) => page.getByRole('menu', { name: `${name} controls`, exact: true });
const frame = (id: string) => page.locator(`.react-flow__node-frame[data-id="${id}"]`);
const heading = (id: string) => queues().locator(`.queues-head[data-agent-menu="${id}"]`);
const row = (agent: string, item: string, scope = queues()) =>
  scope.locator(`[data-at='${JSON.stringify([agent, item])}']`);

function agent(id: string, label: string, queue: unknown[], parent?: string, x = 20, y = 60): Node {
  return { id, kind: 'agent', label, position: { x, y }, queue, ...(parent ? { parent } : {}) };
}

async function openCanvas(nodes: Node[]) {
  const canvas = path.join(dir, 'groups.corral');
  await writeFile(
    canvas,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: nodes.map((node) =>
        node.kind === 'agent'
          ? { ...node, adapter: 'claude-code', connection: 'claude-code.sdk' }
          : node,
      ),
      links: [],
    }),
  );
  await app.evaluate(
    ({ dialog }, { canvas, folder }) => {
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
    { canvas, folder: path.join(dir, 'shop') },
  );
  await canvasAction(page, 'Open…');
  await expect(page.getByText('groups.corral', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await showQueues();
}

async function showQueues() {
  await page.getByRole('button', { name: 'Show all queues' }).click();
  await expect(queues()).toBeVisible();
}

async function frameControl(id: string, name: string, action: 'Pause' | 'Kill' | 'Resume') {
  if (await queues().isVisible())
    await queues().getByRole('button', { name: 'Back', exact: true }).click();
  await frame(id)
    .locator('.graph-frame-title')
    .click({ button: 'right', position: { x: 40, y: 12 } });
  await expect(menu(name)).toBeVisible();
  await menu(name)
    .getByRole('menuitem', { name: new RegExp(`^${action}`) })
    .click();
  await expect(menu(name)).toHaveCount(0);
}

async function agentControl(
  id: string,
  name: string,
  action: 'Pause' | 'Kill' | 'Resume',
  group = false,
) {
  await heading(id).click({ button: 'right' });
  await expect(menu(name)).toBeVisible();
  if (group) await expect(menu(name).getByText('Group (2 agents)', { exact: true })).toBeVisible();
  await menu(name)
    .getByRole('menuitem', {
      name: new RegExp(group ? `^${action} group` : `^${action}(?! group)`),
    })
    .click();
  await expect(menu(name)).toHaveCount(0);
}

async function prompts(): Promise<Prompt[]> {
  const text = await readFile(path.join(dir, 'prompts.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Prompt);
}
const sentTexts = async () => (await prompts()).map(({ text }) => text);

async function corrected(id: string, name: string, text: string) {
  await queues()
    .getByRole('button', { name: `Open ${name}`, exact: true })
    .click();
  const view = page.getByRole('dialog', { name, exact: true });
  // Kill records cancellation before the CLI's interrupt acknowledgement necessarily arrives.
  // Fresh idle input is intervention; input submitted while still working is deliberately queued.
  await expect(view.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  const composer = view.getByRole('textbox', { name: `Message ${name}`, exact: true });
  await composer.fill(text);
  await composer.press('Enter');
  const submitted = view.locator('.graph-queue-message[data-submission]').filter({ hasText: text });
  await expect(submitted).toHaveAttribute('data-run', 'completed');
  await expect(row(id, 'first', view)).toHaveAttribute('data-run', 'succeeded');
  await expect(row(id, 'first', view).locator('summary')).toContainText('2 attempts');
  await view.getByRole('button', { name: 'All queues', exact: true }).click();
}

test('pauses nested active members until they finish, preserves an individual hold, and releases a dependent only after group Resume', async () => {
  const alpha = 'slow nested alpha';
  const beta = 'slow nested beta';
  const alphaNext = 'nested alpha after';
  const betaNext = 'nested beta after';
  const manual = 'nested manual';
  const outside = 'nested independent';
  const verified = 'nested verified';
  await openCanvas([
    { id: 'outer', kind: 'group', label: 'Outer', position: { x: 60, y: 60 } },
    agent(
      'alpha',
      'Alpha',
      [
        { id: 'first', message: alpha },
        { id: 'next', message: alphaNext },
      ],
      'outer',
    ),
    { id: 'inner', kind: 'group', label: 'Inner', parent: 'outer', position: { x: 230, y: 50 } },
    agent(
      'beta',
      'Beta',
      [
        { id: 'first', message: beta },
        { id: 'next', message: betaNext },
      ],
      'inner',
    ),
    agent('manual', 'Manual', [{ id: 'only', message: manual }], 'inner', 20, 170),
    agent('outside', 'Independent', [{ id: 'only', message: outside }], undefined, 780, 60),
    agent(
      'verifier',
      'Verifier',
      [
        { id: 'wait', waitFor: [{ agent: 'beta', item: 'next' }] },
        { id: 'verify', message: verified },
      ],
      undefined,
      780,
      230,
    ),
  ]);
  await agentControl('manual', 'Manual', 'Pause');
  await queues().getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(sentTexts, { timeout: 15_000 }).toEqual(expect.arrayContaining([alpha, beta]));
  await expect(row('alpha', 'first')).toHaveAttribute('data-run', 'running');
  await expect(row('beta', 'first')).toHaveAttribute('data-run', 'running');
  await frameControl('outer', 'Outer', 'Pause');
  await expect(frame('outer').getByText('Pausing', { exact: true })).toBeVisible();
  await showQueues();
  await expect(row('outside', 'only')).toHaveAttribute('data-run', 'succeeded');
  await expect(row('alpha', 'first')).toHaveAttribute('data-run', 'succeeded', { timeout: 10_000 });
  await expect(row('beta', 'first')).toHaveAttribute('data-run', 'succeeded', { timeout: 10_000 });
  for (const id of ['alpha', 'beta', 'manual']) {
    await expect(heading(id).getByText('Paused', { exact: true })).toBeVisible();
  }
  await expect(row('verifier', 'wait')).toHaveAttribute('data-run', 'waiting');
  expect((await sentTexts()).sort()).toEqual([alpha, beta, outside].sort());

  await frameControl('outer', 'Outer', 'Resume');
  await showQueues();
  await expect(row('alpha', 'next')).toHaveAttribute('data-run', 'succeeded');
  await expect(row('beta', 'next')).toHaveAttribute('data-run', 'succeeded');
  await expect(row('verifier', 'wait')).toHaveAttribute('data-run', 'succeeded');
  await expect(row('verifier', 'verify')).toHaveAttribute('data-run', 'succeeded');
  await expect(heading('manual').getByText('Paused', { exact: true })).toBeVisible();
  expect((await sentTexts()).sort()).toEqual(
    [alpha, beta, outside, alphaNext, betaNext, verified].sort(),
  );
  await agentControl('manual', 'Manual', 'Resume');
  await expect(queues().getByRole('status')).toHaveText('All done');
  expect((await sentTexts()).sort()).toEqual(
    [alpha, beta, outside, alphaNext, betaNext, verified, manual].sort(),
  );
});

test('preserves stacked group and individual holds across a core crash and global Resume, releasing only each owner’s work', async () => {
  const outer = 'stack outer';
  const inner = 'stack inner';
  const manual = 'stack manual';
  const outside = 'stack independent';
  await openCanvas([
    { id: 'outer', kind: 'group', label: 'Outer', position: { x: 60, y: 60 } },
    agent('alpha', 'Alpha', [{ id: 'only', message: outer }], 'outer'),
    { id: 'inner', kind: 'group', label: 'Inner', parent: 'outer', position: { x: 230, y: 50 } },
    agent('beta', 'Beta', [{ id: 'only', message: inner }], 'inner'),
    agent('manual', 'Manual', [{ id: 'only', message: manual }], 'inner', 20, 170),
    agent('outside', 'Independent', [{ id: 'only', message: outside }], undefined, 780, 60),
  ]);
  await agentControl('manual', 'Manual', 'Pause');
  await frameControl('inner', 'Inner', 'Pause');
  await frameControl('outer', 'Outer', 'Pause');
  await showQueues();
  await queues().getByRole('button', { name: 'Run', exact: true }).click();
  await expect(row('outside', 'only')).toHaveAttribute('data-run', 'succeeded');
  expect(await sentTexts()).toEqual([outside]);

  await crashCore(app);
  await expect(page.locator('.react-flow__node-frame')).toHaveCount(2);
  // The new epoch preserves All queues (§8); toggling it would close it.
  await expect(queues().getByRole('status')).toHaveText('Paused');
  await queues().getByRole('button', { name: 'Resume', exact: true }).click();
  for (const id of ['alpha', 'beta', 'manual']) {
    await expect(heading(id).getByText('Paused', { exact: true })).toBeVisible();
  }
  expect(await sentTexts()).toEqual([outside]);
  await frameControl('outer', 'Outer', 'Resume');
  await showQueues();
  await expect(row('alpha', 'only')).toHaveAttribute('data-run', 'succeeded');
  await expect(heading('beta').getByText('Paused', { exact: true })).toBeVisible();
  await expect(heading('manual').getByText('Paused', { exact: true })).toBeVisible();
  expect(await sentTexts()).toEqual([outside, outer]);
  await frameControl('inner', 'Inner', 'Resume');
  await showQueues();
  await expect(row('beta', 'only')).toHaveAttribute('data-run', 'succeeded');
  await expect(heading('manual').getByText('Paused', { exact: true })).toBeVisible();
  expect(await sentTexts()).toEqual([outside, outer, inner]);
  await agentControl('manual', 'Manual', 'Resume');
  await expect(queues().getByRole('status')).toHaveText('All done');
  expect(await sentTexts()).toEqual([outside, outer, inner, manual]);
});

test('Kill group includes the parent agent and nested child, keeping their consoles available and outsider work running', async () => {
  const parent = 'slow group parent';
  const child = 'slow group child';
  const outside = 'slow group outsider';
  const parentNext = 'group parent after';
  const childNext = 'group child after';
  const parentCorrection = 'group parent correction';
  const childCorrection = 'group child correction';
  await openCanvas([
    agent(
      'lead',
      'Lead',
      [
        { id: 'first', message: parent },
        { id: 'next', message: parentNext },
      ],
      undefined,
      80,
      80,
    ),
    agent(
      'child',
      'Child',
      [
        { id: 'first', message: child },
        { id: 'next', message: childNext },
      ],
      'lead',
      20,
      70,
    ),
    agent('outside', 'Independent', [{ id: 'only', message: outside }], undefined, 600, 80),
  ]);
  await queues().getByRole('button', { name: 'Run', exact: true }).click();
  await expect
    .poll(sentTexts, { timeout: 15_000 })
    .toEqual(expect.arrayContaining([parent, child, outside]));
  await expect(row('outside', 'only')).toHaveAttribute('data-run', 'running');
  await agentControl('lead', 'Lead', 'Kill', true);
  for (const id of ['lead', 'child']) {
    await expect(row(id, 'first')).toHaveAttribute('data-problem', 'cancelled');
    await expect(heading(id).getByText('Paused', { exact: true })).toBeVisible();
  }
  await expect(row('outside', 'only')).toHaveAttribute('data-run', 'running');
  await corrected('lead', 'Lead', parentCorrection);
  await corrected('child', 'Child', childCorrection);
  expect((await sentTexts()).sort()).toEqual(
    [parent, child, outside, parentCorrection, childCorrection].sort(),
  );
  const beforeResume = await prompts();
  expect(beforeResume.find(({ text }) => text === parentCorrection)?.sessionId).toBe(
    beforeResume.find(({ text }) => text === parent)?.sessionId,
  );
  expect(beforeResume.find(({ text }) => text === childCorrection)?.sessionId).toBe(
    beforeResume.find(({ text }) => text === child)?.sessionId,
  );
  for (const id of ['lead', 'child']) {
    await expect(heading(id).getByText('Paused', { exact: true })).toBeVisible();
  }
  await agentControl('lead', 'Lead', 'Resume', true);
  await expect(queues().getByRole('status')).toHaveText('All done', { timeout: 10_000 });
  await expect(row('outside', 'only')).toHaveAttribute('data-run', 'succeeded');
  await expect(row('lead', 'next')).toHaveAttribute('data-run', 'succeeded');
  await expect(row('child', 'next')).toHaveAttribute('data-run', 'succeeded');
  expect((await sentTexts()).sort()).toEqual(
    [parent, child, outside, parentCorrection, childCorrection, parentNext, childNext].sort(),
  );
});
