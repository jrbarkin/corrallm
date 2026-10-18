import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * Terminal agents, through the real app: Claude Code's terminal in a real pseudo-terminal (node-pty
 * in main, xterm.js in the agent view, under the production CSP), the hooks it reports to, and
 * corrallm following its turns. `claude` is a fake (fake-claude.mjs) that prints the real CLI's
 * formats; it logs what it gets in the project folder (.fake-claude/log.jsonl), since the
 * terminal draws its text on a canvas.
 */

test.skip(process.platform === 'win32', 'The fake claude is a Node script run through sh.');

let dir: string;
let folder: string;
let profile: string;
/** The user's own Claude Code settings (CLAUDE_CONFIG_DIR), never the real ~/.claude. */
let config: string;
let claude: string;
let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-terminal-'));
  folder = path.join(dir, 'shop');
  profile = path.join(dir, 'profile');
  config = path.join(dir, 'claude-config');
  await mkdir(folder);
  await mkdir(profile);
  await mkdir(config);
  // Runs the fake with this Node, whatever the login shell's PATH has.
  claude = path.join(dir, 'claude');
  const fake = path.join(import.meta.dirname, 'fake-claude.mjs');
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(claude, 0o755);
  await launch();
});

test.afterEach(async () => {
  await closeApp();
  await rm(dir, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

async function launch() {
  ({ app, close: closeApp } = await launchApp({
    env: { CORRALLM_CLAUDE_PATH: claude, CLAUDE_CONFIG_DIR: config },
    profile,
  }));
  page = await app.firstWindow();
  problems = [];
  page.on('console', (message) => {
    // xterm.js's own note that an idle task ran long (its WebGL glyph cache warming up on a busy
    // machine): timing, not a problem.
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.waitForLoadState('load');
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await answerDialogs(path.join(dir, 'team.corral'));
}

/** Answers main's dialogs for the user: the project folder, and canvas files with `canvas`. */
async function answerDialogs(canvas: string) {
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

/** What the fake claude logged: how it was started, the prompts it got, how it ended. */
async function logged(): Promise<
  { event: string; args?: string[]; text?: string; cwd?: string }[]
> {
  const file = path.join(folder, '.fake-claude', 'log.jsonl');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string });
}
const prompts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'prompt' ? [entry.text] : []));
const pastes = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'paste' ? [entry.text] : []));
const starts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'start' ? [entry.args ?? []] : []));
/** Waits for the fake's `count`th run to take keys (keys typed earlier the tty buffers as a line). */
async function claudeReady(count = 1) {
  await expect
    .poll(async () => (await logged()).filter((entry) => entry.event === 'ready').length)
    .toBe(count);
}

/** A canvas with one Terminal agent, Shop, whose queue holds `queue`, set as `settings` say. */
async function canvasFile(
  queue: { id: string; message: string }[] = [],
  settings?: unknown,
  connection: 'claude-code.terminal' | 'claude-code.sdk' = 'claude-code.terminal',
) {
  const file = path.join(dir, 'team.corral');
  await writeFile(
    file,
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
          adapter: 'claude-code',
          connection,
          ...(settings === undefined ? {} : { settings }),
          ...(queue.length > 0 ? { queue } : {}),
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    connection === 'claude-code.terminal' ? 'Shop, Claude · Terminal' : 'Shop, Claude · SDK',
  );
}

async function chooseProject() {
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
}

/** Opens agent Shop's view, its terminal shown once Claude Code (its `run`th run) takes keys. */
async function openShop(run = 1): Promise<{ view: Locator; terminal: Locator }> {
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  const terminal = view.locator('.agent-terminal');
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await claudeReady(run);
  return { view, terminal };
}

/** Types in the terminal, as the user does. */
async function typeIn(terminal: Locator, ...keys: string[]) {
  await terminal.click();
  for (const key of keys) {
    if (/^[A-Z][a-zA-Z]+$/.test(key)) await page.keyboard.press(key);
    else await page.keyboard.type(key);
  }
}

const status = (view: Locator) => view.locator('.agent-terminal-status');
const submissions = (view: Locator) => view.locator('.graph-queue-message[data-submission]');

