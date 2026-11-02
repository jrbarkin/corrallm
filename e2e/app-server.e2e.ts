import { agentCardName, agentChipName } from './catalog';
import { dismissStart } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';
import { mcpRequestTitle } from '../src/shared/model/words';

/*
 * A Codex agent through its app server, in the built app: main runs the App Server connection
 * against a fake `codex` (src/main/sessions/codex/fake-codex.mjs, found through
 * CORRALLM_AGENT_PATHS) that speaks the app server's JSON-RPC in the real one's shapes, never Codex
 * itself. It keeps its threads in a file, so that a restarted app resumes them.
 */

test.skip(process.platform === 'win32', 'The fake codex is a Node script run through sh.');

const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');

let dir: string;
let folder: string;
let profile: string;
let codex: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  closeApp = undefined;
  problems = [];
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
  const close = closeApp;
  closeApp = undefined;
  try {
    await close?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(problems).toEqual([]);
});

async function launch() {
  closeApp = undefined;
  ({ app, close: closeApp } = await launchApp({
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ codex: codex }),
      FAKE_CODEX_LOG: path.join(dir, 'requests.jsonl'),
    },
    profile,
  }));
  page = await app.firstWindow();
  problems = [];
  page.on('console', (message) => {
    // A new agent's native Terminal warms xterm before this test switches to App Server.
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.waitForLoadState('load');
  await dismissStart(page);
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
      version: 2,
      id: randomUUID(),
      nodes: [
        {
          id: 'shop',
          kind: 'agent',
          label: 'Shop',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          ...(queue.length > 0 ? { queue } : {}),
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    agentCardName('Shop', 'codex.app-server'),
  );
}

/** Sends a message from the composer (not the queue's box for a message to add). */
async function send(view: Locator, text: string) {
  const composer = view.getByRole('textbox', { name: /^Message (?!to the agent)/ });
  await composer.fill(text);
  await composer.press('Enter');
}

async function nativeAnswers(method: string): Promise<unknown[]> {
  return (await readFile(path.join(dir, 'requests.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: unknown })
    .filter((row) => row.method === `answer:${method}`)
    .map((row) => row.params);
}

test('runs a Codex agent as a Codex thread: turns, prompts, modes, models, commands', async () => {
  await chooseProject();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view
    .getByRole('button', { name: agentChipName('claude-code.terminal'), exact: true })
    .click();
  await page.keyboard.type('codex app server');
  await page.keyboard.press('Enter');
  await expect(
    view.getByRole('button', { name: agentChipName('codex.app-server'), exact: true }),
  ).toBeVisible();
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
  const prompt = transcript.getByRole('group', { name: 'Codex wants to run a command' });
  await expect(
    prompt.getByRole('button', {
      name: "Yes, and don't ask again for commands that start with `npm test`",
    }),
  ).toBeVisible();
  await expect(prompt).toContainText('npm test');
  await prompt.getByRole('button', { name: 'Yes, proceed', exact: true }).click();
  await expect(prompt.getByRole('status')).toHaveText('Allowed once by you.');
  const command = transcript.getByRole('button', { name: 'exec_command npm test' });
  await expect(command).toBeVisible();
  await command.click();
  await expect(transcript.getByText('Tests: 1 passed')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toHaveCount(2);

  // Plan mode proposes a plan; implemented, it goes on in Default.
  await mode.click();
  await view.getByRole('menuitemradio', { name: /^Plan/ }).click();
  await send(view, 'Plan the change');
  const plan = transcript.getByRole('group', { name: 'Implement this plan?', exact: true });
  await expect(plan).toContainText('Change it');
  await plan.getByRole('button', { name: 'Yes, implement this plan' }).click();
  await expect(plan.getByRole('status')).toHaveText('Allowed once by you.');
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

test('asks before Codex calls an MCP tool, and keeps a form typed: answered through the core’s owner', async () => {
  await canvasFile();
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  const transcript = view.getByRole('log', { name: 'Transcript' });

  // Codex's approval of an MCP tool call, kept for the session as its TUI keeps it.
  await send(view, 'mcp');
  const approval = transcript.getByRole('group', {
    name: 'Allow the probe MCP server to run tool "save_note"?',
  });
  await approval.getByRole('button', { name: 'Allow for this session' }).click();
  await expect(transcript.getByText('Saved, and allowed for this session.')).toBeVisible();
  await expect(approval.getByRole('status')).toHaveText('Always allowed by you.');

  // A form of six fields stays a form, its values typed.
  await send(view, 'form');
  const form = transcript.getByRole('form', { name: 'probe asks' });
  await form.getByRole('textbox', { name: 'Name' }).fill('Ada');
  await form.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
  await form.getByRole('spinbutton', { name: 'Age' }).fill('37');
  await form.getByRole('combobox', { name: 'Color' }).selectOption('blue');
  await form.getByRole('checkbox', { name: 'Subscribe' }).check();
  await form.getByRole('checkbox', { name: 'news', exact: true }).check();
  await form.getByRole('checkbox', { name: 'tips', exact: true }).check();
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(transcript.getByText('Hello, Ada.')).toBeVisible();
  const settled = transcript.getByRole('group', {
    name: mcpRequestTitle('probe', false),
    exact: true,
  });
  await expect(settled.getByRole('status')).toHaveText('Submitted by you.');
  await expect(settled).not.toContainText('ada@example.com');
  expect(await nativeAnswers('mcpServer/elicitation/request')).toEqual([
    { action: 'accept', content: null, _meta: { persist: 'session' } },
    {
      action: 'accept',
      content: {
        age: 37,
        color: 'blue',
        email: 'ada@example.com',
        name: 'Ada',
        subscribe: true,
        topics: ['news', 'tips'],
      },
      _meta: null,
    },
  ]);
});

test('answers all six questions in All queues, preserving native ids and a secret draft', async () => {
  await canvasFile();
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop', exact: true });
  await send(view, 'ask many');
  await expect(
    view.getByRole('group', { name: 'Codex asks 6 questions', exact: true }),
  ).toBeVisible();
  await view.getByRole('button', { name: 'All queues', exact: true }).click();
  const queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  const questions = queues.getByRole('group', { name: 'Codex asks 6 questions', exact: true });
  await questions.getByRole('radio', { name: 'Blue', exact: true }).check();
  await questions.getByRole('radio', { name: 'Preview', exact: true }).check();
  await questions.getByRole('radio', { name: 'Small', exact: true }).check();
  await questions
    .getByRole('textbox', { name: 'What should the release note say?', exact: true })
    .fill('Ready for review');
  await questions.getByRole('radio', { name: 'Tests', exact: true }).check();
  const secret = questions.getByLabel('What is the private code?', { exact: true });
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill('private-code');
  await questions.getByRole('button', { name: 'Send answers', exact: true }).click();
  await expect(questions).toHaveCount(0);
  await queues.getByRole('button', { name: 'Open Shop', exact: true }).click();
  const settled = view.getByRole('group', { name: 'Codex asks 6 questions', exact: true });
  await expect(settled.getByRole('status')).toHaveText('Answered (secret) by you.');
  await expect(settled).not.toContainText('private-code');
  await expect(view.getByText('Answers received.', { exact: true })).toBeVisible();
  expect(await nativeAnswers('item/tool/requestUserInput')).toEqual([
    {
      answers: {
        color: { answers: ['Blue'] },
        target: { answers: ['Preview'] },
        scope: { answers: ['Small'] },
        notes: { answers: ['Ready for review'] },
        checks: { answers: ['Tests'] },
        code: { answers: ['private-code'] },
      },
    },
  ]);
});

test('the queues’ Run sends its message to the Codex thread, and hears its turn end', async () => {
  await canvasFile([{ id: 'docs', message: 'Write the docs' }]);
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  await view.getByRole('button', { name: 'All queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues' });
  await queues.getByRole('button', { name: 'Run' }).click();
  // The turn is the fake app server's (a Node process, its handshake): about 0.1 s here, but on a
  // loaded machine it has taken 4 s and 9 s, past Playwright's default five seconds.
  await expect(queues.getByRole('status')).toHaveText('All done', { timeout: 15_000 });
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

  await closeApp?.();
  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.locator('.react-flow__node').dblclick();
  const again = page.getByRole('dialog', { name: 'Shop' }).getByRole('log', { name: 'Transcript' });
  // The thread's turns, as they were.
  await expect(again.getByText('remember this', { exact: true })).toBeVisible();
  await expect(again.getByText('You said: remember this')).toBeVisible();
});

test('reads the plan’s usage as it connects, unasked, for Codex’s gauge', async () => {
  await fakeCodex('chatgpt');
  await canvasFile();
  await chooseProject();
  const gauge = page.getByRole('button', { name: /^Codex usage:/ });
  await expect(gauge).toHaveAttribute('aria-label', 'Codex usage: no reading');
  // Its view opened, its session starts: nothing is sent, so nothing asks to use the plan.
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  await expect(view.getByText('5h 12% · weekly 3%')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(gauge).toHaveAttribute(
    'aria-label',
    'Codex usage: 12% of 5-hour window, 3% of weekly window',
  );
  await expect(page.locator('.react-flow__node')).not.toHaveClass(/\basking\b/);
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
  const prompt = transcript.getByRole('group', { name: 'Use your ChatGPT plan here?' });
  await expect(prompt).toContainText('Only you give consent.');
  await expect(
    prompt.getByRole('button', { name: "Yes, and don't ask again on this computer", exact: true }),
  ).toBeDisabled();
  await prompt.getByRole('button', { name: 'Show all', exact: true }).click();
  await expect(prompt).toContainText('Plus');
  await expect(prompt.getByText(/local or open-source application/)).toBeVisible();
  await expect(prompt.getByText(/never been permitted for commercial/)).toBeVisible();
  // It needs the user, on the canvas too.
  await expect(page.locator('.react-flow__node')).toHaveClass(/\basking\b/);
  await prompt.getByRole('button', { name: "Yes, and don't ask again on this computer" }).click();
  await expect(transcript.getByText('You said: Hello')).toBeVisible();
  await expect(prompt.getByRole('status')).toHaveText('Always allowed by you.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('team.corral')).toBeVisible();

  // After a restart, it asks no more.
  await closeApp?.();
  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await page.locator('.react-flow__node').dblclick();
  const again = page.getByRole('dialog', { name: 'Shop' });
  await send(again, 'Again');
  const after = again.getByRole('log', { name: 'Transcript' });
  await expect(after.getByText('You said: Again')).toBeVisible();
  await expect(after.getByRole('group', { name: /^Use your ChatGPT plan here\?/ })).toHaveCount(0);
});
