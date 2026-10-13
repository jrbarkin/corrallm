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
let claude: string;
let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-terminal-'));
  folder = path.join(dir, 'shop');
  profile = path.join(dir, 'profile');
  await mkdir(folder);
  await mkdir(profile);
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
    env: { CORRALLM_CLAUDE_PATH: claude },
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
const starts = async () =>
  (await logged()).flatMap((entry) => (entry.event === 'start' ? [entry.args ?? []] : []));
/** Waits for the fake's `count`th run to take keys (keys typed earlier the tty buffers as a line). */
async function claudeReady(count = 1) {
  await expect
    .poll(async () => (await logged()).filter((entry) => entry.event === 'ready').length)
    .toBe(count);
}

/** A canvas with one Terminal agent, Shop, whose queue holds `queue`. */
async function canvasFile(queue: { id: string; message: string }[] = []) {
  const file = path.join(dir, 'team.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 1,
      nodes: [
        {
          id: 'shop',
          kind: 'agent',
          label: 'Shop',
          position: { x: 0, y: 0 },
          agent: 'Claude',
          connection: 'terminal',
          ...(queue.length > 0 ? { queue } : {}),
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    'Shop, Claude · Terminal',
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

test('runs Claude Code itself in a terminal in the project folder, and follows its turns', async () => {
  await writeFile(path.join(folder, '.fake-claude-untrusted'), '');
  await chooseProject();
  // An agent, run in a Terminal from its chip.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('terminal');
  await page.keyboard.press('Enter');
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

  // It asks whether to trust the folder, answered in the terminal.
  await claudeReady();
  await expect(status(view)).toHaveText('Idle');
  await typeIn(terminal, 'ArrowDown', 'Enter');
  await expect
    .poll(async () => (await logged()).some((entry) => entry.event === 'trusted'))
    .toBe(true);

  // A prompt typed in the terminal: corrallm sees it work, and its turn end.
  await typeIn(terminal, 'hello there', 'Enter');
  await expect.poll(prompts).toEqual(['hello there']);
  await expect(view.getByRole('group', { name: 'Current chat: hello there' })).toBeVisible();
  await expect(status(view)).toHaveText('Idle');

  // Escape goes to Claude Code, not to the view.
  await typeIn(terminal, 'Escape');
  await expect(view).toBeVisible();

  // It asks for permission: it needs the user, here and on the canvas.
  await typeIn(terminal, 'ask to run echo', 'Enter');
  await expect(status(view)).toHaveText('Needs you, in the terminal');
  await view.getByRole('button', { name: 'Back to the canvas' }).click();
  await expect(view).toHaveCount(0);
  const card = page.locator('.react-flow__node');
  await expect(card).toHaveClass(/\basking\b/);

  // The session ran on with its view closed; opened again, it shows the same terminal.
  await card.dblclick();
  await expect(terminal).toHaveAttribute('data-state', 'live');
  await typeIn(terminal, '1');
  await expect(status(view)).toHaveText('Idle');
  await expect(card).not.toHaveClass(/\basking\b/);
  expect(await starts()).toHaveLength(1);
});

test('an Agent SDK agent on a Claude subscription says why it can’t run, and runs in Terminal instead', async () => {
  await chooseProject();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.locator('.react-flow__node').dblclick();
  const view = page.getByRole('dialog', { name: 'Agent 1' });
  await view.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('agent sdk');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('button', { name: 'Agent: Claude · Agent SDK' })).toBeVisible();
  const refusal = view.getByRole('log', { name: 'Transcript' }).getByRole('alert');
  await expect(refusal).toContainText(
    "Claude Code is logged in with your Claude subscription, which Anthropic doesn't allow other products to use through the Agent SDK",
  );

  await refusal.getByRole('button', { name: 'Switch to Terminal' }).click();
  await expect(view.getByRole('button', { name: 'Agent: Claude · Terminal' })).toBeVisible();
  await expect(view.locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
  await claudeReady();
  // Claude Code ran only in the terminal: the Agent SDK never started it.
  expect(await starts()).toHaveLength(1);
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

test('the queues’ Run types its message into the terminal, and hears its turn end', async () => {
  await canvasFile([{ id: 'docs', message: 'Write the docs\nand the changelog' }]);
  await chooseProject();
  const { view } = await openShop();
  await view.getByRole('button', { name: 'All queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues' });
  await queues.getByRole('button', { name: 'Run' }).click();
  await expect(queues.getByRole('status')).toHaveText('All done');
  // Typed in as a person types it: one prompt, its line break kept, not pasted.
  expect(await prompts()).toEqual(['Write the docs\nand the changelog']);
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
  const id = first?.[3];

  // Quitting ends Claude Code first.
  await closeApp();
  expect((await logged()).at(-1)).toMatchObject({ event: 'exit', code: 0 });

  await launch();
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await openShop(2);
  await expect.poll(starts).toHaveLength(2);
  expect((await starts()).at(-1)?.slice(2, 4)).toEqual(['--resume', id]);
});
