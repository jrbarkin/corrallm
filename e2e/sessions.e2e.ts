import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * Connected agents, through the real app: the project folder dialog, the session IPC channels and
 * the events main sends back through the preload. Sessions run main's fake connector
 * (CORRALLM_FAKE_SESSIONS), never Claude.
 */

let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let dir: string;
let problems: string[];

test.beforeEach(async () => {
  ({ app, close: closeApp } = await launchApp({ env: { CORRALLM_FAKE_SESSIONS: '1' } }));
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
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-sessions-'));
});

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

/** Answers main's dialogs for the user: folders with `folder`, canvas files with `canvas`. */
async function answerDialogs(folder: string, canvas: string) {
  await app.evaluate(
    ({ dialog }, { folder, canvas }) => {
      Object.assign(dialog, {
        showOpenDialog: (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          const picked = options.properties?.includes('openDirectory') ? folder : canvas;
          return Promise.resolve({ canceled: false, filePaths: [picked] });
        },
        showSaveDialog: () => Promise.resolve({ canceled: false, filePath: canvas }),
      });
    },
    { folder, canvas },
  );
}

test('runs a connected agent in the project folder, answering its prompts through main', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await answerDialogs(folder, path.join(dir, 'team.corral'));

  // Its agents work in the folder chosen in the file bar.
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();

  // An agent, connected through the Agent SDK from its chip.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('agent sdk');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('button', { name: 'Agent: Claude · Agent SDK' })).toBeVisible();
  await expect(view.getByText('Claude Code works in shop, through the Agent SDK.')).toBeVisible();
  // Its session started: it offers its models.
  await expect(view.getByRole('button', { name: 'Model: Default' })).toBeVisible();

  // A turn: the reply streams in, and in Manual mode it asks before running a command.
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  await composer.fill('Hello');
  await composer.press('Enter');
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await expect(transcript.getByText('You said: Hello')).toBeVisible();
  const prompt = transcript.getByRole('group', { name: 'Bash command: echo hello' });
  await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(transcript.getByRole('button', { name: 'Bash echo hello' })).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();
  await expect(view.getByText('$0.01 · 1% context')).toBeVisible();

  // It asks a question, answered in a question card.
  await composer.fill('/question');
  await composer.press('Enter');
  const asked = transcript.getByRole('group', { name: 'Questions for you' });
  await asked.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(transcript.getByText('Answer received: Yes')).toBeVisible();
  await expect(asked.getByText('You answered: Yes')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toHaveCount(2);

  // It asks to approve a plan, carried out in the mode chosen.
  await composer.fill('/plan');
  await composer.press('Enter');
  const plan = transcript.getByRole('group', { name: 'Plan' });
  await plan.getByRole('button', { name: 'Yes, and auto-accept edits' }).click();
  await expect(transcript.getByText('Carrying out the plan.')).toBeVisible();
  await expect(view.getByRole('button', { name: 'Mode: Accept edits' })).toBeVisible();

  // The folder is remembered with the canvas's file: a new canvas has none, and it comes back.
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('team.corral')).toBeVisible();
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('button', { name: 'Choose a project folder' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  const agent = page.locator('.react-flow__node');
  await expect(agent).toHaveAttribute('aria-label', 'Agent 1, Claude · SDK');

  // Its session too: opened again, the agent resumes the one it had.
  await agent.dblclick();
  await expect(view.getByRole('note')).toHaveText(/^Resumed [0-9a-f-]{36}$/);
});

test('runs a Codex agent through its app server, in Codex’s own modes', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await answerDialogs(folder, path.join(dir, 'team.corral'));
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();

  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('codex app server');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('button', { name: 'Agent: Codex · App Server' })).toBeVisible();
  await expect(view.getByText('Codex CLI works in shop, through its app server.')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    'Agent 1, Codex · App Server',
  );

  // It starts in Codex's Default mode, which runs the command without asking.
  const mode = view.getByRole('button', { name: /^Mode: / });
  await expect(mode).toHaveAccessibleName('Mode: Default');
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  await composer.fill('Hello');
  await composer.press('Enter');
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await expect(transcript.getByText('You said: Hello')).toBeVisible();
  await expect(transcript.getByRole('button', { name: 'Bash echo hello' })).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();

  // Read only asks first: main took the Codex mode.
  await mode.click();
  await view.getByRole('menuitemradio', { name: /^Read only/ }).click();
  await expect(mode).toHaveAccessibleName('Mode: Read only');
  await composer.fill('Again');
  await composer.press('Enter');
  const prompt = transcript.getByRole('group', { name: 'Bash command: echo hello' });
  await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toHaveCount(2);
});
