import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * A Codex agent through its app server, in the built app: main runs the App Server connection
 * against a fake `codex` (src/main/sessions/codex/fake-codex.mjs, found through
 * CORRALLM_CODEX_PATH) that speaks the app server's JSON-RPC in the real one's shapes, never Codex
 * itself. It keeps its threads in a file, so that a restarted app resumes them.
 */

test.skip(process.platform === 'win32', 'The fake codex is a Node script run through sh.');

const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');

let dir: string;
let folder: string;
let profile: string;
let codex: string;
let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-app-server-'));
  folder = path.join(dir, 'shop');
  profile = path.join(dir, 'profile');
  await mkdir(folder);
  await mkdir(profile);
  await writeFile(path.join(folder, 'README.md'), '# Shop\n');
  codex = path.join(dir, 'codex');
  await fakeCodex();
  await launch();
});

/**
 * The fake `codex` agents run: the fake, run with this Node whatever the login shell's PATH has,
 * keeping its threads, logged in as `login` says (an API key unless told otherwise).
 */
async function fakeCodex(login: 'apikey' | 'chatgpt' = 'apikey') {
  await writeFile(
    codex,
    `#!/bin/sh\nFAKE_CODEX_LOGIN=${login} FAKE_CODEX_STATE="${path.join(dir, 'threads.json')}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
  );
  await chmod(codex, 0o755);
}

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

async function launch() {
  ({ app, close: closeApp } = await launchApp({ env: { CORRALLM_CODEX_PATH: codex }, profile }));
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
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  const canvas = path.join(dir, 'team.corral');
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

async function chooseProject() {
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
}

/** A canvas with one App Server agent, Shop, whose queue holds `queue`. */
async function canvasFile(queue: { id: string; message: string }[] = []) {
  await writeFile(
    path.join(dir, 'team.corral'),
    JSON.stringify({
      format: 'corrallm',
      version: 1,
      nodes: [
        {
          id: 'shop',
          kind: 'agent',
          label: 'Shop',
          position: { x: 0, y: 0 },
          agent: 'Codex',
          connection: 'app-server',
          ...(queue.length > 0 ? { queue } : {}),
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    'Shop, Codex · App Server',
  );
}

/** Sends a message from the composer (not the queue's box for a message to add). */
async function send(view: Locator, text: string) {
  const composer = view.getByRole('textbox', { name: /^Message (?!to the agent)/ });
  await composer.fill(text);
  await composer.press('Enter');
}

test('runs a Codex agent as a Codex thread: turns, prompts, modes, models, commands', async () => {
  await chooseProject();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('codex app server');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('button', { name: 'Agent: Codex · App Server' })).toBeVisible();
  // Its thread started: Codex's models, and its reasoning efforts.
  await expect(view.getByRole('button', { name: 'Model: GPT-6.1-Sol' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Effort: Low' })).toBeVisible();
  const transcript = view.getByRole('log', { name: 'Transcript' });
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });

  // Codex's slash commands and the project's skills complete as they are typed.
  await composer.fill('/re');
  await expect(view.getByRole('listbox', { name: 'Commands' }).getByRole('option')).toHaveText([
    /^\/review/,
    /^\/rename/,
  ]);
  await composer.fill('/dep');
  await expect(
    view.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /^\/deploy/ }),
  ).toBeVisible();

  // A turn: its reasoning and reply stream in; its usage and the plan's limits show.
  await send(view, 'Hello');
  await expect(transcript.getByText('You said: Hello')).toBeVisible();
  await expect(transcript.getByText(/^Thought for \d+s$/)).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();
  await expect(view.getByText('1% context · 5h 12% · weekly 3%')).toBeVisible();

  // Read only asks before running a command, as Codex words it.
  const mode = view.getByRole('button', { name: /^Mode: / });
  await mode.click();
  await view.getByRole('menuitemradio', { name: /^Read only/ }).click();
  await send(view, 'run the tests');
  const prompt = transcript.getByRole('group', { name: 'May I run the tests?: npm test' });
  await expect(
    prompt.getByRole('button', {
      name: "Yes, and don't ask again for commands that start with `npm test`",
    }),
  ).toBeVisible();
  await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
  const command = transcript.getByRole('button', { name: 'exec_command npm test' });
  await expect(command).toBeVisible();
  await command.click();
  await expect(transcript.getByText('Tests: 1 passed')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toHaveCount(2);

  // Plan mode proposes a plan; implemented, it goes on in Default.
  await mode.click();
  await view.getByRole('menuitemradio', { name: /^Plan/ }).click();
  await send(view, 'Plan the change');
  const plan = transcript.getByRole('group', { name: 'Plan' });
  await expect(plan.getByText('Change it')).toBeVisible();
  await plan.getByRole('button', { name: 'Yes, implement this plan' }).click();
  await expect(transcript.getByText('You said: Implement the plan.')).toBeVisible();
  await expect(mode).toHaveAccessibleName('Mode: Default');

  // A harder effort for the next turns.
  await view.getByRole('button', { name: 'Effort: Low' }).click();
  await view.getByRole('menuitemradio', { name: /^High/ }).click();
  await expect(view.getByRole('button', { name: 'Effort: High' })).toBeVisible();

  // Escape interrupts a turn.
  await send(view, 'slow');
  await expect(transcript.getByRole('button', { name: 'exec_command sleep 30' })).toBeVisible();
  await composer.press('Escape');
  await expect(transcript.getByText(/^Interrupted · \d+s$/)).toBeVisible();

  // A slash command runs as Codex's does.
  await send(view, '/review');
  await expect(transcript.getByText('No issues found in the current changes.')).toBeVisible();
});

test('the queues’ Run sends its message to the Codex thread, and hears its turn end', async () => {
  await canvasFile([{ id: 'docs', message: 'Write the docs' }]);
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  await view.getByRole('button', { name: 'All queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues' });
  await queues.getByRole('button', { name: 'Run' }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  await queues.getByRole('button', { name: 'Open Shop' }).click();
  await expect(
    view.getByRole('log', { name: 'Transcript' }).getByText('You said: Write the docs'),
  ).toBeVisible();
});

test('resumes the agent’s Codex thread after the app restarts, with its history', async () => {
  await canvasFile();
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  await send(view, 'remember this');
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await expect(transcript.getByText('You said: remember this')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('team.corral')).toBeVisible();

  await closeApp();
  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.locator('.react-flow__node').dblclick();
  const again = page.getByRole('dialog', { name: 'Shop' }).getByRole('log', { name: 'Transcript' });
  // The thread's turns, as they were.
  await expect(again.getByText('remember this', { exact: true })).toBeVisible();
  await expect(again.getByText('You said: remember this')).toBeVisible();
});

test('runs on the user’s ChatGPT plan once they allow it, and asks no more if told not to', async () => {
  await fakeCodex('chatgpt');
  await canvasFile();
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await send(view, 'Hello');
  // Nothing goes until the user says so, quoting what OpenAI allows.
  const prompt = transcript.getByRole('group', { name: 'Use your ChatGPT plan here?: Plus' });
  await expect(prompt.getByText(/local or open-source application/)).toBeVisible();
  await expect(prompt.getByText(/never been permitted for commercial/)).toBeVisible();
  // It needs the user, on the canvas too.
  await expect(page.locator('.react-flow__node')).toHaveClass(/\basking\b/);
  await prompt.getByRole('button', { name: "Yes, and don't ask again on this computer" }).click();
  await expect(transcript.getByText('You said: Hello')).toBeVisible();
  await expect(transcript.getByText('Always allowed: ChatGPT plan')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('team.corral')).toBeVisible();

  // After a restart, it asks no more.
  await closeApp();
  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await page.locator('.react-flow__node').dblclick();
  const again = page.getByRole('dialog', { name: 'Shop' });
  await send(again, 'Again');
  const after = again.getByRole('log', { name: 'Transcript' });
  await expect(after.getByText('You said: Again')).toBeVisible();
  await expect(after.getByRole('group', { name: /^Use your ChatGPT plan here\?/ })).toHaveCount(0);
});
