import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { commit, git, gitEnvironment, makeRepository } from '../src/main/core/workspaces/test-git';
import { dismissStart, openNeeds } from './canvas-actions';
import { launchApp } from './launch';
import { closeLastWindow, reopenWindow } from './last-window';

// Review changes and Merge into the picked checkout (B9b X4): the real window, real Git in
// throwaway folders, a fake CLI that never runs. Assertions are what the person reads and what
// lands in Git.
test.skip(process.platform === 'win32', 'These fake executables use POSIX.');

async function world({ gated = false }: { gated?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'corrallm-branches-e2e-'));
  const env = gitEnvironment(path.join(root, 'home'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'profile');
  const bin = path.join(root, 'bin');
  await mkdir(profile);
  await mkdir(bin);
  makeRepository(project, env, {
    'README.md': 'base\n',
    'shared.txt': 'shared\n',
    '.gitignore': 'ignored.log\n',
    '.gitattributes': '*.dat filter=evil\n',
  });
  git(project, env, 'config', 'user.name', 'You Person');
  git(project, env, 'config', 'user.email', 'you@example.invalid');
  const cli = path.join(bin, 'claude');
  const config = path.join(root, 'claude-config');
  await mkdir(config);
  await writeFile(
    cli,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fake-claude.mjs')}" "$@"\n`,
  );
  await chmod(cli, 0o755);
  const shell = path.join(bin, 'login-shell');
  await writeFile(
    shell,
    '#!/bin/sh\nif [ "$1" = "-ilc" ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/sh "$@"\n',
  );
  await chmod(shell, 0o755);
  // A git that stops the install of a fast-forward while the gate file exists, so a test can
  // close the window in the middle of a merge. Every other call goes straight to the real Git.
  const gate = path.join(root, 'gate');
  const reached = path.join(root, 'reached');
  if (gated) {
    const real = (env.PATH ?? '')
      .split(path.delimiter)
      .filter((folder) => path.isAbsolute(folder))
      .map((folder) => path.join(folder, 'git'))
      .find((file) => existsSync(file));
    if (!real) throw new Error('Git is required');
    await writeFile(
      path.join(bin, 'git'),
      `#!/bin/sh
case " $* " in
  *" merge "*"--ff-only"*)
    if [ -e '${gate}' ]; then
      echo reached > '${reached}'
      while [ -e '${gate}' ]; do sleep 0.1; done
    fi;;
esac
exec '${real}' "$@"
`,
    );
    await chmod(path.join(bin, 'git'), 0o755);
  }
  const launchEnv = {
    ...env,
    PATH: `${bin}${path.delimiter}${env.PATH ?? ''}`,
    SHELL: shell,
    CLAUDE_CONFIG_DIR: config,
    CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': cli }),
  };
  const running = await launchApp({
    profile,
    env: launchEnv,
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
  });
  let page = await running.app.firstWindow();
  let successor: Page | undefined;
  try {
    await page.waitForLoadState('load');
    await dismissStart(page);
    await running.app.evaluate(({ dialog }, project) => {
      Object.assign(dialog, {
        showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [project] }),
      });
    }, project);
    await page.getByRole('button', { name: 'Choose a project folder', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Project folder: project', exact: true }),
    ).toBeVisible();
    const canvas = await page.evaluate(async () => {
      const result = await window.api.windowGet({});
      if (!result.ok) throw new Error(result.error.sentence);
      return result.value.canvas;
    });
    const list = () =>
      page.evaluate(async (canvas) => {
        const result = await window.api.worktreeList({ canvas });
        if (!result.ok) throw new Error(result.error.sentence);
        return result.value;
      }, canvas);
    const agent = () =>
      page.evaluate(async (canvas) => {
        const result = await window.api.canvasAddAgent({
          canvas,
          adapter: 'claude-code',
          connection: 'claude-code.terminal',
          at: { x: 300, y: 250 },
        });
        if (!result.ok) throw new Error(result.error.sentence);
        return result.value.id;
      }, canvas);
    const allocate = async (id: string) => {
      const opened = await page.evaluate((agent) => window.api.sessionOpen({ agent }), id);
      if (!opened.ok) {
        await openNeeds(page);
        await page.getByRole('article').getByRole('button', { name: 'Skip', exact: true }).click();
        await page.getByRole('button', { name: 'Needs you', exact: true }).click();
      }
      await expect
        .poll(async () => (await list()).items.find((item) => item.agent === id)?.state)
        .toBe('ready');
      const item = (await list()).items.find((candidate) => candidate.agent === id);
      if (!item?.location || !item.branch) throw new Error('No checkout');
      return { id, location: item.location, branch: item.branch };
    };
    async function commitIn(at: string, files: Record<string, string>, message: string) {
      for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(at, file)), { recursive: true });
        await writeFile(path.join(at, file), text);
      }
      git(at, env, 'add', '-A');
      commit(at, env, message);
    }
    return {
      root,
      project,
      env,
      gate,
      reached,
      canvas,
      page: () => page,
      app: () => running.app,
      agent,
      allocate,
      commitIn,
      async worktrees() {
        return (await list()).items;
      },
      /** An agent with a checkout, `files` committed there. */
      async worker(files: Record<string, string>, message = 'Work') {
        const made = await allocate(await agent());
        await commitIn(made.location, files, message);
        return made;
      },
      head: (ref = 'HEAD') => git(project, env, 'rev-parse', ref).trim(),
      /** Opens Review changes or Merge from the agent's card. */
      async open(id: string, merge: boolean) {
        const node = page.locator(`.react-flow__node-agent[data-id="${id}"]`);
        await node.hover();
        await page
          .getByRole('button', { name: merge ? /^Merge into .*…$/ : 'Review changes' })
          .first()
          .click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('Reading changes…')).toHaveCount(0);
        return dialog;
      },
      async close() {
        await running.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      },
      async closeWindow() {
        successor = await closeLastWindow(running.app, page);
      },
      async reopen() {
        page = await reopenWindow(running.app, page, successor);
        successor = undefined;
        await page.waitForLoadState('load');
        await dismissStart(page);
      },
    };
  } catch (error) {
    await running.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const confirm = (dialog: Locator) => dialog.getByRole('button', { name: /^Merge into [^…]*$/ });

test('Review changes lists what the agent committed and changes nothing', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'done.txt': 'done\n', 'README.md': 'edited\n' });
    const before = w.head();
    const dialog = await w.open(worker.id, false);
    const committed = dialog.getByRole('region', { name: 'Committed changes', exact: true });
    await expect(committed).toContainText('2 files');
    await expect(committed).toContainText('done.txt');
    await expect(committed).toContainText('README.md');
    await expect(dialog.getByText('Merge destination:')).toContainText('main');
    expect(w.head()).toBe(before);
    expect(existsSync(path.join(w.project, 'done.txt'))).toBe(false);
  } finally {
    await w.close();
  }
});

