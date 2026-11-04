import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { chooseAddedAgent } from './agent-choice';
import { dismissStart } from './canvas-actions';
import {
  adapterName,
  agentCardName,
  agentChipName,
  connectionOptionName,
  consentTitle,
} from './catalog';
import { launchApp } from './launch';

/*
 * B22a X4: the Settings page end to end, with fakes only. Connected agents run the generic fake
 * connector (CORRALLM_FAKE_SESSIONS=1) or, for a link in a reply, the Agent SDK protocol fake;
 * main's dialogs and browser are replaced for the user, as in the other specs. No real CLI runs.
 */
test.skip(process.platform === 'win32', 'The native fake uses a sh wrapper.');

const FAKE_CLAUDE = path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs');

let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-settings-'));
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning')
      problems.push(`${message.type()}: ${message.text()}`);
  });
  return problems;
}

const settingsOf = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const dockSettings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });
const menuTrigger = (page: Page) => page.getByRole('button', { name: 'Canvas menu', exact: true });

async function openFromMenu(page: Page) {
  await menuTrigger(page).click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  const panel = settingsOf(page);
  await expect(panel).toBeVisible();
  return panel;
}
async function openFromDock(page: Page) {
  await dockSettings(page).click();
  const panel = settingsOf(page);
  await expect(panel).toBeVisible();
  return panel;
}
async function closeSettings(page: Page) {
  await settingsOf(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(settingsOf(page)).toHaveCount(0);
}

async function pickFolder(app: ElectronApplication, page: Page, name = 'shop') {
  const folder = path.join(dir, name);
  await mkdir(folder);
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: `Project folder: ${name}` })).toBeVisible();
}

test('opens over a running canvas and over Start without touching work, and closing returns focus', async () => {
  const { app, close } = await launchApp({ env: { CORRALLM_FAKE_SESSIONS: '1' } });
  try {
    const page = await app.firstWindow();
    const problems = watch(page);
    await page.waitForLoadState('load');

    // Over Start (nothing created), from the dock.
    const start = page.getByRole('dialog', { name: 'Start a session', exact: true });
    await expect(start).toBeVisible();
    await openFromDock(page);
    await expect(start).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsOf(page)).toHaveCount(0);
    await expect(dockSettings(page)).toBeFocused();
    await expect(start).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await dismissStart(page);

    // Over a running canvas with an agent window, its draft and its session.
    await pickFolder(app, page);
    await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
    await chooseAddedAgent(page, 'codex', 'codex.app-server');
    const card = page.locator('.react-flow__node-agent');
    await expect(card).toHaveAttribute('aria-label', agentCardName('Agent 1', 'codex.app-server'));
    await card.dblclick();
    const view = page.getByRole('dialog', { name: 'Agent 1', exact: true });
    const composer = view.getByRole('textbox', { name: 'Message Agent 1', exact: true });
    await composer.fill('keep this session');
    await composer.press('Enter');
    await expect(view.getByText('You said: keep this session')).toBeVisible();
    await expect(view.getByText(/^Worked for \d+s$/)).toBeVisible();
    await composer.fill('an unsent draft');

    await openFromDock(page);
    await closeSettings(page);
    await expect(dockSettings(page)).toBeFocused();
    await expect(view).toBeVisible();
    await expect(composer).toHaveValue('an unsent draft');
    await expect(view.getByText('You said: keep this session')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(view).toHaveCount(0);
    await openFromMenu(page);
    await page.keyboard.press('Escape');
    await expect(settingsOf(page)).toHaveCount(0);
    await expect(menuTrigger(page)).toBeFocused();
    await expect(card).toHaveCount(1);
    await card.dblclick();
    await expect(view.getByText('You said: keep this session')).toHaveCount(1);
    await expect(view.getByText(/^Worked for \d+s$/)).toHaveCount(1);
    expect(problems).toEqual([]);
  } finally {
    await close();
  }
});

