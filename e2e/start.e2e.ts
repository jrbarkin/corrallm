import { adapterName, agentCardName } from './catalog';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { canvasAction } from './canvas-actions';
import { launchApp } from './launch';

test('Start opens over the canvas, starts an installed agent, reopens from the dock and shows a recent canvas', async () => {
  test.skip(process.platform === 'win32', 'The fake claude is a Node script run through sh.');
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-start-'));
  const folder = path.join(dir, 'project');
  const config = path.join(dir, 'claude-config');
  await Promise.all([mkdir(folder), mkdir(config)]);
  const claude = path.join(dir, 'claude');
  const fake = path.join(import.meta.dirname, 'fake-claude.mjs');
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(claude, 0o755);
  const { app, close } = await launchApp({
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': claude }),
      CLAUDE_CONFIG_DIR: config,
    },
  });
  try {
    const page = await app.firstWindow();
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
      if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
    });
    const start = page.getByRole('dialog', { name: 'Start a session', exact: true });
    await expect(start).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    const window = await start.boundingBox();
    const canvas = await page.locator('.graph-editor').boundingBox();
    if (!window || !canvas) throw new Error('The Start window or canvas is missing.');
    expect(window.width).toBeLessThan(canvas.width);
    expect(window.height).toBeLessThan(canvas.height);

    const saved = path.join(dir, 'first.corral');
    await app.evaluate(
      ({ dialog }, { folder, saved }) => {
        Object.assign(dialog, {
          showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [folder] }),
          showSaveDialog: () => Promise.resolve({ canceled: false, filePath: saved }),
        });
      },
      { folder, saved },
    );
    await start.getByRole('button', { name: 'Choose a project folder' }).click();
    await expect(start.getByRole('button', { name: 'Project folder: project' })).toBeVisible();
    const connection = start.getByRole('combobox', {
      name: `${adapterName('claude-code')} connection`,
    });
    await expect(connection).toHaveValue('claude-code.terminal');
    await expect(
      start.getByRole('button', { name: `Start ${adapterName('codex')}`, exact: true }),
    ).toBeDisabled();
    await start
      .getByRole('button', { name: `Start ${adapterName('claude-code')}`, exact: true })
      .click();
    await expect(start).toHaveCount(0);
    const agent = page.getByRole('dialog', { name: 'Agent 1', exact: true });
    await expect(agent).toBeVisible();
    await expect(agent.locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
    await expect(page.locator('.react-flow__node-agent')).toHaveCount(1);
    await agent.getByRole('button', { name: 'Back to the canvas' }).click();
    await expect(agent).toHaveCount(0);
    await canvasAction(page, 'Save as…');
    await expect(page.locator('.graph-file-name')).toHaveText('first.corral');

    await page.getByRole('button', { name: 'Start a session', exact: true }).click();
    await expect(start).toBeVisible();
    // Unlike the bare-canvas test helper, leave New's Start window open.
    await page.getByRole('button', { name: 'Canvas menu', exact: true }).click();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await expect(start).toBeVisible();
    await expect(start.getByRole('button', { name: 'Choose a project folder' })).toBeVisible();
    await start.getByRole('button', { name: 'Show first.corral', exact: true }).click();
    await expect(start).toHaveCount(0);
    await expect(page.locator('.graph-file-name')).toHaveText('first.corral');
    await expect(page.locator('.react-flow__node-agent')).toHaveAttribute(
      'aria-label',
      agentCardName('Agent 1', 'claude-code.terminal'),
    );
    await expect(page.getByRole('button', { name: 'Project folder: project' })).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a default chosen in Add is kept across restart, used only for new agents, and cleared in Start', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-default-agent-'));
  const options = { profile, env: { CORRALLM_FAKE_SESSIONS: '1' } };
  let running = await launchApp(options);
  let closed = false;
  try {
    let page = await running.app.firstWindow();
    const initialStart = page.getByRole('dialog', { name: 'Start a session', exact: true });
    await expect(initialStart.getByText('No default agent: corrallm asks each time')).toBeVisible();
    await initialStart.getByRole('button', { name: 'Close Start a session', exact: true }).click();
    await page.locator('.react-flow__pane').dblclick({ position: { x: 300, y: 240 } });
    const chooser = page.getByRole('dialog', { name: 'Choose an agent', exact: true });
    await chooser.getByRole('button', { name: 'Choose…', exact: true }).click();
    await chooser.getByRole('option', { name: adapterName('codex'), exact: true }).click();
    await expect(chooser.getByText(`Default agent: ${adapterName('codex')}`)).toBeVisible();
    await expect(chooser.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await expect(page.locator('.react-flow__node-agent')).toHaveCount(0);
    await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Start a session', exact: true }).click();
    const shownStart = page.getByRole('dialog', { name: 'Start a session', exact: true });
    await expect(shownStart.getByText(`Default agent: ${adapterName('codex')}`)).toBeVisible();
    for (const adapter of ['claude-code', 'codex'])
      await expect(
        shownStart.getByRole('button', { name: `Start ${adapterName(adapter)}`, exact: true }),
      ).toBeVisible();
    await running.close();
    closed = true;
    running = await launchApp(options);
    closed = false;
    page = await running.app.firstWindow();
    const start = page.getByRole('dialog', { name: 'Start a session', exact: true });
    await expect(start.getByText(`Default agent: ${adapterName('codex')}`)).toBeVisible();
    await start.getByRole('button', { name: 'Close Start a session', exact: true }).click();
    await page.locator('.react-flow__pane').dblclick({ position: { x: 300, y: 240 } });
    const agent = page.locator('.react-flow__node-agent');
    await expect(agent).toHaveCount(1);
    await expect(agent).toHaveAttribute('aria-label', agentCardName('Agent 1', 'codex.terminal'));
    await expect(page.getByRole('dialog', { name: 'Choose an agent', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start a session', exact: true }).click();
    await start.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(start.getByText('No default agent: corrallm asks each time')).toBeVisible();
    await expect(agent).toHaveAttribute('aria-label', agentCardName('Agent 1', 'codex.terminal'));
    await expect(agent).toHaveCount(1);
    await start.getByRole('button', { name: 'Close Start a session', exact: true }).click();
    await page.locator('.react-flow__pane').dblclick({ position: { x: 600, y: 400 } });
    const asked = page.getByRole('dialog', { name: 'Choose an agent', exact: true });
    await expect(asked).toBeVisible();
    await asked.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(agent).toHaveCount(1);
  } finally {
    if (!closed) await running.close();
    await rm(profile, { recursive: true, force: true });
  }
});
