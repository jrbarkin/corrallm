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
    const connection = start.getByRole('combobox', { name: 'Claude Code connection' });
    await expect(connection).toHaveValue('claude-code.terminal');
    await expect(start.getByRole('button', { name: 'Start Codex', exact: true })).toBeDisabled();
    await start.getByRole('button', { name: 'Start Claude Code', exact: true }).click();
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
      'Agent 1, Claude · Terminal',
    );
    await expect(page.getByRole('button', { name: 'Project folder: project' })).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