test('a default chosen in Settings is used by the next Add and leaves existing agents alone', async () => {
  const { app, close } = await launchApp({ env: { CORRALLM_FAKE_SESSIONS: '1' } });
  try {
    const page = await app.firstWindow();
    const problems = watch(page);
    await page.waitForLoadState('load');
    await dismissStart(page);
    await page.locator('.react-flow__pane').dblclick({ position: { x: 300, y: 240 } });
    await chooseAddedAgent(page, 'claude-code');
    const agents = page.locator('.react-flow__node-agent');
    await expect(agents).toHaveCount(1);
    const first = agents.first();
    await expect(first).toHaveAttribute(
      'aria-label',
      agentCardName('Agent 1', 'claude-code.terminal'),
    );

    const settings = await openFromMenu(page);
    await expect(settings.getByText('No default agent: corrallm asks each time')).toBeVisible();
    await settings.getByRole('button', { name: 'Choose…', exact: true }).click();
    await page.getByRole('option', { name: adapterName('codex'), exact: true }).click();
    await expect(settings.getByText(`Default agent: ${adapterName('codex')}`)).toBeVisible();
    // Choosing a default neither starts nor changes anything.
    await expect(agents).toHaveCount(1);
    await closeSettings(page);
    await expect(first).toHaveAttribute(
      'aria-label',
      agentCardName('Agent 1', 'claude-code.terminal'),
    );

    await page.locator('.react-flow__pane').dblclick({ position: { x: 600, y: 420 } });
    await expect(agents).toHaveCount(2);
    await expect(page.getByRole('dialog', { name: 'Choose an agent', exact: true })).toHaveCount(0);
    await expect(agents.nth(1)).toHaveAttribute(
      'aria-label',
      agentCardName('Agent 2', 'codex.terminal'),
    );
    await expect(first).toHaveAttribute(
      'aria-label',
      agentCardName('Agent 1', 'claude-code.terminal'),
    );
    expect(problems).toEqual([]);
  } finally {
    await close();
  }
});