test('Merge fast-forwards the commits onto your checkout and says so', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'done.txt': 'done\n' });
    const dialog = await w.open(worker.id, true);
    await confirm(dialog).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Merged into main.' })).toBeVisible();
    expect(await readFile(path.join(w.project, 'done.txt'), 'utf8')).toBe('done\n');
    expect(git(w.project, w.env, 'status', '--porcelain')).toBe('');
    expect(git(w.project, w.env, 'branch', '--show-current').trim()).toBe('main');
    expect(git(w.project, w.env, 'log', '-1', '--format=%B')).toContain('Corrallm-Requested-By:');
    // The agent's branch is kept.
    expect(git(w.project, w.env, 'rev-parse', '--verify', worker.branch).trim()).not.toBe('');
  } finally {
    await w.close();
  }
});

const alert = (dialog: Locator) => dialog.getByRole('alert');
const merged = (dialog: Locator) =>
  dialog.getByRole('status').filter({ hasText: 'Merged into main.' });

test('a group shares one tree: Review names the shared workspace, and one merge lands its work', async () => {
  const w = await world();
  try {
    const a = await w.agent(),
      b = await w.agent();
    await w.page().evaluate(
      async ({ canvas, nodes }) => {
        const result = await window.api.canvasGroup({ canvas, nodes, kind: 'frame' });
        if (!result.ok) throw new Error(result.error.sentence);
      },
      { canvas: w.canvas, nodes: [a, b] },
    );
    const first = await w.allocate(a);
    // The second member shares the first's tree; opening its session would start a CLI there.
    await expect
      .poll(async () => (await w.worktrees()).find((item) => item.agent === b)?.location)
      .toBe(first.location);
    await w.commitIn(first.location, { 'team.txt': 'team\n' }, 'Team work');
    const dialog = await w.open(b, true);
    await expect(dialog).toContainText(/Shares .*worktree/);
    await expect(
      dialog.getByRole('region', { name: 'Committed changes', exact: true }),
    ).toContainText('team.txt');
    await confirm(dialog).click();
    await expect(merged(dialog)).toBeVisible();
    expect(await readFile(path.join(w.project, 'team.txt'), 'utf8')).toBe('team\n');
  } finally {
    await w.close();
  }
});

