import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { readOnDisk } from '../../src/main/core/store/test-store';
import { git, gitEnvironment, makeRepository } from '../../src/main/core/workspaces/test-git';
import { canvasAction, dismissStart, openNeeds } from '../canvas-actions';
import { launchApp } from '../launch';
import { addPointer, glide, record, screenshot, showPointer, toGif } from './capture';
import { API_COMMIT, API_UNCOMMITTED, demoCanvas, PROJECT_FILES } from './demo';

/*
 * The README's pictures (`pnpm media`): the real app, built as the e2e suite builds it, on a
 * throwaway profile, home and project, its agents the in-core fakes (CORRALLM_FAKE_SESSIONS)
 * playing script.json's turns (CORRALLM_FAKE_SCRIPT). No real CLI runs and nothing of this
 * computer's shows. It writes docs/images/; the recording's frames stay in a temporary folder.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const IMAGES = path.join(ROOT, 'docs', 'images');
/** Wide enough for All queues to show all four lanes. */
const WINDOW = { width: 1440, height: 900 };
/** Where the pointer rests, over empty canvas below the cards, and a way back there around them. */
const REST = { x: 1180, y: 760 };
const AROUND = { x: 420, y: 800 };

test('README screenshots and the canvas → agent → queues GIF', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-media-'));
  const scratch = path.join(dir, 'scratch');
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'acme-web');
  const canvasFile = path.join(dir, 'acme-web.corral');
  await Promise.all([mkdir(scratch), mkdir(profile), mkdir(IMAGES, { recursive: true })]);
  const env = gitEnvironment(path.join(dir, 'home'));
  makeRepository(project, env, PROJECT_FILES);
  await writeFile(canvasFile, demoCanvas(randomUUID()));

  const problems: string[] = [];
  const { app, close } = await launchApp({
    profile,
    args: ['--force-device-scale-factor=2'],
    env: {
      ...env,
      SHELL: '/bin/sh',
      CORRALLM_FAKE_SESSIONS: '1',
      CORRALLM_FAKE_SCRIPT: path.join(import.meta.dirname, 'script.json'),
    },
  });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => problems.push(error.message));
    await page.waitForLoadState('load');
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
    }, WINDOW);
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([WINDOW.width, WINDOW.height]);
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    await dismissStart(page);
    await app.evaluate(
      ({ dialog }, { project, canvasFile }) => {
        Object.assign(dialog, {
          showOpenDialog: (...args: unknown[]) => {
            const options = args.at(-1) as { properties?: string[] };
            const picked = options.properties?.includes('openDirectory') ? project : canvasFile;
            return Promise.resolve({ canceled: false, filePaths: [picked] });
          },
        });
      },
      { project, canvasFile },
    );

    // The demo canvas, in its project folder, framed a little closer than Fit's 100% at most.
    await canvasAction(page, 'Open…');
    await expect(page.locator('.react-flow__node-agent')).toHaveCount(4);
    await page.getByRole('button', { name: 'Choose a project folder' }).click();
    await expect(page.getByRole('button', { name: 'Project folder: acme-web' })).toBeVisible();
    await page.getByRole('button', { name: 'Fit view' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await addPointer(page);

    // Each agent's worktree, its setup skipped (the demo project installs nothing).
    const canvas = await page.evaluate(async () => {
      const shown = await window.api.windowGet({});
      if (!shown.ok) throw new Error(shown.error.sentence);
      return shown.value.canvas;
    });
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    for (const agent of ['lead', 'ui', 'tests', 'api']) {
      await expect(async () => {
        const opened = await page.evaluate(
          ({ canvas, agent }) => window.api.sessionOpen({ canvas, agent }),
          { canvas, agent },
        );
        if (opened.ok) return;
        await openNeeds(page);
        const skip = needs.getByRole('button', { name: 'Skip', exact: true });
        if ((await skip.count()) > 0) await skip.first().click();
        throw new Error(opened.error.sentence);
      }).toPass({ timeout: 30_000 });
    }
    const bell = page.getByRole('button', { name: 'Needs you', exact: true });
    if ((await bell.getAttribute('aria-expanded')) === 'true') await bell.click();
    await expect(needs).toBeHidden();
    // Where a merge would go is read in the background: wait for it, so the agents' Merge buttons
    // name the branch from the start.
    await expect
      .poll(
        () =>
          page.evaluate(async (canvas) => {
            const listed = await window.api.worktreeList({ canvas });
            return listed.ok ? (listed.value.into?.ref ?? null) : null;
          }, canvas),
        { timeout: 30_000 },
      )
      .toMatch(/main$/);
    await page.mouse.move(REST.x, REST.y);
    await settle(page);

    const runControls = page.getByRole('toolbar', { name: 'Run controls' });
    await runControls.getByRole('button', { name: 'Run', exact: true }).click();

    const card = (name: string) =>
      page.locator('.react-flow__node-agent').filter({
        has: page.locator('.graph-label', { hasText: new RegExp(`^${name}$`) }),
      });
    /** Waits until `name`'s card says it is on `task`, looking every tenth of a second. */
    const doing = (name: string, task: RegExp) =>
      expect
        .poll(() => card(name).locator('.graph-card-status').getAttribute('title'), {
          intervals: [100],
          timeout: 60_000,
        })
        .toMatch(task);
    /** Each screenshot, to be written once the app is done with. */
    const shots = new Map<string, () => number>();
    const shoot = async (name: string) => {
      await page.mouse.move(REST.x, REST.y);
      shots.set(name, await screenshot(page, path.join(IMAGES, name), scratch));
    };

    // Everyone at work: the canvas, then the GIF from there, both from the moment Cart UI's turn
    // starts, so the GIF reaches the same point in it each time.
    await doing('Cart UI', /Build the cart drawer/);
    await expect
      .poll(() => runControls.textContent(), { intervals: [100], timeout: 10_000 })
      .toContain('4 working');
    const recording = await record(page, scratch);
    const since = Date.now();
    await shoot('canvas.png');
    await showPointer(page, true);
    recording.begin();
    await page.waitForTimeout(Math.max(0, 1300 - (Date.now() - since)));
    // The pointer glides to each control, then Playwright presses it where it is by then.
    let at = REST;
    // A press that can't happen at once fails the take rather than stretching the GIF.
    const press = async (target: Locator, ms: number, twice = false) => {
      const to = await centre(target);
      await glide(page, at, to, ms);
      if (twice) await target.dblclick({ timeout: 8000 });
      else await target.click({ timeout: 8000 });
      at = to;
    };
    await press(card('Cart UI'), 600, true);
    const view = page.getByRole('dialog', { name: 'Cart UI', exact: true });
    await expect(view).toBeVisible();
    // Its tools, then its reply streaming in.
    await expect(view.getByText(/Each line has a quantity/)).toBeVisible({ timeout: 20_000 });
    await press(view.getByRole('button', { name: 'All queues' }), 500);
    const queues = page.getByRole('dialog', { name: 'All queues' });
    await expect(queues).toBeVisible();
    await page.waitForTimeout(1900);
    await press(queues.getByRole('button', { name: 'Back', exact: true }), 450);
    await press(view.getByRole('button', { name: 'Back to the canvas' }), 250);
    await expect(view).toBeHidden();
    await page.waitForTimeout(400);
    await glide(page, at, AROUND, 450);
    await glide(page, AROUND, REST, 450);
    await page.waitForTimeout(500);
    const recorded = await recording.stop();
    await showPointer(page, false);

    // An agent's window, its second turn streaming below its first.
    await card('Cart UI').dblclick();
    await expect(view).toBeVisible();
    await page.waitForTimeout(800);
    await expect(view.getByText(/if the server refuses them/)).toBeVisible({ timeout: 30_000 });
    await shoot('agent.png');

    // Every queue side by side, from that window.
    await view.getByRole('button', { name: 'All queues' }).click();
    await expect(queues).toBeVisible();
    await page.waitForTimeout(600);
    await shoot('queues.png');
    await queues.getByRole('button', { name: 'Back', exact: true }).click();
    await view.getByRole('button', { name: 'Back to the canvas' }).click();
    await expect(view).toBeHidden();

    // The API agent's branch, reviewed: a commit of its work, and work not yet committed (fixture
    // writes at its recorded checkout, as the agent's own edits would be).
    await doing('API', /^Done$/);
    const checkout = readOnDisk(profile, (db) =>
      db
        .prepare(
          'SELECT w.path FROM agent_worktree a JOIN worktree w ON w.id = a.workspace_id WHERE a.canvas_id = ? AND a.agent_id = ?',
        )
        .all(canvas, 'api'),
    ).map((row) => String(row.path))[0];
    if (checkout === undefined) throw new Error('The API agent has no worktree.');
    await writeFiles(checkout, API_COMMIT);
    git(checkout, env, 'add', '-A');
    git(
      checkout,
      env,
      '-c',
      'user.name=acme-dev',
      '-c',
      'user.email=dev@acme.example',
      'commit',
      '-qm',
      'Add GET /api/cart',
    );
    await writeFiles(checkout, API_UNCOMMITTED);
    await card('API').dblclick();
    const api = page.getByRole('dialog', { name: 'API', exact: true });
    await expect(api).toBeVisible();
    await page.waitForTimeout(800);
    await api.getByRole('button', { name: 'Review changes' }).click();
    const review = page.getByRole('dialog', { name: 'API’s changes' });
    await expect(
      review.getByRole('region', { name: 'Committed changes', exact: true }),
    ).toBeVisible();
    await expect(review.getByRole('region', { name: 'Uncommitted changes' })).toBeVisible();
    await page.waitForTimeout(600);
    await shoot('review.png');

    expect(problems).toEqual([]);
    const sizes = new Map([...shots].map(([name, write]) => [name, write()]));
    const gif = toGif(recorded, path.join(IMAGES, 'flow.gif'), scratch);
    sizes.set('flow.gif', gif.bytes);
    for (const [name, bytes] of sizes)
      console.log(`docs/images/${name}: ${String(Math.round(bytes / 1024))} KB`);
    console.log(`flow.gif lasts ${gif.seconds.toFixed(1)} s`);
    // GitHub shows a README's GIF up to 10 MB; keep well under, and short.
    expect(gif.bytes).toBeLessThan(8 * 1024 * 1024);
    expect(gif.seconds).toBeLessThan(16);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Waits until the page has answered at once for three seconds running (every frame within 50 ms
 * of asking), for at most three minutes: just after a build, macOS checking the new app can slow
 * everything in bursts, and the take is timed.
 */
async function settle(page: Page): Promise<void> {
  const until = Date.now() + 180_000;
  let since = Date.now();
  while (Date.now() - since < 3000 && Date.now() < until) {
    const asked = Date.now();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    if (Date.now() - asked >= 50) {
      await page.waitForTimeout(1000);
      since = Date.now();
    }
  }
}

/** Where to point at `target`: its middle, in the window's coordinates. */
async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox({ timeout: 8000 });
  if (box === null) throw new Error('Nothing to point at.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
}
