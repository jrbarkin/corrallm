import { dismissStart } from './canvas-actions';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * A Claude agent connected through the Agent SDK, in the built app: the SDK bundled into main
 * runs a fake `claude` (src/main/sessions/claude-code/sdk/fake-claude.mjs, found through
 * CORRALLM_AGENT_PATHS) that speaks the CLI's protocol, never Claude itself.
 */

const FAKE_CLAUDE = path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs');

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
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': FAKE_CLAUDE }),
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
      FAKE_CLAUDE_PROMPTS: path.join(dir, 'prompts.jsonl'),
      FAKE_CLAUDE_INITIALIZE: path.join(dir, 'starts.jsonl'),
    },
  }));
  page = await app.firstWindow();
  problems = [];
  page.on('console', (message) => {
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
});

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

/** Author the SDK connection before opening a view, so no Terminal session starts first. */
async function openSdkAgent(name: string) {
  const card = page
    .locator('.react-flow__node-agent')
    .filter({ has: page.locator('.graph-label').filter({ hasText: new RegExp(`^${name}$`) }) });
  await card.click({ button: 'right' });
  await page
    .getByRole('menu', { name: `${name} controls`, exact: true })
    .getByRole('menuitem', { name: /^Settings/ })
    .click();
  const settings = page.getByRole('dialog', { name: `Agent settings: ${name}`, exact: true });
  await settings.getByRole('button', { name: /^Agent: Claude/ }).click();
  await settings.getByRole('option', { name: /^Claude · Agent SDK/ }).click();
  await settings.getByRole('button', { name: 'Close agent settings' }).click();
  await card.dblclick();
  return page.getByRole('dialog', { name, exact: true });
}