test('an omitted connection runs in the native Terminal as a chosen one does, without starting or replaying its queue', async () => {
  const file = path.join(dir, 'team.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: [
        {
          id: 'omitted',
          kind: 'agent',
          label: 'Omitted',
          adapter: 'claude-code',
          position: { x: 0, y: 0 },
          queue: [{ id: 'work', message: 'Omitted connection work' }],
        },
        {
          id: 'chosen',
          kind: 'agent',
          label: 'Chosen',
          adapter: 'claude-code',
          connection: 'claude-code.terminal',
          position: { x: 350, y: 0 },
          queue: [{ id: 'work', message: 'Chosen connection work' }],
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node-agent')).toHaveCount(2);
  for (const [id, name] of [
    ['omitted', 'Omitted'],
    ['chosen', 'Chosen'],
  ] as const) {
    await expect(page.locator(`.react-flow__node-agent[data-id="${id}"]`)).toHaveAttribute(
      'aria-label',
      `${name}, Claude · Terminal`,
    );
  }
  await chooseProject();
  expect(await starts()).toEqual([]);
  expect(await prompts()).toEqual([]);
  await page.getByRole('button', { name: 'Show all queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  await expect(queues.getByRole('status')).toHaveText('');
  await expect(queues.locator('[data-at][data-run]')).toHaveCount(0);
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(queues.getByRole('status')).toHaveText('All done', { timeout: 15_000 });
  expect((await prompts()).sort()).toEqual(
    ['Omitted connection work', 'Chosen connection work'].sort(),
  );
  await queues.getByRole('button', { name: 'Back', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(async () =>
      (JSON.parse(await readFile(file, 'utf8')) as { nodes: { connection?: string }[] }).nodes.map(
        (node) => node.connection,
      ),
    )
    .toEqual([undefined, 'claude-code.terminal']);
  await page.reload();
  await expect(page.locator('.react-flow__node-agent')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show all queues' }).click();
  await expect(queues.locator('[data-at][data-run="succeeded"]')).toHaveCount(2);
  expect((await prompts()).sort()).toEqual(
    ['Omitted connection work', 'Chosen connection work'].sort(),
  );
});

test('a new canvas agent defaults to real Claude Code in its Terminal, without a simulated choice or placeholder reply', async () => {
  await writeFile(path.join(folder, '.fake-claude-untrusted'), '');
  await chooseProject();
  // A new canvas agent runs Claude Code directly in its default native Terminal.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await expect(view.getByRole('option', { name: /Simulated|Qwen|Gemini/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(view.getByRole('button', { name: 'Agent: Claude · Terminal' })).toBeVisible();
  const terminal = view.locator('.agent-terminal');
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await expect(view.getByText('Claude Code works in shop, in a terminal.')).toBeVisible();

  // Claude Code itself: in the folder, as a terminal, reporting to corrallm's hooks.
  await expect.poll(starts).toHaveLength(1);
  const [args] = await starts();
  expect(args?.[0]).toBe('--settings');
  expect(args?.[2]).toBe('--session-id');
  const [start] = await logged();
  expect(start).toMatchObject({ cwd: realpathSync(folder), term: 'xterm-256color' });

  // It asks whether to trust the folder: it needs the user, though nothing runs yet. Answered in
  // the terminal.
  await claudeReady();
  await expect(status(view)).toHaveText('Trust this folder in the terminal');
  await typeIn(terminal, 'ArrowDown', 'Enter');
  await expect
    .poll(async () => (await logged()).some((entry) => entry.event === 'trusted'))
    .toBe(true);
  await expect(status(view)).toHaveText('Idle');
  await expect(submissions(view)).toHaveCount(0);

  // A prompt typed in the terminal: corrallm sees it work, and its turn end.
  await typeIn(terminal, 'hello there', 'Enter');
  await expect.poll(prompts).toEqual(['hello there']);
  await expect(submissions(view)).toHaveCount(1);
  await expect(submissions(view).first()).toContainText('hello there');
  const firstSubmission = (await submissions(view).first().getAttribute('data-submission')) ?? '';
  expect(firstSubmission).not.toBe('');
  await expect(status(view)).toHaveText('Idle');

  // Escape goes to Claude Code, not to the view.
  await typeIn(terminal, 'Escape');
  await expect(view).toBeVisible();

  // It asks for permission: it needs the user, here and on the canvas, where the Needs you
  // sidebar says what it asks (as its hooks told), to answer in the terminal.
  await typeIn(terminal, 'ask to run echo', 'Enter');
  await expect(status(view)).toHaveText('Needs you, in the terminal');
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(view).toHaveCount(0);
  const card = page.locator('.react-flow__node');
  await expect(card).toHaveClass(/\basking\b/);
  const needsYou = page.getByRole('complementary', { name: 'Needs you' });
  const asked = needsYou.getByRole('group', { name: 'Agent 1 asks, in its terminal' });
  await expect(asked).toContainText('Bashecho helloDo you want to proceed?');

  // The session ran on with its view closed; opened again, it shows the same terminal.
  await asked.getByRole('button', { name: 'Open terminal' }).click();
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await typeIn(terminal, '1');
  await expect(status(view)).toHaveText('Idle');
  await expect(submissions(view)).toHaveCount(2);
  await expect(submissions(view).nth(1)).toContainText('ask to run echo');
  await expect(submissions(view).first()).toHaveAttribute('data-submission', firstSubmission);
  await expect(card).not.toHaveClass(/\basking\b/);
  await expect(needsYou).toHaveCount(0);
  expect(await starts()).toHaveLength(1);

  // Its question (AskUserQuestion), with its header and what its answers mean, read only.
  await typeIn(terminal, 'question about the database', 'Enter');
  await expect(status(view)).toHaveText('Needs you, in the terminal');
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(asked).toContainText(
    'DatabaseWhich database?PostgresWhat the app uses todaySQLiteOne file, for tests',
  );
  await expect(asked.getByRole('textbox')).toHaveCount(0);
  await asked.getByRole('button', { name: 'Open terminal' }).click();
  await typeIn(terminal, '1');
  await expect(status(view)).toHaveText('Idle');
  await expect(needsYou).toHaveCount(0);
  await expect(submissions(view)).toHaveCount(3);
  await expect(submissions(view).nth(2)).toContainText('question about the database');
  const submissionIds = await submissions(view).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-submission')),
  );
  expect(new Set(submissionIds).size).toBe(3);
  expect(await prompts()).toEqual([
    'hello there',
    'ask to run echo',
    'question about the database',
  ]);
});

test('starts Claude Code with the model, effort and mode its agent is set to, chosen beside its chip', async () => {
  // The user's own: what applies where nothing is chosen, read without a prompt.
  await writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ model: 'opus', effortLevel: 'xhigh', permissions: { defaultMode: 'auto' } }),
  );
  await canvasFile([], { 'claude-code': { model: 'haiku', effort: 'low', mode: 'plan' } });
  await chooseProject();
  const { view, terminal } = await openShop();
  // Passed per session on its command line, never saved in the user's settings.
  const [args = []] = await starts();
  const flag = (name: string) => args[args.indexOf(name) + 1];
  expect([flag('--model'), flag('--effort'), flag('--permission-mode')]).toEqual([
    'haiku',
    'low',
    'plan',
  ]);
  const settings = view.getByRole('button', { name: /^Agent settings:/ });
  await expect(settings).toContainText('Haiku · Low · Plan');
  // A conversation, for a restart to resume.
  await typeIn(terminal, 'hello', 'Enter');
  await expect.poll(prompts).toEqual(['hello']);
  await expect(status(view)).toHaveText('Idle');

  // Back to the user's own model and mode: what they are shows.
  await settings.click();
  const panel = page.getByRole('dialog', { name: /^Agent settings:/ });
  await panel.getByRole('button', { name: 'Model: Haiku' }).click();
  await expect(panel.getByRole('menu', { name: 'Model' })).toContainText('Default (Opus)');
  await panel.getByRole('menuitemradio', { name: /^Default \(Opus\)/ }).click();
  await panel.getByRole('button', { name: 'Mode: Plan' }).click();
  await panel.getByRole('menuitemradio', { name: /^Default \(Auto\)/ }).click();
  await expect(settings).toContainText('Opus · Low · Auto');

  // Restarted with them, resuming its conversation.
  await panel.getByRole('button', { name: 'Restart with these' }).click();
  await expect.poll(async () => (await starts()).length).toBe(2);
  await claudeReady(2);
  const again = (await starts())[1] ?? [];
  expect(again).toContain(`--resume=${args[args.indexOf('--session-id') + 1] ?? ''}`);
  expect(again[again.indexOf('--effort') + 1]).toBe('low');
  expect(again).not.toContain('--model');
  expect(again).not.toContain('--permission-mode');
  await expect(panel.getByRole('button', { name: 'Restart with these' })).toHaveCount(0);

  // Saved with the agent, in the canvas's file.
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(view).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(async () => {
      const file = JSON.parse(await readFile(path.join(dir, 'team.corral'), 'utf8')) as {
        nodes: { settings?: unknown }[];
      };
      return file.nodes[0]?.settings;
    })
    .toEqual({ 'claude-code': { effort: 'low' } });
  // The user's own settings are as they were.
  expect(JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8'))).toEqual({
    model: 'opus',
    effortLevel: 'xhigh',
    permissions: { defaultMode: 'auto' },
  });
});

test('a template’s Claude agents run in their terminals, asked once whether to trust the folder', async () => {
  await writeFile(path.join(folder, '.fake-claude-untrusted'), '');
  // The user has Claude Code (here, the fake): a template's Claude agents run in a Terminal.
  await page.getByRole('button', { name: 'Start from a template…' }).click();
  const gallery = page.getByRole('dialog', { name: 'Templates' });
  await gallery.getByRole('button', { name: /^Independent cross-check/ }).click();
  for (const role of ['Builder', 'Checker']) {
    await expect(gallery.getByRole('combobox', { name: `How ${role} runs` })).toHaveValue(
      'claude-code.terminal',
    );
  }
  await gallery.getByRole('button', { name: 'Create canvas' }).click();
  await expect(page.locator('.react-flow__node[data-id="builder"]')).toHaveAttribute(
    'aria-label',
    'Builder, Claude · Terminal',
  );
  await chooseProject();
  // Their Claude Codes start only when needed.
  await page.waitForTimeout(300);
  expect(await starts()).toEqual([]);

  await page.getByRole('button', { name: 'Show all queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues' });
  await queues.getByRole('button', { name: 'Run' }).click();
  // One starts first, and asks whether to trust the folder; the other waits for it.
  await expect.poll(starts).toHaveLength(1);
  await expect(queues.getByRole('status')).toContainText('1 needs you');
  await page.waitForTimeout(500);
  expect(await starts()).toHaveLength(1);
  await queues.getByRole('button', { name: 'Back' }).click();
  const asked = page
    .getByRole('complementary', { name: 'Needs you' })
    .getByRole('group', { name: / asks, in its terminal$/ });
  await expect(asked).toHaveCount(1);
  await expect(asked).toContainText('Trust this folder in the terminal.');
  await asked.getByRole('button', { name: 'Open terminal' }).click();
  const view = page.getByRole('dialog', { name: /^(Builder|Checker)$/ });
  await expect(status(view)).toHaveText('Trust this folder in the terminal');
  const terminal = view.locator('.agent-terminal');
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await typeIn(terminal, 'ArrowDown', 'Enter');

  // Trusted: the other starts and asks nothing, and the run goes on to the end.
  await expect.poll(starts).toHaveLength(2);
  await view.getByRole('button', { name: 'All queues' }).click();
  await expect(queues.getByRole('status')).toHaveText('All done', { timeout: 30_000 });
  expect((await logged()).filter((entry) => entry.event === 'trusted')).toHaveLength(1);
  expect(await starts()).toHaveLength(2);
});

test('an Agent SDK agent on a Claude subscription says why it can’t run, and runs in Terminal instead', async () => {
  // Start this refusal fixture on its authored SDK connection; new agents use Terminal directly.
  await canvasFile([], undefined, 'claude-code.sdk');
  await chooseProject();
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  await expect(view.getByRole('button', { name: 'Agent: Claude · Agent SDK' })).toBeVisible();
  const transcript = view.getByRole('log', { name: 'Transcript' });
  const refusal = transcript.getByRole('alert');
  await expect(refusal).toContainText(
    "Claude Code is logged in with your Claude subscription, which Anthropic doesn't allow other products to use through the Agent SDK",
  );
  // A message sent meanwhile never reaches Claude: it is kept, queued, not a turn that failed.
  await view.getByRole('textbox', { name: 'Message Shop' }).fill('Fix the login bug');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('list', { name: 'Queued messages' })).toContainText(
    'Fix the login bug',
  );
  await expect(refusal).toHaveCount(1);
  await expect(transcript.getByText('Fix the login bug')).toHaveCount(0);

  await refusal.getByRole('button', { name: 'Switch to Terminal' }).click();
  await expect(view.getByRole('button', { name: 'Agent: Claude · Terminal' })).toBeVisible();
  await expect(view.locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
  await claudeReady();
  // Claude Code ran only in the terminal: the Agent SDK never started it. What was kept goes there.
  expect(await starts()).toHaveLength(1);
  await expect.poll(prompts).toEqual(['Fix the login bug']);

  // Its chip's menu opens over the terminal, and takes the pointer there.
  await view.getByRole('button', { name: 'Agent: Claude · Terminal' }).click();
  await view.getByRole('option', { name: /^Claude · Agent SDK/ }).click({ timeout: 5000 });
  await expect(view.getByRole('button', { name: 'Agent: Claude · Agent SDK' })).toBeVisible();
});

test('opens a link Cmd-clicked in the terminal in the browser, once main has asked', async () => {
  await app.evaluate(({ dialog, shell }) => {
    const seen = globalThis as unknown as { asked: string[]; opened: string[] };
    seen.asked = [];
    seen.opened = [];
    Object.assign(dialog, {
      showMessageBox: (...args: unknown[]) => {
        seen.asked.push((args.at(-1) as { message: string }).message);
        return Promise.resolve({ response: 0, checkboxChecked: false });
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
  await canvasFile();
  await chooseProject();
  const { view, terminal } = await openShop();
  await typeIn(terminal, 'link please', 'Enter');
  await expect
    .poll(async () => (await logged()).some((entry) => entry.event === 'replied'))
    .toBe(true);

  // The reply's link is on the screen's fourth row (title, blank, prompt, reply), from column 6.
  const sizes = (await logged()).filter((entry) => entry.event === 'size');
  const { cols, rows } = sizes.at(-1) as unknown as { cols: number; rows: number };
  const screen = await view.locator('.xterm-screen').boundingBox();
  if (!screen) throw new Error('no terminal screen');
  const cell = (col: number, row: number) => ({
    x: screen.x + ((col + 0.5) * screen.width) / cols,
    y: screen.y + ((row + 0.5) * screen.height) / rows,
  });
  const at = cell(20, 3);
  // Cmd-clicked, it opens once main has asked. The terminal finds a link as the pointer comes
  // onto its cell, so it comes from another each time, until the reply on screen has it.
  await expect
    .poll(async () => {
      const away = cell(2, 3);
      await page.mouse.move(away.x, away.y);
      await page.mouse.move(at.x, at.y, { steps: 2 });
      await page.keyboard.down('ControlOrMeta');
      await page.mouse.click(at.x, at.y);
      await page.keyboard.up('ControlOrMeta');
      return (await seen()).opened.length;
    })
    .toBeGreaterThan(0);
  // (Clicks still on their way to main land first.)
  await page.waitForTimeout(300);
  const opened = await seen();
  expect(new Set(opened.asked)).toEqual(new Set(['Open docs.example.com in your browser?']));
  expect(new Set(opened.opened)).toEqual(new Set(['https://docs.example.com/hooks']));

  // A plain click does not open it, as in a terminal (it would be asked about at once).
  await page.mouse.move(at.x + 4, at.y);
  await page.mouse.click(at.x + 4, at.y);
  await page.waitForTimeout(300);
  expect(await seen()).toEqual(opened);
});

test('shows a file Claude Code names, Cmd-clicked, in the file manager if it is in the project folder', async () => {
  await app.evaluate(({ shell }) => {
    const seen = globalThis as unknown as { shown: string[] };
    seen.shown = [];
    Object.assign(shell, {
      showItemInFolder: (file: string) => {
        seen.shown.push(file);
      },
    });
  });
  const shown = () =>
    app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown.slice());
  await writeFile(path.join(folder, 'notes.txt'), 'hello\n');
  await writeFile(path.join(dir, 'outside.txt'), 'secret\n');
  await canvasFile();
  await chooseProject();
  const { view, terminal } = await openShop();
  await typeIn(terminal, 'files please', 'Enter');
  await expect
    .poll(async () => (await logged()).some((entry) => entry.event === 'replied'))
    .toBe(true);

  // The reply is on the screen's fourth row: "⏺ Wrote notes.txt and read outside.txt".
  const sizes = (await logged()).filter((entry) => entry.event === 'size');
  const { cols, rows } = sizes.at(-1) as unknown as { cols: number; rows: number };
  const screen = await view.locator('.xterm-screen').boundingBox();
  if (!screen) throw new Error('no terminal screen');
  const cell = (col: number, row: number) => ({
    x: screen.x + ((col + 0.5) * screen.width) / cols,
    y: screen.y + ((row + 0.5) * screen.height) / rows,
  });
  const cmdClick = async (col: number) => {
    const away = cell(2, 3);
    const at = cell(col, 3);
    await page.mouse.move(away.x, away.y);
    await page.mouse.move(at.x, at.y, { steps: 2 });
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up('ControlOrMeta');
  };
  // notes.txt, in the project folder: shown, by its real path.
  await expect
    .poll(async () => {
      await cmdClick(12);
      return (await shown()).length;
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(new Set(await shown())).toEqual(new Set([realpathSync(path.join(folder, 'notes.txt'))]));
  const before = (await shown()).length;
  // outside.txt, beside it: inert.
  for (let i = 0; i < 3; i++) await cmdClick(31);
  await page.waitForTimeout(300);
  expect(await shown()).toHaveLength(before);
});

test('the queues’ Run types its message into the terminal, and hears its turn end', async () => {
  const automated = 'Write the docs\nand the changelog';
  const manual = 'Remember the current API';
  await canvasFile([{ id: 'docs', message: automated }]);
  await chooseProject();
  const { view, terminal } = await openShop();
  await typeIn(terminal, manual, 'Enter');
  await expect.poll(prompts).toEqual([manual]);
  await expect(status(view)).toHaveText('Idle');
  await expect(submissions(view)).toHaveCount(1);
  const submissionId = (await submissions(view).first().getAttribute('data-submission')) ?? '';
  expect(submissionId).not.toBe('');
  await view.getByRole('button', { name: 'All queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues' });
  await expect(submissions(queues)).toHaveCount(1);
  await expect(submissions(queues).first()).toContainText(manual);
  await queues.getByRole('button', { name: 'Run' }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  // Typed in as a person types it: one prompt, its line break kept, not pasted.
  expect(await prompts()).toEqual([manual, automated]);
  await expect(submissions(queues)).toHaveCount(1);
  await expect(submissions(queues).first()).toHaveAttribute('data-submission', submissionId);
  // Running the authored queue again repeats its message, never the earlier manual submission.
  await queues.getByRole('button', { name: 'Run' }).click();
  await expect.poll(prompts).toEqual([manual, automated, automated]);
  await expect(queues.getByRole('status')).toHaveText('All done');
  await expect(submissions(queues)).toHaveCount(1);
  await expect(submissions(queues).first()).toHaveAttribute('data-submission', submissionId);
});

test('starts Claude Code again from its view once it exits, drawn at the view’s size', async () => {
  await canvasFile();
  await chooseProject();
  const { view, terminal } = await openShop();
  const screen = terminal.locator('.xterm-screen');
  const fitted = await screen.boundingBox();
  await typeIn(terminal, '/exit', 'Enter');
  await expect(view.getByText('Claude Code exited.')).toBeVisible();
  // Over the terminal's last screen, its button takes the click.
  await view.getByRole('button', { name: 'Start it again' }).click();
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await claudeReady(2);
  expect(await starts()).toHaveLength(2);
  // Its new screen came at main's size; the view fits it to itself again.
  await expect.poll(async () => (await screen.boundingBox())?.width).toBe(fitted?.width);
  await expect.poll(async () => (await screen.boundingBox())?.height).toBe(fitted?.height);
});

test('pastes the paths of files dropped on its terminal, quoted, as a terminal does', async () => {
  await canvasFile();
  await chooseProject();
  const { terminal } = await openShop();
  const shot = path.join(dir, 'Screen Shot.png');
  await writeFile(shot, 'png');
  // A file from the disk, as one dragged from the Finder: picked in a file input, then dropped.
  const input = (
    await page.evaluateHandle(() => {
      const element = document.createElement('input');
      element.type = 'file';
      element.hidden = true;
      document.body.append(element);
      return element;
    })
  ).asElement();
  await input.setInputFiles(shot);
  await terminal.evaluate((target, element) => {
    const data = new DataTransfer();
    for (const file of element.files ?? []) data.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }
  }, input);
  // Pasted as Claude Code asked (bracketed), its path quoted, with a space after it.
  await expect.poll(pastes).toEqual([`'${shot}' `]);
});

test('reads Claude’s usage from its status line, and still shows the user’s own', async () => {
  // The user's own status line, in the project's local settings: it keeps the input it is given.
  await mkdir(path.join(folder, '.claude'));
  await writeFile(
    path.join(folder, '.claude', 'settings.local.json'),
    JSON.stringify({
      statusLine: { type: 'command', command: 'cat > status-input.json; echo "my status line"' },
    }),
  );
  // What Claude Code's status line input says of its usage limits (the fake passes it on).
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  await writeFile(
    path.join(folder, '.fake-claude-usage.json'),
    JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: resetsAt },
      seven_day: { used_percentage: 17, resets_at: resetsAt + 2 * 86_400 },
    }),
  );
  await canvasFile();
  await chooseProject();
  await openShop();

  // The user's status line ran, given Claude Code's input, and shows what it printed.
  await expect
    .poll(async () => (await logged()).find((entry) => entry.event === 'statusline'))
    .toMatchObject({ output: 'my status line\n', code: 0 });
  const input = JSON.parse(await readFile(path.join(folder, 'status-input.json'), 'utf8')) as {
    rate_limits: unknown;
  };
  expect(input.rate_limits).toEqual({
    five_hour: { used_percentage: 42, resets_at: resetsAt },
    seven_day: { used_percentage: 17, resets_at: resetsAt + 2 * 86_400 },
  });
  // corrallm read Claude's usage from it: its gauge says so.
  await page.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(page.getByRole('button', { name: /^Claude usage:/ })).toHaveAttribute(
    'aria-label',
    'Claude usage: 42% of 5-hour window, 17% of weekly window',
  );
});

test('resumes the agent’s session after the app restarts', async () => {
  await canvasFile();
  await chooseProject();
  const { terminal } = await openShop();
  await typeIn(terminal, 'remember this', 'Enter');
  await expect.poll(prompts).toEqual(['remember this']);
  await expect(status(page.getByRole('dialog', { name: 'Shop' }))).toHaveText('Idle');
  await page.getByRole('button', { name: 'Back to the canvas' }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('team.corral')).toBeVisible();
  const [first] = await starts();
  const id = first?.[3] ?? '';

  // Quitting ends Claude Code first.
  await closeApp();
  expect((await logged()).at(-1)).toMatchObject({ event: 'exit', code: 0 });

  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await openShop(2);
  await expect.poll(starts).toHaveLength(2);
  expect((await starts()).at(-1)).toContain(`--resume=${id}`);
});
