import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  // A model and a mode chosen in the composer.
  await view.getByRole('button', { name: 'Model: Default' }).click();
  await view.getByRole('menuitemradio', { name: /^Fast/ }).click();
  await view.getByRole('button', { name: 'Mode: Accept edits' }).click();
  await view.getByRole('menuitemradio', { name: /^Plan/ }).click();
  await expect(view.getByRole('button', { name: 'Model: Fast' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Mode: Plan' })).toBeVisible();

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

  // Its session too: opened again, the agent resumes the one it had, with the model and mode
  // it was given.
  await agent.dblclick();
  await expect(view.getByRole('note')).toHaveText(/^Resumed [0-9a-f-]{36}$/);
  await expect(view.getByRole('button', { name: 'Model: Fast' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Mode: Plan' })).toBeVisible();
});

test('runs a connected agent’s queue for real: a step, an If on its output, and Stop', async () => {
  // A canvas whose agent is connected, its queue ready to run.
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  const canvas = path.join(dir, 'release.corral');
  const queue = [
    { id: 'tests', action: 'Bash' },
    {
      id: 'ran',
      if: { kind: 'outputContains', text: 'Bash tool' },
      then: [{ id: 'wrap', message: 'Wrap up the tests' }],
    },
    {
      id: 'never',
      if: { kind: 'outputContains', text: 'NOT SAID' },
      then: [{ id: 'skip', message: 'Never sent' }],
    },
    // The fake asks a question here, and waits for the answer.
    { id: 'ask', message: '/question Tag it?' },
  ];
  await writeFile(
    canvas,
    JSON.stringify({
      format: 'corrallm',
      version: 1,
      nodes: [
        {
          id: 'releaser',
          kind: 'agent',
          label: 'Releaser',
          position: { x: 0, y: 0 },
          agent: 'Claude',
          connection: 'sdk',
          queue,
        },
      ],
      links: [],
    }),
  );
  await answerDialogs(folder, canvas);
  await page.getByRole('button', { name: 'Open…' }).click();
  await expect(page.getByText('release.corral')).toBeVisible();
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();

  // Its session runs; in Accept edits, the fake runs its command without asking.
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Releaser' });
  await expect(view.getByRole('button', { name: 'Model: Default' })).toBeVisible();
  await view.getByRole('button', { name: 'Mode: Manual' }).click();
  await view.getByRole('menuitemradio', { name: /^Accept edits/ }).click();

  await view.getByRole('button', { name: 'All queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues' });
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  await queues.getByRole('button', { name: 'Open Releaser' }).click();

  // The step goes to Claude Code as an instruction; its reply has what the first If looks for,
  // so its message is sent; the second If's is not.
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await expect(
    transcript.getByText('Use the Bash tool for this step (run shell commands).', { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText('You said: Wrap up the tests')).toBeVisible();
  const question = transcript.getByRole('group', { name: 'Questions for you' });
  await expect(question.getByText('Shall I go on?')).toBeVisible();
  await expect(transcript.getByText(/Never sent/)).toHaveCount(0);

  // Stop interrupts the turn the run started: the question is no longer asked.
  await view.getByRole('button', { name: 'All queues' }).click();
  const asking = queues.getByRole('group', { name: 'Releaser: Message “/question Tag it?”' });
  await expect(asking.locator('[data-run]')).toHaveAttribute('data-run', 'asking');
  await queues.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(queues.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(asking.locator('[data-run]')).toHaveAttribute('data-run', 'stopped');
  await expect(
    queues
      .getByRole('group', { name: 'Releaser: If the output contains "NOT SAID"' })
      .locator('[data-run]'),
  ).toHaveAttribute('data-run', 'skipped');
  await queues.getByRole('button', { name: 'Open Releaser' }).click();
  await expect(transcript.getByText(/^Interrupted · \d+s$/)).toBeVisible();
  await expect(question.getByText('Not answered: Shall I go on?')).toBeVisible();
});