test('reconnects to a viewed session and its pending prompt without reopening or replaying it', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  let view = await openSdkAgent('Agent 1');
  await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
  // The protocol fake asks before running a command in its default (Manual) mode: a pending
  // native prompt this turn waits on.
  const text = 'please run it';
  await view.getByRole('textbox', { name: 'Message Agent 1' }).fill(text);
  await view.getByRole('textbox', { name: 'Message Agent 1' }).press('Enter');
  await expect(view.getByRole('group', { name: 'Bash command: echo hello' })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  await composer.fill('This queued draft must not reach the CLI');
  await composer.press('Enter');
  await view
    .getByRole('button', { name: 'Edit queued message: This queued draft must not reach the CLI' })
    .click();
  await expect(view.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(composer).toHaveValue('This queued draft must not reach the CLI');
  await composer.fill('');
  const starts = await readFile(path.join(dir, 'starts.jsonl'), 'utf8');
  const prompts = await readFile(path.join(dir, 'prompts.jsonl'), 'utf8');

  await page.reload();
  await dismissStart(page);
  await page.locator('.react-flow__node-agent').dblclick();
  view = page.getByRole('dialog', { name: 'Agent 1', exact: true });
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await expect(transcript.locator('.agent-user')).toHaveCount(1);
  await expect(transcript.getByText(text, { exact: true })).toBeVisible();
  const prompt = transcript.getByRole('group', { name: 'Bash command: echo hello' });
  await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(transcript.getByRole('button', { name: 'Bash echo hello' })).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toHaveCount(1);
  expect(await readFile(path.join(dir, 'starts.jsonl'), 'utf8')).toBe(starts);
  expect(await readFile(path.join(dir, 'prompts.jsonl'), 'utf8')).toBe(prompts);

  await view.getByRole('button', { name: 'All queues', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'All queues', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(view).toBeVisible();
  await expect(transcript.locator('.agent-user')).toHaveCount(1);
  expect(await readFile(path.join(dir, 'starts.jsonl'), 'utf8')).toBe(starts);
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
  const view = await openSdkAgent('Agent 1');
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
  const view = await openSdkAgent('Agent 1');
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
    const view = await openSdkAgent(name);
    await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
    return view;
  };

  // Agent 1 has a conversation.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 300, y: 300 } });
  const first = await connect('Agent 1');
  await first.getByRole('textbox', { name: 'Message Agent 1' }).fill('Remember the shop');
  await first.getByRole('textbox', { name: 'Message Agent 1' }).press('Enter');
  await expect(first.getByText('You said: Remember the shop')).toBeVisible();
  await expect(first.getByText(/^Worked for \d+s$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first).toHaveCount(0);

  // Agent 2 can't open it while Agent 1's session runs it: two agents never share a conversation.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 600, y: 420 } });
  let second = await connect('Agent 2');
  let composer = second.getByRole('textbox', { name: 'Message Agent 2' });
  await composer.fill('/resume');
  await composer.press('Enter');
  let picker = second.getByRole('listbox', { name: 'Resume a conversation' });
  await expect(picker.getByRole('option')).toHaveText([/^Remember the shop just now/]);
  await picker.getByRole('option').click();
  await expect(second.getByRole('alert')).toHaveText(
    'That conversation is open in "Agent 1": two agents never share one conversation.',
  );
  await second.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Escape');
  await expect(second).toHaveCount(0);

  // Once Agent 1 and its session are gone, Agent 2 opens it.
  await page
    .locator('.react-flow__node-agent')
    .filter({ has: page.locator('.graph-label').filter({ hasText: /^Agent 1$/ }) })
    .click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.graph-label').filter({ hasText: /^Agent 1$/ })).toHaveCount(0);
  await page
    .locator('.react-flow__node-agent')
    .filter({ has: page.locator('.graph-label').filter({ hasText: /^Agent 2$/ }) })
    .dblclick();
  second = page.getByRole('dialog', { name: 'Agent 2', exact: true });
  composer = second.getByRole('textbox', { name: 'Message Agent 2' });
  await composer.fill('/resume');
  await composer.press('Enter');
  picker = second.getByRole('listbox', { name: 'Resume a conversation' });
  await expect(picker.getByRole('option')).toHaveText([/^Remember the shop/]);
  await picker.getByRole('option').click();
  const transcript = second.getByRole('log', { name: 'Transcript' });
  await expect(transcript.getByText('Remember the shop', { exact: true })).toBeVisible();
  await expect(transcript.getByText('You said: Remember the shop')).toBeVisible();

  // It goes on from there.
  await composer.fill('And the cart');
  await composer.press('Enter');
  await expect(transcript.getByText('You said: And the cart')).toBeVisible();
});

test('shows an agent’s MCP servers with /mcp, and a form one of them asks for', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  const view = await openSdkAgent('Agent 1');
  // The session started: the CLI's models are offered (before that the button says "Default model"),
  // and /mcp asks a session that is running.
  await expect(view.getByRole('button', { name: 'Model: Default (recommended)' })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });

  // /mcp: the fake's two servers, one failed until it is reconnected.
  await composer.fill('/mcp');
  await composer.press('Enter');
  const servers = view.getByRole('group', { name: 'MCP servers' });
  const sentry = servers.getByRole('listitem', { name: 'sentry' });
  await expect(servers.getByRole('listitem', { name: 'github' })).toContainText(
    'Connected · user · 2 tools',
  );
  await expect(sentry).toContainText('Failed: Connection refused · project');
  await sentry.getByRole('button', { name: 'Reconnect' }).click();
  await expect(sentry).toContainText('Connected · project · 2 tools');
  await page.keyboard.press('Escape');
  await expect(servers).toHaveCount(0);
  await expect(view).toBeVisible();

  // A server's form, in the transcript: what is filled in goes back to it.
  await composer.fill('file an issue: fill in a form');
  await composer.press('Enter');
  const transcript = view.getByRole('log', { name: 'Transcript' });
  const form = transcript.getByRole('form', { name: 'github asks' });
  await form.getByRole('textbox', { name: 'Repository' }).fill('acme/shop');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(
    transcript.getByText('github got: accept {"repo":"acme/shop","draft":false}'),
  ).toBeVisible();
});

test('rewinds the code and the conversation to before a message', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  const notes = path.join(folder, 'notes.txt');
  await writeFile(notes, 'one\nthree\n');
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  const view = await openSdkAgent('Agent 1');
  await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  const transcript = view.getByRole('log', { name: 'Transcript' });

  await composer.fill('Remember the shop');
  await composer.press('Enter');
  await expect(transcript.getByText('You said: Remember the shop')).toBeVisible();
  await composer.fill('please edit it');
  await composer.press('Enter');
  await transcript
    .getByRole('group', { name: 'Edit file: notes.txt' })
    .getByRole('button', { name: 'Yes', exact: true })
    .click();
  await expect(transcript.getByRole('button', { name: 'Edit notes.txt +1 −1' })).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toHaveCount(2);
  await expect.poll(() => readFile(notes, 'utf8')).toBe('two\nthree\n');

  // Back to before the edit: its file, and the conversation.
  const message = transcript.getByText('please edit it', { exact: true });
  await message.hover();
  await transcript.getByRole('button', { name: 'Rewind to here' }).nth(1).click();
  const panel = view.getByRole('group', { name: 'Rewind' });
  await expect(panel).toContainText('Restores notes.txt (+1 −1).');
  await panel.getByRole('button', { name: 'Restore code and conversation' }).click();
  await expect.poll(() => readFile(notes, 'utf8')).toBe('one\nthree\n');
  await expect(
    transcript.getByText(
      'Rewound the conversation to before “please edit it”, and restored notes.txt (+1 −1).',
    ),
  ).toBeVisible();
  await expect(transcript.getByText('You said: Remember the shop')).toBeVisible();
  await expect(transcript.getByText('please edit it', { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('please edit it');
});

test('stops work in the background, answers with the keyboard, and sets the effort', async () => {
  const folder = path.join(dir, 'shop');
  await mkdir(folder);
  await app.evaluate(({ dialog }, picked) => {
    Object.assign(dialog, {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [picked] }),
    });
  }, folder);
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  const view = await openSdkAgent('Agent 1');
  const composer = view.getByRole('textbox', { name: 'Message Agent 1' });
  const transcript = view.getByRole('log', { name: 'Transcript' });

  // The effort goes to the session (session.setEffort): the CLI takes it.
  await view.getByRole('button', { name: 'Effort: Default' }).click();
  await view.getByRole('menuitemradio', { name: /^High/ }).click();
  await expect(view.getByRole('button', { name: 'Effort: High' })).toBeVisible();

  // Its permission prompt is answered with 1, typed in the empty composer.
  await composer.fill('start the dev server in the background');
  await composer.press('Enter');
  await expect(transcript.getByRole('group', { name: 'Bash command: npm run dev' })).toBeVisible();
  await composer.press('1');
  await expect(composer).toHaveValue('');
  const tasks = view.getByRole('group', { name: 'Background tasks' });
  await expect(tasks.getByText('npm run dev')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();

  // Stopped from its line (session.stopTask): its line says so, and the list is gone.
  const line = transcript.locator('.agent-tool', {
    has: page.getByRole('button', { name: 'Bash npm run dev' }),
  });
  await line.getByRole('button', { name: 'Stop npm run dev' }).click();
  await expect(tasks).toBeHidden();
  await expect(line).toHaveAttribute('data-status', 'interrupted');
  await expect(transcript.getByRole('alert')).toHaveCount(0);
});
