import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * Codex Terminal agents, through the real app: Codex's own TUI in a real pseudo-terminal (node-pty
 * in main, xterm.js in the agent view, under the production CSP), the hooks it runs (posting to
 * corrallm, trusted for the session alone), and corrallm following its turns by its window title.
 * `codex` is a fake (fake-codex-tui.mjs) that prints the real CLI's formats and runs its hooks as
 * Codex does; it logs what it gets in the project folder (.fake-codex/log.jsonl), since the
 * terminal draws its text on a canvas.
 */

test.skip(process.platform === 'win32', 'The fake codex is a Node script run through sh.');

let dir: string;
let folder: string;
let profile: string;
let codex: string;
let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-terminal-'));
  folder = path.join(dir, 'shop');
  profile = path.join(dir, 'profile');
  await mkdir(folder);
  await mkdir(profile);
  // Runs the fake with this Node, whatever the login shell's PATH has.
  codex = path.join(dir, 'codex');
  const fake = path.join(import.meta.dirname, 'fake-codex-tui.mjs');
  await writeFile(codex, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(codex, 0o755);
  await launch();
});

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
    { folder, canvas: path.join(dir, 'team.corral') },
  );
}

interface Logged {
  event: string;
  args?: string[];
  text?: string;
  session?: string;
  cwd?: string;
  code?: number;
}

/** What the fake codex logged: how it was started, the prompts it got, how it ended. */
async function logged(): Promise<Logged[]> {
  const file = path.join(folder, '.fake-codex', 'log.jsonl');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Logged);
}
const prompts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'prompt' ? [entry.text] : []));
const starts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'start' ? [entry.args ?? []] : []));
/** Waits for the fake's `count`th run to show its composer (its hooks trusted). */
async function codexReady(count = 1) {
  await expect
    .poll(async () => (await logged()).filter((entry) => entry.event === 'ready').length)
    .toBe(count);
}

/** A canvas with one Codex Terminal agent, Shop, whose queue holds `queue`. */
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
          connection: 'codex.terminal',
          ...(queue.length > 0 ? { queue } : {}),
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    'Shop, Codex · Terminal',
  );
}

async function chooseProject() {
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
}

/** Opens agent Shop's view, its terminal shown once Codex (its `run`th run) is ready. */
async function openShop(run = 1): Promise<{ view: Locator; terminal: Locator }> {
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Shop' });
  const terminal = view.locator('.agent-terminal');
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await codexReady(run);
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

test('runs Codex itself in a terminal in the project folder, and follows its turns', async () => {
  await chooseProject();
  // An agent, run as Codex in a Terminal from its chip.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('codex terminal');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('button', { name: 'Agent: Codex · Terminal' })).toBeVisible();
  const terminal = view.locator('.agent-terminal');
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await expect(view.getByText('Codex CLI works in shop, in a terminal.')).toBeVisible();

  // Codex itself, its own agent, in the folder (trusted for this session), as a terminal; its
  // hooks trusted for the session (else it would stop at "Hooks need review").
  await expect.poll(starts).toHaveLength(1);
  const [args] = await starts();
  expect(args?.slice(0, 3)).toEqual(['--no-daemon', '-C', realpathSync(folder)]);
  const [start] = await logged();
  expect(start).toMatchObject({ cwd: realpathSync(folder), term: 'xterm-256color' });
  await codexReady();
  await expect(status(view)).toHaveText('Idle');
  await expect(submissions(view)).toHaveCount(0);

  // A prompt typed in the terminal (while its MCP servers start): corrallm sees its turn end.
  await typeIn(terminal, 'hello there', 'Enter');
  await expect.poll(prompts).toEqual(['hello there']);
  await expect(submissions(view)).toHaveCount(1);
  await expect(submissions(view).first()).toContainText('hello there');
  const firstSubmission = (await submissions(view).first().getAttribute('data-submission')) ?? '';
  expect(firstSubmission).not.toBe('');
  await expect(status(view)).toHaveText('Idle');

  // It asks to approve a command: it needs the user, here and on the canvas.
  await typeIn(terminal, 'ask to run echo', 'Enter');
  await expect(status(view)).toHaveText('Needs you, in the terminal');
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(view).toHaveCount(0);
  const card = page.locator('.react-flow__node');
  await expect(card).toHaveClass(/\basking\b/);
  // Listed in Needs you, to answer in its terminal.
  const needs = page.getByRole('complementary', { name: 'Needs you' });
  await expect(needs.getByRole('group', { name: /asks, in its terminal$/ })).toContainText(
    'Codex needs you: see its terminal.',
  );

  // The session ran on with its view closed; opened again, it shows the same terminal.
  await card.dblclick();
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await typeIn(terminal, 'y');
  await expect(status(view)).toHaveText('Idle');
  await expect(submissions(view)).toHaveCount(2);
  await expect(submissions(view).nth(1)).toContainText('ask to run echo');
  await expect(submissions(view).first()).toHaveAttribute('data-submission', firstSubmission);
  const submissionIds = await submissions(view).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-submission')),
  );
  expect(new Set(submissionIds).size).toBe(2);
  expect(await prompts()).toEqual(['hello there', 'ask to run echo']);
  await expect(card).not.toHaveClass(/\basking\b/);
  await expect(needs).toHaveCount(0);
  expect(await starts()).toHaveLength(1);
});