test('a dirty checkout refuses the merge and keeps every one of your edits', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'done.txt': 'done\n' });
    await writeFile(path.join(w.project, 'shared.txt'), 'mine, unsaved to Git\n');
    const before = w.head();
    const dialog = await w.open(worker.id, true);
    await confirm(dialog).click();
    await expect(alert(dialog)).toBeVisible();
    await expect(alert(dialog)).toContainText('Your checkout has uncommitted changes');
    expect(w.head()).toBe(before);
    expect(await readFile(path.join(w.project, 'shared.txt'), 'utf8')).toBe(
      'mine, unsaved to Git\n',
    );
    expect(existsSync(path.join(w.project, 'done.txt'))).toBe(false);
  } finally {
    await w.close();
  }
});

test('uncommitted work in the agent’s tree needs a choice; leaving it merges only the commits', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'done.txt': 'done\n' });
    await writeFile(path.join(worker.location, 'wip.txt'), 'wip\n');
    const dialog = await w.open(worker.id, true);
    await expect(dialog.getByRole('region', { name: 'Uncommitted changes' })).toContainText(
      'wip.txt',
    );
    await expect(confirm(dialog)).toBeDisabled();
    await dialog.getByRole('radio', { name: 'Merge commits without uncommitted work' }).check();
    await confirm(dialog).click();
    await expect(merged(dialog)).toBeVisible();
    expect(await readFile(path.join(w.project, 'done.txt'), 'utf8')).toBe('done\n');
    expect(existsSync(path.join(w.project, 'wip.txt'))).toBe(false);
    // The work stays where the agent left it, uncommitted.
    expect(await readFile(path.join(worker.location, 'wip.txt'), 'utf8')).toBe('wip\n');
    expect(git(worker.location, w.env, 'status', '--porcelain')).toContain('wip.txt');
  } finally {
    await w.close();
  }
});

test('uncommitted work in the agent’s tree can be committed on its branch first, then merged', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'done.txt': 'done\n' });
    await writeFile(path.join(worker.location, 'wip.txt'), 'wip\n');
    await writeFile(path.join(worker.location, 'done.txt'), 'done, then edited\n');
    const dialog = await w.open(worker.id, true);
    await dialog
      .getByRole('radio', { name: 'Commit uncommitted work on its branch first' })
      .check();
    await confirm(dialog).click();
    await expect(merged(dialog)).toBeVisible();
    expect(await readFile(path.join(w.project, 'wip.txt'), 'utf8')).toBe('wip\n');
    expect(await readFile(path.join(w.project, 'done.txt'), 'utf8')).toBe('done, then edited\n');
    // The checkpoint is a commit on the agent's branch; its files are intact and clean.
    expect(git(w.project, w.env, 'show', `${worker.branch}:wip.txt`)).toBe('wip\n');
    expect(git(worker.location, w.env, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(worker.location, 'wip.txt'), 'utf8')).toBe('wip\n');
  } finally {
    await w.close();
  }
});