test('taking back a declared consent in Settings makes the live session ask again', async () => {
  const { app, close } = await launchApp({ env: { CORRALLM_FAKE_SESSIONS: '1' } });
  try {
    const page = await app.firstWindow();
    const problems = watch(page);
    await page.waitForLoadState('load');
    await dismissStart(page);
    await pickFolder(app, page);
    await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
    await chooseAddedAgent(page, 'codex', 'codex.app-server');
    await page.locator('.react-flow__node-agent').dblclick();
    const view = page.getByRole('dialog', { name: 'Agent 1', exact: true });
    const composer = view.getByRole('textbox', { name: 'Message Agent 1', exact: true });
    const card = () =>
      view
        .getByRole('log', { name: 'Transcript', exact: true })
        .getByRole('group', { name: 'Use your made-up plan here?', exact: true });

    await composer.fill('/consent first');
    await composer.press('Enter');
    await expect(card()).toHaveCount(1);
    await card()
      .getByRole('button', { name: "Yes, and don't ask again on this computer", exact: true })
      .click();

    // Taken back while that turn may still be running: it finishes, and is not interrupted.
    const settings = await openFromDock(page);
    const row = settings.getByRole('listitem').filter({ hasText: consentTitle('codex') });
    await expect(row.getByText('Kept for good')).toBeVisible();
    await row.getByRole('button', { name: /^Ask again:/ }).click();
    await expect(row.getByText('Not kept for good')).toBeVisible();
    await closeSettings(page);
    await expect(view.getByText('You said: /consent first')).toBeVisible();
    await expect(view.getByText(/^Worked for \d+s$/)).toHaveCount(1);
    await expect(view.getByText(/Interrupted/)).toHaveCount(0);

    // The next turn asks again: a second card, undecided.
    await composer.fill('/consent second');
    await composer.press('Enter');
    await expect(card()).toHaveCount(2);
    await expect(card().last().getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
    await expect(view.getByText('You said: /consent second')).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await close();
  }
});

test('a site remembered through the open-without-asking dialog is listed, taken back, and asked about again', async () => {
  const { app, close } = await launchApp({
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': FAKE_CLAUDE }),
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
    },
  });
  try {
    await chmod(FAKE_CLAUDE, 0o755);
    const page = await app.firstWindow();
    const problems = watch(page);
    await page.waitForLoadState('load');
    await dismissStart(page);
    await pickFolder(app, page);
    await app.evaluate(({ dialog, shell }) => {
      const seen = globalThis as unknown as { asked: string[]; opened: string[] };
      seen.asked = [];
      seen.opened = [];
      Object.assign(dialog, {
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
    });
    const seen = () =>
      app
        .evaluate(() => globalThis as unknown as { asked: string[]; opened: string[] })
        .then(({ asked, opened }) => ({ asked, opened }));

    await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
    await chooseAddedAgent(page, 'claude-code');
    // Author the SDK connection before a view opens, so no Terminal session starts first.
    const node = page.locator('.react-flow__node-agent');
    await node.click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Agent 1 controls', exact: true })
      .getByRole('menuitem', { name: /^Settings/ })
      .click();
    const agentSettings = page.getByRole('dialog', {
      name: 'Agent settings: Agent 1',
      exact: true,
    });
    await agentSettings
      .getByRole('button', { name: agentChipName('claude-code.terminal'), exact: true })
      .click();
    await agentSettings
      .getByRole('option', { name: connectionOptionName('claude-code.sdk') })
      .click();
    await agentSettings.getByRole('button', { name: 'Close agent settings' }).click();
    await node.dblclick();
    const view = page.getByRole('dialog', { name: 'Agent 1', exact: true });
    const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
    await composer.fill('markdown, please');
    await composer.press('Enter');
    const link = view
      .getByRole('log', { name: 'Transcript' })
      .getByRole('link', { name: 'the queue docs' });

    await link.click();
    await expect.poll(seen).toEqual({
      asked: ['Open docs.example.com in your browser?'],
      opened: ['https://docs.example.com/queues'],
    });

    const settings = await openFromDock(page);
    const sites = settings.getByRole('list', { name: 'Remembered sites' });
    await expect(sites.getByRole('listitem')).toHaveText([/docs\.example\.com/]);
    await sites.getByRole('button', { name: /^Ask next time: .*docs\.example\.com/ }).click();
    await expect(settings.getByText('No sites remembered.')).toBeVisible();
    await closeSettings(page);

    // Remembered, it would open without asking; taken back, the next click asks again.
    await link.click();
    await expect.poll(async () => (await seen()).asked).toHaveLength(2);
    await expect.poll(async () => (await seen()).opened).toHaveLength(2);
    await expect(view).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    await close();
  }
});

test('turning notifications off in Settings persists across a restart', async () => {
  const profile = path.join(dir, 'profile');
  await mkdir(profile);
  const options = { profile, env: { CORRALLM_FAKE_SESSIONS: '1' } };
  let running = await launchApp(options);
  let closed = false;
  try {
    let page = await running.app.firstWindow();
    const problems = watch(page);
    await page.waitForLoadState('load');
    await dismissStart(page);
    let settings = await openFromDock(page);
    const toggle = settings.getByRole('switch', { name: 'OS notifications', exact: true });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => {
        const text = await readFile(path.join(profile, 'settings.json'), 'utf8').catch(() => '{}');
        return (JSON.parse(text) as { notifications?: { enabled?: boolean } }).notifications;
      })
      .toEqual({ enabled: false });
    await running.close();
    closed = true;

    running = await launchApp(options);
    closed = false;
    page = await running.app.firstWindow();
    await page.waitForLoadState('load');
    await dismissStart(page);
    settings = await openFromDock(page);
    await expect(
      settings.getByRole('switch', { name: 'OS notifications', exact: true }),
    ).not.toBeChecked();
    expect(problems).toEqual([]);
  } finally {
    if (!closed) await running.close();
  }
});

test.fixme('the notification host sees notifications off after the switch', () => {
  // e2e has no notification host fake: the hidden window suppresses before the Electron backend
  // is asked, and adding a production switch for one is not allowed.
});
