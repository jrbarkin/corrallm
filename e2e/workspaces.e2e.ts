import { appendFile, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { gitEnvironment, makeRepository } from '../src/main/core/workspaces/test-git';
import { canvasAction, dismissStart, openNeeds } from './canvas-actions';
import { launchApp } from './launch';

// All CLIs and setup commands here are fixture programs. Real app, Git, provisioning, topics,
// trusted folder choice and reply routing; no model executes a prompt or supplies a directory.
test.beforeEach(() => {
  test.skip(process.platform === 'win32', 'Worktree setup and the fake CLI use /bin/sh.');
});

async function openWorkspaceApp(
  command: string | null = "printf 'setup  complete\\n'",
  git = true,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-workspace-ui-'));
  const project = path.join(dir, 'project');
  const config = path.join(dir, 'claude-config');
  const env = gitEnvironment(path.join(dir, 'home'));
  if (git) {
    makeRepository(project, env);
    // The fake CLI logs its own exit into the tree it ran in (`.fake-claude/`). Like any agent's
    // bookkeeping that a repository ignores, that is not work: were it listed, ending the session
    // would change the tree after you answered, and the core rightly keeps a tree that changed
    // since the question rather than discard what it did not show you.
    await appendFile(path.join(project, '.git', 'info', 'exclude'), '.fake-claude/\n');
  } else {
    await mkdir(project);
  }
  await mkdir(config);
  const cli = path.join(dir, 'claude');
  await writeFile(
    cli,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fake-claude.mjs')}" "$@"\n`,
  );
  await chmod(cli, 0o755);
  // The login shell the core reads the agents' environment from (`-ilc`): Debian's /bin/sh (dash)
  // refuses `-l`, so Git was not found there. Runs the command in /bin/sh without the login flag.
  const shell = path.join(dir, 'login-shell');
  await writeFile(
    shell,
    '#!/bin/sh\nif [ "$1" = "-ilc" ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/sh "$@"\n',
  );
  await chmod(shell, 0o755);
  const { app, close } = await launchApp({
    env: {
      ...env,
      SHELL: shell,
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': cli }),
      CLAUDE_CONFIG_DIR: config,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await app.evaluate(({ dialog }, project) => {
      Object.assign(dialog, {
        showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [project] }),
      });
    }, project);
    const start = page.getByRole('dialog', { name: 'Start a session', exact: true });
    await expect(start).toBeVisible();
    await expect(
      start.getByText('Agents get their own worktrees; groups share one.'),
    ).toBeVisible();
    await start.getByRole('button', { name: 'Choose a project folder', exact: true }).click();
    await expect(
      start.getByRole('button', { name: 'Project folder: project', exact: true }),
    ).toBeVisible();
    const canvas = await page.evaluate(async () => {
      const result = await window.api.windowGet({});
      if (!result.ok) throw new Error(result.error.sentence);
      return result.value.canvas;
    });
    if (command !== null)
      await page.evaluate(
        async ({ canvas, command }) => {
          const result = await window.api.projectSetSetupCommand({ canvas, command });
          if (!result.ok) throw new Error(result.error.sentence);
        },
        { canvas, command },
      );
    return {
      app,
      page,
      canvas,
      project,
      dir,
      start,
      async list() {
        // Test-fixture inspection only. The product's presentation reads the pushed topic.
        return page.evaluate(async (canvas) => {
          const result = await window.api.worktreeList({ canvas });
          if (!result.ok) throw new Error(result.error.sentence);
          return result.value;
        }, canvas);
      },
      async startAgent(name = 'Agent 1') {
        if (!(await start.isVisible()))
          await page.getByRole('button', { name: 'Start a session', exact: true }).click();
        await start.getByRole('button', { name: 'Start Claude Code', exact: true }).click();
        const panel = page.getByRole('dialog', { name, exact: true });
        await expect(panel).toBeVisible();
        return panel;
      },
      async dispose() {
        await close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test('setup is visible on the fixed card, header and dock; Run finishes without a modal', async () => {
  const world = await openWorkspaceApp();
  const { page } = world;
  try {
    const panel = await world.startAgent();
    await expect(panel.getByText('Starting Claude Code…', { exact: true })).toHaveCount(0);
    await expect(
      panel.getByText('Waiting for worktree setup', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator('.dock-agent[data-needs]')).toHaveCount(1);
    await panel.getByRole('button', { name: 'Back to the canvas', exact: true }).click();
    const card = page.locator('.graph-card');
    await expect(card.locator('.workspace-badge')).toHaveAttribute('data-workspace-attention', '');
    const size = await card.evaluate((element) => ({
      width: element instanceof HTMLElement ? element.offsetWidth : 0,
      height: element instanceof HTMLElement ? element.offsetHeight : 0,
    }));
    expect(size).toEqual({ width: 186, height: 73 });
    await card.getByRole('button', { name: 'Review setup', exact: true }).click();
    const decision = page.getByRole('article', { name: /Set up .*worktree/ });
    await expect(decision).toBeFocused();
    await expect(decision.locator('.graph-question-detail')).toContainText(
      "printf 'setup  complete\\n'",
    );
    await decision.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Worktree setup finished.', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(card.locator('.workspace-badge')).not.toHaveAttribute('data-workspace-attention');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByText('Worktree setup finished.', { exact: true })).toHaveCount(0, {
      timeout: 10000,
    });
  } finally {
    await world.dispose();
  }
});

test('failed setup shows literal output; settings reoffer a changed command and clear Always', async () => {
  const world = await openWorkspaceApp("printf '<b>failed  setup</b>\\n'; exit 1");
  const { page } = world;
  try {
    const panel = await world.startAgent();
    await panel
      .locator('header')
      .getByRole('button', { name: 'Review setup', exact: true })
      .click();
    await page.getByRole('article').getByRole('button', { name: 'Run', exact: true }).click();
    const failed = page.getByRole('article', { name: /Setup failed/ });
    await expect(failed).toBeVisible({ timeout: 15000 });
    await expect(failed.locator('.graph-question-detail')).toContainText('<b>failed  setup</b>');
    await expect(failed.locator('b')).toHaveCount(0);
    await expect(failed.getByRole('button', { name: 'Run again', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Needs you', exact: true }).click();
    await panel.getByRole('button', { name: 'Agent settings: Agent 1', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Agent settings: Agent 1', exact: true });
    await expect(settings.getByRole('region', { name: 'Works in' })).toContainText('Own worktree');
    await settings.getByText('Repository setup', { exact: true }).click();
    await settings
      .getByRole('textbox', { name: 'Setup command', exact: true })
      .fill("printf 'fixed\\n'");
    await settings.getByRole('button', { name: 'Save setup command', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('Setup command saved');
    await settings.getByRole('button', { name: 'Ask before future setups', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('Future setups will ask again');
    await settings.getByRole('button', { name: 'Review setup', exact: true }).click();
    const offered = page.getByRole('article', { name: /Set up .*worktree/ });
    await expect(offered.locator('.graph-question-detail')).toContainText("printf 'fixed\\n'");
    await offered.getByRole('button', { name: 'Always for this repository', exact: true }).click();
    await expect(page.getByText('Worktree setup finished.', { exact: true })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await world.dispose();
  }
});

test('Switch keeps the old tree and Remove on a closed canvas uses its core confirmation', async () => {
  const world = await openWorkspaceApp();
  const { page, canvas } = world;
  try {
    // A lone agent gathered into a new frame keeps its tree (only its owner changes), so a
    // workspace change needs two agents that each work in a tree of their own.
    for (const name of ['Agent 1', 'Agent 2']) {
      const panel = await world.startAgent(name);
      await panel
        .locator('header')
        .getByRole('button', { name: 'Review setup', exact: true })
        .click();
      await page.getByRole('article').getByRole('button', { name: 'Skip', exact: true }).click();
      await page.getByRole('button', { name: 'Needs you', exact: true }).click();
      await panel.getByRole('button', { name: 'Back to the canvas', exact: true }).click();
    }
    const trees = (await world.list()).items;
    expect(trees).toHaveLength(2);
    for (const tree of trees) {
      if (!tree.location) throw new Error('No allocated checkout');
      await writeFile(path.join(tree.location, 'KEEP-MY-WORK.txt'), 'uncommitted work\n');
    }
    // Fixture structural edit: the UI below exercises the resulting Switch and retention.
    await page.evaluate(
      async ({ canvas, agents }) => {
        const result = await window.api.canvasGroup({ canvas, nodes: agents, kind: 'frame' });
        if (!result.ok) throw new Error(result.error.sentence);
      },
      { canvas, agents: trees.map((tree) => tree.agent) },
    );
    // The first member's tree is the group's; the other's move waits for your Switch.
    await expect
      .poll(async () => (await world.list()).items.filter((i) => i.state === 'pending-change'))
      .toHaveLength(1);
    const old = (await world.list()).items.find((item) => item.state === 'pending-change');
    if (!old?.branch) throw new Error('No pending change');
    await page
      .locator('.graph-card')
      .getByRole('button', { name: 'Review workspace change', exact: true })
      .click();
    const change = page.getByRole('article', { name: /Move .*worktree/ });
    await expect(change).toContainText('worktrees they leave are kept');
    await change
      .getByRole('button', { name: 'Switch, keeping the previous worktrees', exact: true })
      .click();
    // Switch moves it into the group's existing tree, whose setup was already answered; Switch
    // runs nothing and offers nothing more.
    await expect
      .poll(async () => (await world.list()).items.filter((i) => i.state === 'pending-change'))
      .toHaveLength(0);
    const after = (await world.list()).items;
    expect(new Set(after.map((item) => item.workspace)).size).toBe(1);
    expect(after.map((item) => [item.setup?.state, item.need])).toEqual([
      ['skipped', undefined],
      ['skipped', undefined],
    ]);
    await canvasAction(page, 'New');
    await page.evaluate(async (canvas) => {
      const result = await window.api.canvasClose({ canvas });
      if (!result.ok) throw new Error(result.error.sentence);
    }, canvas);
    await canvasAction(page, 'Canvases');
    const kept = page.getByRole('region', { name: 'Kept worktrees of Untitled', exact: true });
    await expect(kept).toContainText(old.branch);
    await kept.getByRole('button', { name: /Remove .* worktree/ }).click();
    const confirm = kept.getByRole('article', { name: /Remove .*It holds work/ });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(kept).toContainText(old.branch);
    await kept.getByRole('button', { name: /Remove .* worktree/ }).click();
    await kept
      .getByRole('article')
      .getByRole('button', { name: 'Remove it and its branch', exact: true })
      .click();
    await expect(kept).toHaveCount(0, { timeout: 15000 });
  } finally {
    await world.dispose();
  }
});

test('a missing checkout has a Retry gesture and restores its pushed ready state', async () => {
  const world = await openWorkspaceApp();
  const { page, canvas } = world;
  try {
    const panel = await world.startAgent();
    await panel
      .locator('header')
      .getByRole('button', { name: 'Review setup', exact: true })
      .click();
    await page.getByRole('article').getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByRole('button', { name: 'Needs you', exact: true }).click();
    const tree = (await world.list()).items[0];
    if (!tree?.location) throw new Error('No checkout');
    const moved = `${tree.location}-fixture-moved`;
    await rename(tree.location, moved);
    try {
      await page.evaluate(
        async ({ canvas, agent }) => window.api.projectFiles({ canvas, agent, query: '' }),
        { canvas, agent: tree.agent },
      );
      await expect(panel.getByText('Worktree missing', { exact: true }).first()).toBeVisible();
    } finally {
      await rename(moved, tree.location);
    }
    await panel
      .locator('.workspace-wait')
      .first()
      .getByRole('button', { name: 'Retry worktree', exact: true })
      .click();
    await expect(panel.getByText('Worktree ready', { exact: true })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await world.dispose();
  }
});

test('a non-Git project is shown as a shared folder, without a branch or setup command editor', async () => {
  const world = await openWorkspaceApp(null, false);
  const { page } = world;
  try {
    const panel = await world.startAgent();
    await panel.getByRole('button', { name: 'Agent settings: Agent 1', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Agent settings: Agent 1', exact: true });
    const details = settings.getByRole('region', { name: 'Works in' });
    await expect(details.getByText('Shared project folder', { exact: true }).first()).toBeVisible();
    await expect(details).toContainText(world.project);
    await expect(details.getByRole('textbox')).toHaveCount(0);
    await expect(details.getByText('Repository setup', { exact: true })).toHaveCount(0);
  } finally {
    await world.dispose();
  }
});

test('a shared group has one setup card, two workspace marks and two dock glows', async () => {
  const world = await openWorkspaceApp();
  const { page, canvas } = world;
  try {
    await dismissStart(page);
    await page.evaluate(async (canvas) => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const result = await window.api.canvasAddAgent({
          canvas,
          adapter: 'claude-code',
          connection: 'claude-code.sdk',
          at: { x: i * 250, y: 0 },
        });
        if (!result.ok) throw new Error(result.error.sentence);
        ids.push(result.value.id);
      }
      const grouped = await window.api.canvasGroup({ canvas, nodes: ids, kind: 'frame' });
      if (!grouped.ok) throw new Error(grouped.error.sentence);
      for (const id of ids) await window.api.sessionOpen({ agent: id });
    }, canvas);
    await expect(
      page.locator('.graph-card .workspace-badge[data-workspace-attention]'),
    ).toHaveCount(2);
    await expect(page.locator('.dock-agent[data-needs]')).toHaveCount(2);
    const marks = page.locator('.graph-card .workspace-badge');
    await expect(marks.first()).toHaveAttribute('title', /Shares Group 1’s worktree/);
    // Both marks share one worktree: once its setup card is offered each holds its Review setup
    // button, and they read alike (until then both are still preparing, never failed).
    await expect(marks.getByRole('button', { name: 'Review setup', exact: true })).toHaveCount(2);
    await expect.poll(async () => marks.first().innerText()).toBe(await marks.last().innerText());
    await marks.first().getByRole('button', { name: 'Review setup', exact: true }).click();
    await expect(page.getByRole('article', { name: /Set up .*worktree/ })).toHaveCount(1);
    await page.getByRole('article').getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.locator('.dock-agent[data-needs]')).toHaveCount(0);
  } finally {
    await world.dispose();
  }
});

for (const discard of [false, true]) {
  test(`deleting the last agent offers the core’s ${discard ? 'Discard' : 'Keep'} choice for its work`, async () => {
    const world = await openWorkspaceApp();
    const { page } = world;
    try {
      const panel = await world.startAgent();
      await panel
        .locator('header')
        .getByRole('button', { name: 'Review setup', exact: true })
        .click();
      await page.getByRole('article').getByRole('button', { name: 'Skip', exact: true }).click();
      await page.getByRole('button', { name: 'Needs you', exact: true }).click();
      await panel.getByRole('button', { name: 'Back to the canvas', exact: true }).click();
      const tree = (await world.list()).items[0];
      if (!tree?.location || !tree.branch) throw new Error('No allocated worktree');
      await writeFile(path.join(tree.location, 'MY-WORK.txt'), 'keep or explicitly discard this\n');
      await page.locator('.react-flow__node-agent').click();
      await page.keyboard.press('Delete');
      await openNeeds(page);
      const keep = 'Delete, keep its work';
      const remove = 'Delete, and discard its worktree and branch';
      const decision = page
        .getByRole('article')
        .filter({ has: page.getByRole('button', { name: keep, exact: true }) });
      await expect(decision.getByRole('button', { name: remove, exact: true })).toBeVisible();
      await decision.getByRole('button', { name: discard ? remove : keep, exact: true }).click();
      await expect(page.locator('.react-flow__node-agent')).toHaveCount(0);
      await dismissStart(page);
      await canvasAction(page, 'Canvases');
      const kept = page.getByRole('region', { name: 'Kept worktrees of Untitled', exact: true });
      if (discard) await expect(kept).toHaveCount(0, { timeout: 15000 });
      else await expect(kept).toContainText(tree.branch);
    } finally {
      await world.dispose();
    }
  });
}
