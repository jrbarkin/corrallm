import { dismissStart, canvasAction } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { launchApp } from './launch';

/*
 * A crashed core restarts (Core Server §7.5), with the built app: the core process is killed
 * from outside, as a crash would end it; main forks a new one (at most 3 times in 60 s,
 * host/supervise.ts), the window reconnects to it, and the canvas is still there, its run paused
 * with the task it was running uncertain; the new core serves MCP on the port the old one did, and
 * api.json names it (B11 Design §9). A core that keeps stopping is given up on, saying so
 * (the hidden e2e app on stderr, without its dialog), and the app exits. Sessions run main's fake
 * connector (CORRALLM_FAKE_SESSIONS), never Claude.
 */

let dir: string;
let profile: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-e2e-core-crash-'));
  profile = path.join(dir, 'profile');
  await mkdir(profile);
  ({ app, close: closeApp } = await launchApp({
    profile,
    env: { CORRALLM_FAKE_SESSIONS: '1' },
  }));
  page = await app.firstWindow();
  await page.waitForLoadState('load');
  await dismissStart(page);
});

test.afterEach(async () => {
  const closing = closeApp;
  closeApp = undefined;
  await closing?.();
  await rm(dir, { recursive: true, force: true });
});

/** The core processes running now: main's utility processes named for the core. */
async function cores(): Promise<number[]> {
  return app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .filter((metric) => metric.type === 'Utility' && metric.name === 'corrallm core')
      .map((metric) => metric.pid),
  );
}

/** The one core process running, once there is exactly one other than `not`. */
async function theCore(not?: number): Promise<number> {
  let found: number | undefined;
  await expect
    .poll(
      async () => {
        const running = await cores();
        found = running.length === 1 && running[0] !== not ? running[0] : undefined;
        return found;
      },
      { timeout: 20_000 },
    )
    .toBeDefined();
  if (found === undefined) throw new Error('no core process');
  return found;
}

/** Opens a canvas whose one agent's message waits on a permission prompt, and runs it. */
async function runCanvas() {
  const folder = path.join(dir, 'shop');
  const canvas = path.join(dir, 'crash.corral');
  await mkdir(folder);
  await writeFile(
    canvas,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: [
        {
          id: 'builder',
          kind: 'agent',
          label: 'Builder',
          position: { x: 0, y: 0 },
          adapter: 'claude-code',
          connection: 'claude-code.sdk',
          queue: [{ id: 'task', message: 'Build the shop' }],
        },
      ],
      links: [],
    }),
  );
  await app.evaluate(
    ({ dialog }, { folder, canvas }) => {
      Object.assign(dialog, {
        showOpenDialog: (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          const picked = options.properties?.includes('openDirectory') ? folder : canvas;
          return Promise.resolve({ canceled: false, filePaths: [picked] });
        },
      });
    },
    { folder, canvas },
  );
  await canvasAction(page, 'Open…');
  await expect(page.getByText('crash.corral', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  await queues.getByRole('button', { name: 'Run', exact: true }).click();
  // The fake session asks before it runs its command (Manual), so the task goes on running.
  await expect(task()).toHaveAttribute('data-run', 'running');
}

const task = () =>
  page
    .getByRole('dialog', { name: 'All queues', exact: true })
    .locator(`[data-at='${JSON.stringify(['builder', 'task'])}']`);

/** Where the profile's MCP server listens, as its api.json says (B11 Design §9). */
async function discovery(): Promise<{ url: string; port: number; pid: number }> {
  return JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
    url: string;
    port: number;
    pid: number;
  };
}

test('a killed core restarts: the window reconnects, and the canvas is still there, its run paused', async () => {
  await runCanvas();
  const first = await theCore();
  expect(JSON.parse(await readFile(path.join(profile, 'core.lock'), 'utf8'))).toMatchObject({
    owner: 'app',
    pid: first,
  });
  // The app's MCP server runs in its core, which api.json names, never main.
  const served = await discovery();
  expect(served).toMatchObject({ pid: first, url: `http://127.0.0.1:${String(served.port)}/mcp` });
  expect((await stat(path.join(profile, 'api.json'))).mode & 0o777).toBe(0o600);

  process.kill(first, 'SIGKILL');
  const second = await theCore(first);
  // The new core listens on the same port, and api.json names it.
  await expect
    .poll(async () => (await discovery().catch(() => undefined))?.pid, { timeout: 20_000 })
    .toBe(second);
  expect((await discovery()).port).toBe(served.port);

  // The window reconnects to the new core (its page reloads, restoring its canvas from it): an
  // operation answers through its new port.
  await expect
    .poll(
      () => page.evaluate(() => window.api.appInfo()).catch((error: unknown) => String(error)),
      { timeout: 20_000 },
    )
    .toMatchObject({ ok: true, value: { name: 'corrallm' } });
  // The canvas is still there, with its folder, and its run restored paused: the task the
  // crash cut off is uncertain, never sent again on its own.
  await expect(page.getByText('crash.corral', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    'Builder, Claude · SDK',
  );
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  await expect(queues.locator('.queues-run-status')).toHaveText('Paused');
  await expect(task()).toHaveAttribute('data-problem', 'uncertain');
  // The new core holds the profile now.
  expect(JSON.parse(await readFile(path.join(profile, 'core.lock'), 'utf8'))).toMatchObject({
    owner: 'app',
    pid: second,
  });
});

test('the app serves MCP from its core on loopback, refusing what has no token, and quitting removes api.json', async () => {
  const api = await discovery();
  const response = await fetch(api.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(response.status).toBe(401);
  const closing = closeApp;
  closeApp = undefined;
  await closing?.();
  expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  await expect(fetch(api.url, { method: 'POST' })).rejects.toThrow();
});

test('a core that keeps stopping is given up on, saying so, and the app exits', async () => {
  test.setTimeout(90_000);
  const child = app.process();
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  // Three restarts within a minute...
  let core = await theCore();
  for (let restart = 1; restart <= 3; restart++) {
    process.kill(core, 'SIGKILL');
    core = await theCore(core);
  }
  // ...and the fourth stop is one too many.
  process.kill(core, 'SIGKILL');
  expect(await exited).toBe(1);
  closeApp = undefined;
  expect(stderr).toContain('corrallm’s core keeps stopping');
});
