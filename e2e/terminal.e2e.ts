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