test('the fake preserves text and bracketed paste coalesced with terminal reports', async () => {
  await canvasFile();
  await chooseProject();
  const { view } = await openShop();
  const type = async (data: string) => {
    const result = await page.evaluate(
      (data) => window.api.terminalInput({ agent: 'shop', data }),
      data,
    );
    if (!result.ok) throw new Error(result.error.sentence);
  };
  const reports = '\x1b[<0;4;4M\x1b[I\x1b[1;1R\x1b]10;rgb:ffff/ffff/ffff\x1b\\';
  const manual = 'Remember the current API';
  // A PTY can deliver mouse/focus/query responses together with the first typed characters.
  await type(reports + manual);
  await type('\r');
  await expect.poll(prompts).toEqual([manual]);
  await expect(status(view)).toHaveText('Idle');
  const pasted = 'Keep both lines\nand their text';
  await type(reports + '\x1b[200~' + pasted + '\x1b[201~');
  await type('\r');
  await expect.poll(prompts).toEqual([manual, pasted]);
  await expect(status(view)).toHaveText('Idle');
});

test('the queues’ Run pastes its message into Codex, and hears its turn end', async () => {
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
  // Pasted in: one prompt, its line break kept.
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

test('reads Codex’s usage from an app server of its own, as it starts and after each turn', async () => {
  // What Codex's app server says of the plan's limits (the fake answers with this file).
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  const limits = (used: number) =>
    writeFile(
      path.join(folder, '.fake-codex-usage.json'),
      JSON.stringify({
        limitId: 'codex',
        primary: { usedPercent: used, windowDurationMins: 300, resetsAt },
        secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: resetsAt + 86_400 },
      }),
    );
  await limits(42);
  await canvasFile();
  await chooseProject();
  const { view, terminal } = await openShop();
  const gauge = page.getByRole('button', { name: /^Codex usage:/ });
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(gauge).toHaveAttribute(
    'aria-label',
    'Codex usage: 42% of 5-hour window, 17% of weekly window',
  );

  // A turn spends some: read again once it ends.
  await limits(55);
  await page.locator('.react-flow__node').dblclick();
  await typeIn(terminal, 'hello', 'Enter');
  await expect(status(view)).toHaveText('Idle');
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(gauge).toHaveAttribute(
    'aria-label',
    'Codex usage: 55% of 5-hour window, 17% of weekly window',
  );
  // Read apart from its terminal: nothing was typed into it but the prompt, and its app servers
  // were asked nothing that uses the plan (its settings, beside its chip, read its models and
  // the user's config).
  expect(await prompts()).toEqual(['hello']);
  const asked = (await readFile(path.join(folder, '.fake-codex', 'app-server.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { method: string }).method);
  expect(new Set(asked)).toEqual(
    new Set(['initialize', 'hooks/list', 'account/rateLimits/read', 'model/list', 'config/read']),
  );
});

test('starts Codex with the model, effort and mode its agent is set to, from Codex’s own models', async () => {
  await canvasFile();
  await chooseProject();
  const { view } = await openShop();
  // Nothing set: the user's own config, as Codex's app server reads it, with no flags of corrallm's.
  const settings = view.getByRole('button', { name: /^Agent settings:/ });
  await expect(settings).toContainText('GPT-6.1-Sol · Max · Default');
  const [first = []] = await starts();
  expect(first).not.toContain('-m');
  expect(first.some((arg) => arg.startsWith('model_reasoning_effort='))).toBe(false);

  await settings.click();
  const panel = page.getByRole('dialog', { name: /^Agent settings:/ });
  await panel.getByRole('button', { name: 'Model: Default (GPT-6.1-Sol)' }).click();
  await panel.getByRole('menuitemradio', { name: /^GPT-6-Luna/ }).click();
  await panel.getByRole('button', { name: /^Effort: / }).click();
  await panel.getByRole('menuitemradio', { name: /^Low/ }).click();
  await panel.getByRole('button', { name: 'Mode: Default' }).click();
  await panel.getByRole('menuitemradio', { name: /^Read only/ }).click();
  await expect(settings).toContainText('GPT-6-Luna · Low · Read only');

  await panel.getByRole('button', { name: 'Restart with these' }).click();
  await codexReady(2);
  const again = (await starts())[1] ?? [];
  expect(again[again.indexOf('-m') + 1]).toBe('gpt-6-luna');
  expect(again).toContain('model_reasoning_effort="low"');
  expect(again.slice(again.indexOf('-s'), again.indexOf('-s') + 4)).toEqual([
    '-s',
    'read-only',
    '-a',
    'on-request',
  ]);
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
});

test('resumes the agent’s Codex session after the app restarts', async () => {
  await canvasFile();
  await chooseProject();
  const { terminal } = await openShop();
  await typeIn(terminal, 'remember this', 'Enter');
  await expect.poll(prompts).toEqual(['remember this']);
  await expect(status(page.getByRole('dialog', { name: 'Shop' }))).toHaveText('Idle');
  await page.getByRole('button', { name: 'Back to the canvas' }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('team.corral')).toBeVisible();
  const session = (await logged()).find((entry) => entry.event === 'prompt')?.session;
  expect(session).toMatch(/^[0-9a-f-]{36}$/);

  // Quitting ends Codex first.
  await closeApp();
  expect((await logged()).at(-1)).toMatchObject({ event: 'exit', code: 0 });

  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await openShop(2);
  await expect.poll(starts).toHaveLength(2);
  expect((await starts()).at(-1)?.slice(0, 2)).toEqual(['resume', session]);
});