test('a conflict is held with a sentence, and your checkout stays exactly as it was', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'README.md': 'agent\n' });
    await w.commitIn(w.project, { 'README.md': 'mine\n' }, 'My change');
    const before = w.head();
    const dialog = await w.open(worker.id, true);
    await confirm(dialog).click();
    await expect(alert(dialog)).toBeVisible();
    await expect(alert(dialog)).toContainText('conflict');
    expect(w.head()).toBe(before);
    expect(await readFile(path.join(w.project, 'README.md'), 'utf8')).toBe('mine\n');
    expect(git(w.project, w.env, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(w.project, '.git', 'MERGE_HEAD'))).toBe(false);
  } finally {
    await w.close();
  }
});

test('an ignored file of yours that the merge would overwrite refuses it, and survives', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'x.txt': 'x\n' });
    await writeFile(path.join(worker.location, 'ignored.log'), 'agent log\n');
    git(worker.location, w.env, 'add', '-f', 'ignored.log');
    commit(worker.location, w.env, 'Force-add a log');
    await writeFile(path.join(w.project, 'ignored.log'), 'my precious log\n');
    const before = w.head();
    const dialog = await w.open(worker.id, true);
    await confirm(dialog).click();
    await expect(alert(dialog)).toBeVisible();
    await expect(alert(dialog)).toContainText('ignored.log');
    expect(w.head()).toBe(before);
    expect(await readFile(path.join(w.project, 'ignored.log'), 'utf8')).toBe('my precious log\n');
  } finally {
    await w.close();
  }
});

test('a path with a filter driver is refused, and the driver never runs', async () => {
  const w = await world();
  try {
    const worker = await w.worker({ 'data.dat': 'payload\n' });
    const sentinel = path.join(w.root, 'filter-ran');
    const program = path.join(w.root, 'filter.sh');
    await writeFile(program, `#!/bin/sh\necho "$*" >> '${sentinel}'\ncat\n`);
    await chmod(program, 0o755);
    git(w.project, w.env, 'config', 'filter.evil.clean', program);
    git(w.project, w.env, 'config', 'filter.evil.smudge', program);
    const before = w.head();
    const dialog = await w.open(worker.id, true);
    await confirm(dialog).click();
    await expect(alert(dialog)).toContainText('never runs a repository’s filters');
    await expect(alert(dialog)).toContainText('data.dat');
    expect(w.head()).toBe(before);
    expect(existsSync(path.join(w.project, 'data.dat'))).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    await w.close();
  }
});

test('closing the window in the middle of a merge does not stop it; reopening shows it settled', async () => {
  const w = await world({ gated: true });
  try {
    const worker = await w.worker({ 'done.txt': 'done\n' });
    const dialog = await w.open(worker.id, true);
    await writeFile(w.gate, 'closed');
    await confirm(dialog).click();
    await expect.poll(() => existsSync(w.reached), { timeout: 15_000 }).toBe(true);
    expect(existsSync(path.join(w.project, 'done.txt'))).toBe(false);
    await w.closeWindow();
    await rm(w.gate);
    await expect
      .poll(() => existsSync(path.join(w.project, 'done.txt')), { timeout: 15_000 })
      .toBe(true);
    expect(git(w.project, w.env, 'status', '--porcelain')).toBe('');
    await w.reopen();
    await expect
      .poll(
        async () =>
          (
            await w.page().evaluate(async (canvas) => {
              const result = await window.api.worktreeList({ canvas });
              if (!result.ok) throw new Error(result.error.sentence);
              return result.value.items.map((item) => item.merge);
            }, w.canvas)
          )[0],
        { timeout: 15_000 },
      )
      .toMatchObject({ merged: true });
  } finally {
    await w.close();
  }
});
