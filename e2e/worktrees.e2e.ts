import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { git, gitEnvironment, makeRepository } from '../src/main/core/workspaces/test-git';
import { canvasAction, dismissStart, openNeeds } from './canvas-actions';
import { launchApp } from './launch';

// Real app, Git, process ownership and native conversation bookkeeping. Only fixture CLIs run.
test.skip(process.platform === 'win32', 'These fake executables and crash groups use POSIX.');

interface NativeEvent {
  event: string;
  cwd?: string;
  args?: string[];
}
async function nativeLog(folder: string): Promise<NativeEvent[]> {
  try {
    return (await readFile(path.join(folder, '.fake-claude', 'log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as NativeEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function world({ crash = false }: { crash?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'corrallm-worktrees-e2e-'));
  const env = gitEnvironment(path.join(root, 'home'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'profile');
  const bin = path.join(root, 'bin');
  await mkdir(profile);
  await mkdir(bin);
  makeRepository(project, env, {
    'README.md': 'base\n',
    '.gitignore': '.env*\n',
    '.worktreeinclude': '.env.allowed\n',
    '.gitattributes': '*.txt filter=evil\n*.md filter=late\n',
    'plain.txt': 'plain\n',
  });
  await writeFile(path.join(project, '.env.allowed'), 'fixture-private-value\n');
  const cli = path.join(bin, 'claude');
  const config = path.join(root, 'claude-config');
  await mkdir(config);
  await writeFile(
    cli,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fake-claude.mjs')}" "$@"\n`,
  );
  await chmod(cli, 0o755);
  // Preserve the fixture PATH during the core's environment read, without sourcing host profiles.
  const shell = path.join(bin, 'login-shell');
  await writeFile(
    shell,
    '#!/bin/sh\nif [ "$1" = "-ilc" ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/sh "$@"\n',
  );
  await chmod(shell, 0o755);
  const reached = path.join(root, 'populated.json');
  if (crash) {
    const realGit = (env.PATH ?? '')
      .split(path.delimiter)
      .filter((folder) => path.isAbsolute(folder))
      .map((folder) => path.join(folder, 'git'))
      .find((file) => existsSync(file));
    if (!realGit) throw new Error('Git is required');
    const arm = path.join(root, 'crash-once');
    await writeFile(arm, 'armed');
    const script = path.join(bin, 'git.mjs');
    await writeFile(
      script,
      `import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
execFileSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (args.includes('read-tree') && existsSync(${JSON.stringify(arm)})) {
  unlinkSync(${JSON.stringify(arm)});
  writeFileSync(${JSON.stringify(reached)}, JSON.stringify({ cwd: process.cwd() }));
  setInterval(() => {}, 1000);
}
`,
    );
    await writeFile(
      path.join(bin, 'git'),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
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
  let running = await launchApp({
    profile,
    env: launchEnv,
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
  });
  let page = await running.app.firstWindow();
  let closed = false;
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
    const add = async () =>
      page.evaluate(async (canvas) => {
        const result = await window.api.canvasAddAgent({
          canvas,
          adapter: 'claude-code',
          connection: 'claude-code.terminal',
          at: { x: 0, y: 0 },
        });
        if (!result.ok) throw new Error(result.error.sentence);
        return result.value.id;
      }, canvas);
    const allocate = async (agent: string) => {
      const availability = await page.evaluate(
        (agent) => window.api.sessionAvailability(agent),
        agent,
      );
      if (!availability.ready) {
        await openNeeds(page);
        await page.getByRole('article').getByRole('button', { name: 'Skip', exact: true }).click();
        await page.getByRole('button', { name: 'Needs you', exact: true }).click();
      }
      const item = (await list()).items.find((item) => item.agent === agent);
      if (!item?.location) throw new Error('No checkout');
      return item;
    };
    const start = async (agent: string) => {
      const item = await allocate(agent);
      const before = (await nativeLog(item.location ?? '')).filter(
        (event) => event.event === 'ready',
      ).length;
      await page.evaluate(
        (agent) =>
          window.api.startSession(agent, {
            connection: 'claude-code.terminal',
            model: null,
            mode: null,
          }),
        agent,
      );
      await expect
        .poll(
          async () =>
            (await nativeLog(item.location ?? '')).filter((event) => event.event === 'ready')
              .length,
          { timeout: 15000 },
        )
        .toBe(before + 1);
      return item;
    };
    return {
      root,
      project,
      profile,
      env,
      canvas,
      reached,
      add,
      list,
      allocate,
      start,
      page: () => page,
      app: () => running.app,
      async restart() {
        await running.close();
        closed = true;
        running = await launchApp({
          profile,
          env: launchEnv,
          diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
        });
        closed = false;
        page = await running.app.firstWindow();
        await page.waitForLoadState('load');
        await dismissStart(page);
        await page.evaluate(async (canvas) => {
          const result = await window.api.windowShow({ canvas });
          if (!result.ok) throw new Error(result.error.sentence);
        }, canvas);
      },
      async close() {
        if (!closed) await running.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await running.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('independent edits stay off the base; native cwd and conversation survive restart', async () => {
  const w = await world();
  try {
    const a = await w.add(),
      b = await w.add();
    const first = await w.allocate(a);
    expect(await nativeLog(first.location ?? '')).toEqual([]);
    const one = await w.start(a),
      two = await w.start(b);
    if (!one.location || !two.location) throw new Error('No checkouts');
    expect(one.workspace).not.toBe(two.workspace);
    expect(one.branch).not.toBe(two.branch);
    expect((await nativeLog(one.location)).find((event) => event.event === 'start')?.cwd).toBe(
      one.location,
    );
    expect((await nativeLog(two.location)).find((event) => event.event === 'start')?.cwd).toBe(
      two.location,
    );
    await writeFile(path.join(one.location, 'README.md'), 'one\n');
    await writeFile(path.join(two.location, 'README.md'), 'two\n');
    expect(await readFile(path.join(w.project, 'README.md'), 'utf8')).toBe('base\n');
    expect(await readFile(path.join(one.location, '.env.allowed'), 'utf8')).toBe(
      'fixture-private-value\n',
    );
    await w.page().evaluate(async (agent) => {
      const result = await window.api.terminalInput({ agent, data: 'hello\r' });
      if (!result.ok) throw new Error(result.error.sentence);
    }, a);
    await expect
      .poll(
        async () =>
          (await nativeLog(one.location ?? '')).filter((event) => event.event === 'prompt').length,
      )
      .toBe(1);
    const original =
      (await nativeLog(one.location)).find((event) => event.event === 'start')?.args ?? [];
    expect(original).toContain('--session-id');
    const id = original[original.indexOf('--session-id') + 1];
    if (!id) throw new Error('The fake did not receive its native conversation id');
    await expect
      .poll(() => existsSync(path.join(one.location ?? '', '.fake-claude', id)))
      .toBe(true);
    const otherArgs =
      (await nativeLog(two.location)).find((event) => event.event === 'start')?.args ?? [];
    expect(otherArgs).toContain('--session-id');
    expect(otherArgs[otherArgs.indexOf('--session-id') + 1]).not.toBe(id);
    const file = path.join(w.root, 'team.corral');
    await w.app().evaluate(({ dialog }, file) => {
      Object.assign(dialog, {
        showSaveDialog: () => Promise.resolve({ canceled: false, filePath: file }),
      });
    }, file);
    await canvasAction(w.page(), 'Save as…');
    await expect.poll(() => existsSync(file)).toBe(true);
    const saved = await readFile(file, 'utf8');
    expect(saved).not.toContain('.corral/worktrees');
    expect(saved).not.toContain('fixture-private-value');
    expect(git(w.project, w.env, 'status', '--porcelain')).toBe('');
    await w.restart();
    const restored = (await w.list()).items.find((item) => item.agent === a);
    expect(restored).toMatchObject({
      workspace: one.workspace,
      location: one.location,
      branch: one.branch,
    });
    await w.start(a);
    await expect
      .poll(
        async () =>
          (await nativeLog(one.location ?? '')).filter((event) => event.event === 'start').length,
        { timeout: 15000 },
      )
      .toBe(2);
    const resumed =
      (await nativeLog(one.location)).filter((event) => event.event === 'start')[1]?.args ?? [];
    expect(resumed).toContain(`--resume=${id}`);
    expect(await readFile(path.join(one.location, 'README.md'), 'utf8')).toBe('one\n');
    expect(existsSync(path.join(w.project, '.fake-claude'))).toBe(false);
  } finally {
    await w.close();
  }
});

test('group members share uncommitted files and native cwd but have separate conversations', async () => {
  const w = await world();
  try {
    const a = await w.add(),
      b = await w.add();
    await w.page().evaluate(
      async ({ canvas, nodes }) => {
        const result = await window.api.canvasGroup({ canvas, nodes, kind: 'frame' });
        if (!result.ok) throw new Error(result.error.sentence);
      },
      { canvas: w.canvas, nodes: [a, b] },
    );
    const one = await w.start(a),
      two = await w.start(b);
    expect(two.workspace).toBe(one.workspace);
    expect(two.location).toBe(one.location);
    if (!one.location) throw new Error('No shared checkout');
    await expect
      .poll(
        async () =>
          (await nativeLog(one.location ?? '')).filter((event) => event.event === 'start').length,
        { timeout: 15000 },
      )
      .toBe(2);
    const starts = (await nativeLog(one.location)).filter((event) => event.event === 'start');
    expect(starts.map((event) => event.cwd)).toEqual([one.location, one.location]);
    const ids = starts.map((event) => {
      const args = event.args ?? [];
      expect(args).toContain('--session-id');
      return args[args.indexOf('--session-id') + 1];
    });
    expect(new Set(ids).size).toBe(2);
    await writeFile(path.join(one.location, 'shared-notes.txt'), 'shared, uncommitted\n');
    for (const agent of [a, b]) {
      const result = await w
        .page()
        .evaluate(
          ({ canvas, agent }) => window.api.projectFiles({ canvas, agent, query: 'shared-notes' }),
          { canvas: w.canvas, agent },
        );
      expect(result).toMatchObject({ ok: true, value: { items: ['shared-notes.txt'] } });
    }
    expect(existsSync(path.join(w.project, 'shared-notes.txt'))).toBe(false);
  } finally {
    await w.close();
  }
});

test('hostile hooks, filters, conditional filters and fsmonitor stay inert in the app', async () => {
  const w = await world();
  try {
    const sentinel = path.join(w.root, 'sentinel');
    const program = path.join(w.root, 'evil.sh');
    await writeFile(program, `#!/bin/sh\necho ran >> '${sentinel}'\ncat\n`);
    await chmod(program, 0o755);
    for (const name of ['post-checkout', 'reference-transaction', 'post-index-change']) {
      const hook = path.join(w.project, '.git', 'hooks', name);
      await writeFile(hook, `#!/bin/sh\n'${program}'\n`);
      await chmod(hook, 0o755);
    }
    const conditional = path.join(w.root, 'late.config');
    await writeFile(conditional, `[filter "late"]\nsmudge = '${program}'\nrequired = true\n`);
    for (const [key, value] of [
      ['core.fsmonitor', program],
      ['filter.evil.clean', program],
      ['filter.evil.smudge', program],
      ['filter.evil.process', program],
      ['filter.evil.required', 'true'],
      ['includeIf.onbranch:corrallm/**.path', conditional],
    ])
      git(w.project, w.env, 'config', key ?? '', value ?? '');
    const agent = await w.add();
    const item = await w.start(agent);
    expect(await readFile(path.join(item.location ?? '', 'plain.txt'), 'utf8')).toBe('plain\n');
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    await w.close();
  }
});

for (const attack of ['core.worktree', 'symlinked .corral']) {
  test(`refuses ${attack}, without writing outside or falling back to the base`, async () => {
    const w = await world();
    try {
      const outside = path.join(w.root, 'outside');
      await mkdir(outside);
      if (attack === 'core.worktree') git(w.project, w.env, 'config', 'core.worktree', outside);
      else await symlink(outside, path.join(w.project, '.corral'));
      const agent = await w.add();
      const result = await w
        .page()
        .evaluate((agent) => window.api.sessionAvailability(agent), agent);
      expect(result.ready).toBe(false);
      await expect
        .poll(async () => (await w.list()).items.find((item) => item.agent === agent)?.state)
        .toBe('error');
      expect(existsSync(path.join(outside, 'worktrees'))).toBe(false);
      expect(existsSync(path.join(w.project, '.fake-claude'))).toBe(false);
      const files = await w
        .page()
        .evaluate(({ canvas, agent }) => window.api.projectFiles({ canvas, agent, query: '' }), {
          canvas: w.canvas,
          agent,
        });
      expect(files).toMatchObject({ ok: true, value: { items: [] } });
    } finally {
      await w.close();
    }
  });
}

test('a core crash after Git population and before its mark reconciles to the same tree', async () => {
  const w = await world({ crash: true });
  try {
    const agent = await w.add();
    const waiting = w
      .page()
      .evaluate((agent) => window.api.sessionAvailability(agent), agent)
      .then(
        () => undefined,
        () => undefined,
      );
    await expect.poll(() => existsSync(w.reached), { timeout: 20000 }).toBe(true);
    const marker = JSON.parse(await readFile(w.reached, 'utf8')) as { cwd: string };
    const [pid] = await w.app().evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((metric) => metric.type === 'Utility' && metric.name === 'corrallm core')
        .map((metric) => metric.pid),
    );
    if (pid === undefined) throw new Error('No core');
    process.kill(pid, 'SIGKILL');
    await waiting;
    await expect(w.page().locator('.graph-editor')).toHaveAttribute('aria-busy', 'false', {
      timeout: 20000,
    });
    await expect(w.page().locator('.workspace-badge[data-workspace-attention]')).toHaveCount(1, {
      timeout: 20000,
    });
    const items = (await w.list()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ location: marker.cwd, state: 'setup' });
    expect(
      git(w.project, w.env, 'for-each-ref', '--format=%(refname)', 'refs/heads/corrallm/')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    expect(await nativeLog(marker.cwd)).toEqual([]);
    await openNeeds(w.page());
    await expect(
      w.page().getByRole('article', { name: /setup command|Set up .*worktree/ }),
    ).toHaveCount(1);
  } finally {
    await w.close();
  }
});

test('changing project closes live agents, retains their work and starts fresh in the new repository', async () => {
  const w = await world();
  try {
    const agent = await w.add();
    const old = await w.start(agent);
    if (!old.location) throw new Error('No checkout');
    await writeFile(path.join(old.location, 'my-work.txt'), 'retained work\n');
    const next = path.join(w.root, 'next');
    makeRepository(next, w.env, { 'README.md': 'next base\n' });
    await w.app().evaluate(({ dialog }, next) => {
      Object.assign(dialog, {
        showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [next] }),
      });
    }, next);
    await w.page().getByRole('button', { name: 'Project folder: project', exact: true }).click();
    await expect(
      w.page().getByRole('button', { name: 'Project folder: next', exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await nativeLog(old.location ?? '')).filter((event) => event.event === 'exit').length,
        { timeout: 15000 },
      )
      .toBe(1);
    const fresh = await w.start(agent);
    expect(fresh.workspace).not.toBe(old.workspace);
    expect(fresh.location).not.toBe(old.location);
    expect(realpathSync(fresh.location ?? '')).toContain(
      `${realpathSync(next)}${path.sep}.corral${path.sep}`,
    );
    expect(await readFile(path.join(fresh.location ?? '', 'README.md'), 'utf8')).toBe(
      'next base\n',
    );
    expect(await readFile(path.join(old.location, 'my-work.txt'), 'utf8')).toBe('retained work\n');
    expect((await w.list()).kept.map((tree) => tree.workspace)).toContain(old.workspace);
    const args =
      (await nativeLog(fresh.location ?? '')).find((event) => event.event === 'start')?.args ?? [];
    expect(args).not.toContain('--resume');
    expect(existsSync(path.join(next, '.fake-claude'))).toBe(false);
  } finally {
    await w.close();
  }
});

test('cleanup proposals reject changed work, then Keep and a fresh Remove preserve the decision boundary', async () => {
  const w = await world();
  try {
    const agent = await w.add();
    const tree = await w.allocate(agent);
    if (!tree.location) throw new Error('No checkout');
    const file = path.join(tree.location, 'README.md');
    await writeFile(file, 'work before confirmation\n');
    const propose = () =>
      w.page().evaluate(
        async ({ canvas, agent }) => {
          const result = await window.api.canvasDelete({ canvas, nodes: [agent] });
          if (!result.ok) throw new Error(result.error.sentence);
        },
        { canvas: w.canvas, agent },
      );
    await propose();
    await openNeeds(w.page());
    const keepLabel = 'Delete, keep its work';
    const live = () =>
      w
        .page()
        .getByRole('article')
        .filter({ has: w.page().getByRole('button', { name: keepLabel, exact: true }) });
    const question = live();
    await expect(question).toBeVisible();
    const title = await question.getAttribute('aria-label');
    if (!title) throw new Error('No proposal title');
    await writeFile(file, 'new work while deciding\n');
    await question
      .getByRole('button', { name: 'Delete, and discard its worktree and branch', exact: true })
      .click();
    await expect(w.page().getByRole('article', { name: title, exact: true })).toContainText(
      /stale|changed since/i,
    );
    await expect(w.page().locator('.react-flow__node-agent')).toHaveCount(1);
    expect(await readFile(file, 'utf8')).toBe('new work while deciding\n');
    await propose();
    await live().getByRole('button', { name: keepLabel, exact: true }).click();
    await expect(w.page().locator('.react-flow__node-agent')).toHaveCount(0);
    await dismissStart(w.page());
    await canvasAction(w.page(), 'Canvases');
    const kept = w.page().getByRole('region', { name: 'Kept worktrees of Untitled', exact: true });
    await expect(kept).toContainText(tree.branch ?? '');
    await kept.getByRole('button', { name: /Remove .* worktree/ }).click();
    await kept
      .getByRole('article')
      .getByRole('button', { name: 'Remove it and its branch', exact: true })
      .click();
    await expect(kept).toHaveCount(0, { timeout: 15000 });
  } finally {
    await w.close();
  }
});
