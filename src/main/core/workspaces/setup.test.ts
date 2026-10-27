import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NeedsItem } from '../../../shared/model/needs';
import { Children } from '../children';
import { mintTrustedPath } from '../host';
import { MAX_LOG_HEAD, MAX_LOG_TAIL } from './setup-run';
import { SetupError, WorkspaceSetups, setupNeedId } from './setup';
import type { WorkspaceSetupsDeps } from './setup';
import type { SetupRecord } from './store';
import { ran } from './test-git';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * A new workspace's setup (B9a Design §4, §14 items 2 and 3): its local files copied in, then one
 * card in Needs, yours alone, showing exactly what would run, where, from where, and what was
 * copied; nothing runs before you choose, and only what the card showed, at its generation. Run,
 * Always (for that exact command, for this repository) and Skip; Stop ends its whole process group;
 * a failure holds with its exit code; the core closing, or crashing, leaves it interrupted, never run
 * again by itself. Real Git and checkouts, real processes the core owns, fake commands only: no
 * package manager or network is ever used.
 */

const OTHER = '22222222-2222-4222-8222-222222222222' as typeof CANVAS;

// Real repositories and real processes, on a machine that may be busy.
vi.setConfig({ testTimeout: 60_000 });

let w: TestWorkspaces | undefined;
const services: WorkspaceSetups[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await w?.close();
  w = undefined;
});

interface Harness {
  t: TestWorkspaces;
  setups: WorkspaceSetups;
  children: Children;
  changed: ReturnType<typeof vi.fn>;
  /** Where fake package managers record each run. */
  sentinel: string;
  /** A file a fake command may write to, by its absolute path. */
  marker: string;
}

/** A profile, a repository with `files`, fake npm and pnpm first on the agents' PATH. */
async function harness(
  files: Record<string, string>,
  deps: Partial<WorkspaceSetupsDeps> = {},
): Promise<Harness> {
  const t = (w = await testWorkspaces(files));
  const bin = path.join(t.root, 'bin');
  mkdirSync(bin);
  const sentinel = path.join(t.root, 'sentinel');
  for (const name of ['npm', 'pnpm']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $* in $PWD" >> '${sentinel}'\n`, {
      mode: 0o755,
    });
  }
  const children = new Children(t.profile);
  await children.recover();
  const changed = vi.fn();
  const setups = service(t, children, {
    environment: () =>
      Promise.resolve({ PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: t.env.HOME ?? '' }),
    changed,
    ...deps,
  });
  return { t, setups, children, changed, sentinel, marker: path.join(t.root, 'marker') };
}

function service(
  t: TestWorkspaces,
  children: Children,
  deps: Partial<WorkspaceSetupsDeps> = {},
): WorkspaceSetups {
  const made = new WorkspaceSetups({
    workspaces: t.workspaces,
    provisioner: t.provisioner,
    git: t.git,
    directories: {
      projectRoot: (canvas) => (canvas === CANVAS ? mintTrustedPath(t.app) : undefined),
    },
    processes: children,
    environment: () => Promise.resolve({ PATH: process.env.PATH ?? '', HOME: t.env.HOME ?? '' }),
    folder: path.join(t.profile, 'workspaces', 'setup'),
    profile: t.profile,
    ...deps,
  });
  services.push(made);
  return made;
}

/** A workspace made and offered its setup. */
async function offered(h: Harness, owner: `agent/${string}` = 'agent/builder') {
  const { tree } = await h.t.provision(owner);
  await h.setups.prepare(tree.id);
  return tree;
}

function setupOf(t: TestWorkspaces, workspace: string): SetupRecord {
  const setup = t.workspaces.setup(workspace);
  if (setup === undefined) throw new Error(`No setup for ${workspace}.`);
  return setup;
}

/** Waits until the workspace's setup no longer runs. */
async function settled(t: TestWorkspaces, workspace: string): Promise<SetupRecord> {
  await vi.waitFor(
    () => {
      expect(setupOf(t, workspace).state).not.toBe('running');
    },
    { timeout: 30_000, interval: 25 },
  );
  return setupOf(t, workspace);
}

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check()).toBe(true);
    },
    { timeout: 30_000, interval: 25 },
  );
}

function card(h: Harness, workspace: string): NeedsItem {
  const found = h.setups.items(CANVAS).filter((item) => item.id.startsWith(`setup/${workspace}/`));
  expect(found).toHaveLength(1);
  const [item] = found;
  if (item === undefined) throw new Error(`No card for ${workspace}.`);
  return item;
}

function choices(item: NeedsItem): string[] {
  return item.choices.map(({ value }) => value);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupError) return error.code;
    throw error;
  }
  throw new Error('It was answered.');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const PNPM = {
  'package.json': '{"name":"app"}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  '.gitignore': '.env\n',
  '.worktreeinclude': '.env\n',
};

describe.skipIf(process.platform === 'win32')('WorkspaceSetups', () => {
  it('offers a new workspace’s setup in Needs, yours alone, showing exactly what would run; nothing runs before you choose', async () => {
    const h = await harness(PNPM);
    writeFileSync(path.join(h.t.app, '.env'), 'SECRET=1\n');
    const tree = await offered(h);
    expect(setupOf(h.t, tree.id)).toMatchObject({
      generation: 1,
      command: 'pnpm install --frozen-lockfile',
      source: 'detected',
      state: 'pending',
      approvedBy: null,
    });
    // Its local file is copied in before anything else.
    expect(readFileSync(path.join(tree.path, '.env'), 'utf8')).toBe('SECRET=1\n');
    const item = card(h, tree.id);
    expect(item).toMatchObject({
      id: setupNeedId(tree.id, 1),
      canvas: CANVAS,
      kind: 'worktree',
      for: 'you',
      by: ['you'],
      answerIn: 'api',
    });
    // A workspace's card, not an agent's: no token's view of Needs ever holds it.
    expect(item.agent).toBeUndefined();
    expect(choices(item)).toEqual(['run', 'always', 'skip']);
    expect(item.choices.every((choice) => choice.humanOnly !== undefined)).toBe(true);
    for (const shown of [
      'pnpm install --frozen-lockfile',
      tree.path,
      tree.branchRef.slice('refs/heads/'.length),
      '.env',
      'lockfile',
      'scripts',
      'network',
    ]) {
      expect(item.detail, shown).toContain(shown);
    }
    // What it copied is named, never what it holds.
    expect(JSON.stringify(item)).not.toContain('SECRET=1');
    expect(ran(h.sentinel)).toEqual([]);
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('setup');
    // Asked again, it is the same offer: nothing is copied or offered twice.
    await h.setups.prepare(tree.id);
    expect(setupOf(h.t, tree.id).generation).toBe(1);
  });

  it('runs it once you choose Run: your approval on disk before it starts, then done and the workspace ready', async () => {
    let seen: SetupRecord | undefined;
    const h = await harness(PNPM);
    const tree = await offered(h);
    const watched = service(h.t, h.children, {
      environment: () =>
        Promise.resolve({
          PATH: `${path.join(h.t.root, 'bin')}:${process.env.PATH ?? ''}`,
          HOME: h.t.env.HOME ?? '',
        }),
      processes: {
        run<T>(work: () => T): T {
          seen = h.t.workspaces.setup(tree.id);
          return h.children.run(work);
        },
        stop: (child, signal) => h.children.stop(child, signal),
      },
    });
    expect(await watched.reply(CANVAS, setupNeedId(tree.id, 1), 'run', 'you')).toEqual({
      outcome: 'started',
    });
    await until(() => seen !== undefined);
    expect(seen).toMatchObject({ state: 'running', approvedBy: 'you', generation: 1 });
    expect(seen?.approvedAt).toEqual(expect.any(Number));
    expect(await settled(h.t, tree.id)).toMatchObject({ state: 'done', exitCode: 0 });
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('ready');
    // The fixed table's argument list, no shell, in the workspace's checkout.
    expect(ran(h.sentinel)).toEqual([`pnpm install --frozen-lockfile in ${tree.path}`]);
    // Its log is private, in the profile.
    const logs = path.join(h.t.profile, 'workspaces', 'setup', 'logs');
    const [log] = readdirSync(logs);
    expect(log).toBe(`${setupOf(h.t, tree.id).logKey ?? ''}.log`);
    expect(statSync(path.join(logs, log ?? '')).mode & 0o777).toBe(0o600);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(watched.items(CANVAS)).toEqual([]);
  });

  it('never takes a token’s answer, nor one for another canvas, another choice or another generation', async () => {
    const h = await harness(PNPM);
    const tree = await offered(h);
    const id = setupNeedId(tree.id, 1);
    for (const party of ['agent:builder', 'outside:orchestrator'] as const) {
      expect(await refusal(h.setups.reply(CANVAS, id, 'run', party))).toBe('refused');
      expect(await refusal(h.setups.reply(CANVAS, id, 'always', party))).toBe('refused');
      expect(await refusal(h.setups.reply(CANVAS, id, 'skip', party))).toBe('refused');
    }
    expect(await refusal(h.setups.reply(OTHER, id, 'run', 'you'))).toBe('not-found');
    expect(await refusal(h.setups.reply(CANVAS, setupNeedId(tree.id, 2), 'run', 'you'))).toBe(
      'conflict',
    );
    expect(await refusal(h.setups.reply(CANVAS, `setup/${tree.id}`, 'run', 'you'))).toBe(
      'not-found',
    );
    expect(await refusal(h.setups.reply(CANVAS, id, 'stop', 'you'))).toBe('invalid');
    expect(await refusal(h.setups.reply(CANVAS, id, 'npm ci', 'you'))).toBe('invalid');
    expect(setupOf(h.t, tree.id)).toMatchObject({ state: 'pending', approvedBy: null });
    expect(h.t.workspaces.projectSetup(tree.repository)?.alwaysSpecHash ?? null).toBeNull();
    expect(ran(h.sentinel)).toEqual([]);
    // Skipped, its card is settled: a late Run is refused, and nothing runs.
    expect(await h.setups.reply(CANVAS, id, 'skip', 'you')).toEqual({ outcome: 'skipped' });
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('ready');
    expect(await refusal(h.setups.reply(CANVAS, id, 'run', 'you'))).toBe('conflict');
    expect(ran(h.sentinel)).toEqual([]);
  });

  it('runs no command a repository file supplies: only the fixed table’s, or yours', async () => {
    const h = await harness({
      'package.json': JSON.stringify({
        name: 'app',
        packageManager: 'pnpm@9; touch pwned',
        scripts: { setup: 'touch pwned', preinstall: 'touch pwned' },
        corrallm: { setup: 'touch pwned' },
      }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      '.worktreesetup': 'touch pwned\n',
      'conductor.json': '{"scripts":{"setup":"touch pwned"}}\n',
      'setup.sh': 'touch pwned\n',
      '.worktreeinclude': 'touch pwned\n',
    });
    const tree = await offered(h);
    expect(setupOf(h.t, tree.id)).toMatchObject({ command: null, source: 'none' });
    const item = card(h, tree.id);
    expect(choices(item)).toEqual(['skip']);
    expect(item.detail).toContain('No setup command');
    expect(await h.setups.reply(CANVAS, item.id, 'skip', 'you')).toEqual({ outcome: 'skipped' });
    expect(existsSync(path.join(tree.path, 'pwned'))).toBe(false);
    expect(existsSync(path.join(h.t.app, 'pwned'))).toBe(false);
    expect(ran(h.sentinel)).toEqual([]);
  });

  it('a changed command clears Always and raises a new card; Always runs only that exact command', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const one = await offered(h, 'agent/one');
    // Nothing detected: Skip, or a command of yours.
    expect(choices(card(h, one.id))).toEqual(['skip']);
    const first = `echo one >> '${h.marker}'`;
    expect(await h.setups.setCommand(CANVAS, first)).toEqual({ changed: true, offered: 1 });
    expect(setupOf(h.t, one.id)).toMatchObject({
      generation: 2,
      command: first,
      source: 'configured',
      state: 'pending',
    });
    expect(card(h, one.id).id).toBe(setupNeedId(one.id, 2));
    expect(card(h, one.id).detail).toContain('the command you set');
    // A second workspace, offered before Always: it keeps asking.
    const three = await offered(h, 'agent/three');
    expect(setupOf(h.t, three.id)).toMatchObject({ generation: 1, command: first });
    expect(await h.setups.reply(CANVAS, setupNeedId(one.id, 2), 'always', 'you')).toEqual({
      outcome: 'started',
    });
    expect(await settled(h.t, one.id)).toMatchObject({ state: 'done', approvedBy: 'you' });
    // A new workspace runs exactly that command by itself.
    const two = await offered(h, 'agent/two');
    expect(await settled(h.t, two.id)).toMatchObject({ state: 'done', approvedBy: 'you' });
    expect(h.t.workspaces.worktree(two.id)?.state).toBe('ready');
    expect(setupOf(h.t, three.id).state).toBe('pending');
    expect(readFileSync(h.marker, 'utf8')).toBe('one\none\n');
    // The same command again changes nothing.
    expect(await h.setups.setCommand(CANVAS, first)).toEqual({ changed: false, offered: 0 });
    expect(h.t.workspaces.projectSetup(one.repository)?.alwaysSpecHash).not.toBeNull();
    // Another clears Always, and every card still waiting is raised anew with it.
    const second = `echo two >> '${h.marker}'`;
    expect(await h.setups.setCommand(CANVAS, second)).toEqual({ changed: true, offered: 1 });
    expect(h.t.workspaces.projectSetup(one.repository)?.alwaysSpecHash).toBeNull();
    expect(setupOf(h.t, three.id)).toMatchObject({ generation: 2, command: second });
    // The old card is stale: allowing it runs nothing.
    expect(await refusal(h.setups.reply(CANVAS, setupNeedId(three.id, 1), 'run', 'you'))).toBe(
      'conflict',
    );
    const four = await offered(h, 'agent/four');
    expect(setupOf(h.t, four.id)).toMatchObject({ state: 'pending', command: second });
    // Done ones aren't offered again.
    expect(setupOf(h.t, one.id).state).toBe('done');
    expect(readFileSync(h.marker, 'utf8')).toBe('one\none\n');
    // Back to the detected one (none here): the waiting cards say so.
    expect(await h.setups.setCommand(CANVAS, null)).toEqual({ changed: true, offered: 2 });
    expect(setupOf(h.t, four.id)).toMatchObject({ command: null, source: 'none' });
    // One that isn't one line of plain text is refused, keeping what was kept.
    for (const bad of ['echo a\necho b', 'echo \u202ex', ' ', 'x'.repeat(4097)]) {
      expect(await refusal(h.setups.setCommand(CANVAS, bad)), JSON.stringify(bad)).toBe('invalid');
    }
    expect(h.t.workspaces.projectSetup(one.repository)?.command).toBeNull();
  });

  it('stops running a command by itself once you clear Always: new workspaces ask again, one running goes on', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const go = path.join(h.t.root, 'go');
    expect(await h.setups.clearAlways(CANVAS)).toEqual({ cleared: false });
    const one = await offered(h, 'agent/one');
    await h.setups.setCommand(
      CANVAS,
      `echo "$PWD" >> '${h.marker}'; while [ ! -f '${go}' ]; do sleep 0.05; done`,
    );
    await h.setups.reply(CANVAS, setupNeedId(one.id, 2), 'always', 'you');
    await until(() => existsSync(h.marker));
    expect(await h.setups.clearAlways(CANVAS)).toEqual({ cleared: true });
    expect(h.t.workspaces.projectSetup(one.repository)).toMatchObject({
      alwaysSpecHash: null,
      command: expect.stringContaining('echo') as unknown,
    });
    // What was allowed and runs goes on.
    expect(setupOf(h.t, one.id).state).toBe('running');
    writeFileSync(go, '');
    expect(await settled(h.t, one.id)).toMatchObject({ state: 'done' });
    // A new workspace asks again.
    const two = await offered(h, 'agent/two');
    expect(setupOf(h.t, two.id)).toMatchObject({ state: 'pending', approvedBy: null });
    expect(readFileSync(h.marker, 'utf8').trim().split('\n')).toEqual([one.path]);
    expect(await h.setups.clearAlways(CANVAS)).toEqual({ cleared: false });
    expect(await refusal(h.setups.clearAlways(OTHER))).toBe('refused');
  });

  it('keeps a command only for a canvas’s picked repository', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    expect(await refusal(h.setups.setCommand(OTHER, 'make setup'))).toBe('refused');
    const notGit = path.join(h.t.root, 'plain');
    mkdirSync(notGit);
    const plain = service(h.t, h.children, {
      directories: { projectRoot: () => mintTrustedPath(notGit) },
    });
    expect(await refusal(plain.setCommand(CANVAS, 'make setup'))).toBe('refused');
  });

  it('Stop ends its whole process group, then it waits for Retry or Skip', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const tree = await offered(h);
    const pids = path.join(h.t.root, 'pids');
    await h.setups.setCommand(CANVAS, `sleep 300 & echo $! >> '${pids}'; wait`);
    expect(await h.setups.reply(CANVAS, setupNeedId(tree.id, 2), 'run', 'you')).toEqual({
      outcome: 'started',
    });
    await until(() => existsSync(pids));
    const [grandchild] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    expect(alive(grandchild ?? 0)).toBe(true);
    expect(choices(card(h, tree.id))).toEqual(['stop']);
    expect(await h.setups.reply(CANVAS, setupNeedId(tree.id, 2), 'stop', 'you')).toEqual({
      outcome: 'stopped',
    });
    expect(alive(grandchild ?? 0)).toBe(false);
    expect(setupOf(h.t, tree.id)).toMatchObject({ state: 'failed', exitCode: null });
    const item = card(h, tree.id);
    expect(choices(item)).toEqual(['retry', 'skip']);
    expect(item.detail).toContain('stopped');
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('setup');
    // Retry is a new attempt, which Stop ends the same way; Skip then releases its agents.
    expect(await h.setups.reply(CANVAS, item.id, 'retry', 'you')).toEqual({ outcome: 'started' });
    await until(() => readFileSync(pids, 'utf8').trim().split('\n').length === 2);
    const [, again] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    await h.setups.reply(CANVAS, item.id, 'stop', 'you');
    expect(alive(again ?? 0)).toBe(false);
    expect(await h.setups.reply(CANVAS, item.id, 'skip', 'you')).toEqual({ outcome: 'skipped' });
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('ready');
  });

  it('says it runs while it does, and once its workspace is removed ends it and forgets its log and copy record', async () => {
    const h = await harness({ ...PNPM, 'README.md': 'hello\n' });
    writeFileSync(path.join(h.t.app, '.env'), 'SECRET=1\n');
    const tree = await offered(h);
    const copies = path.join(h.t.profile, 'workspaces', 'setup', 'copies', `${tree.id}.json`);
    const logs = path.join(h.t.profile, 'workspaces', 'setup', 'logs');
    expect(existsSync(copies)).toBe(true);
    const pids = path.join(h.t.root, 'pids');
    await h.setups.setCommand(CANVAS, `sleep 300 & echo $! >> '${pids}'; wait`);
    expect(h.setups.running(tree.id)).toBe(false);
    await h.setups.reply(CANVAS, setupNeedId(tree.id, 2), 'run', 'you');
    await until(() => existsSync(pids));
    // A writer in its tree, as its cleanup asks.
    expect(h.setups.running(tree.id)).toBe(true);
    const [grandchild] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    expect(readdirSync(logs).some((log) => log.startsWith(`${tree.id}.`))).toBe(true);
    await h.setups.forget(tree.id);
    expect(alive(grandchild ?? 0)).toBe(false);
    expect(h.setups.running(tree.id)).toBe(false);
    expect(existsSync(copies)).toBe(false);
    expect(readdirSync(logs).some((log) => log.startsWith(`${tree.id}.`))).toBe(false);
  });

  it('names the local files it copied into a workspace (none: unknown), for a checkpoint never to commit them', async () => {
    const h = await harness({ ...PNPM, 'README.md': 'hello\n' });
    writeFileSync(path.join(h.t.app, '.env'), 'SECRET=1\n');
    const tree = await offered(h);
    expect(h.setups.copied(tree.id)).toEqual(['.env']);
    const plain = await offered(h, 'agent/plain');
    expect(h.setups.copied(plain.id)).toEqual(['.env']);
    await h.setups.forget(tree.id);
    expect(h.setups.copied(tree.id)).toBeUndefined();
    // A record that can't be read is unknown, never none.
    const record = path.join(h.t.profile, 'workspaces', 'setup', 'copies', `${plain.id}.json`);
    writeFileSync(record, 'not a record');
    const fresh = service(h.t, h.children);
    expect(fresh.copied(plain.id)).toBeUndefined();
  });

  it('holds a failure with its exit code and output; Retry runs it again', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const tree = await offered(h);
    await h.setups.setCommand(
      CANVAS,
      `echo "first try"; test -f '${h.marker}' || { touch '${h.marker}'; exit 3; }`,
    );
    await h.setups.reply(CANVAS, setupNeedId(tree.id, 2), 'run', 'you');
    expect(await settled(h.t, tree.id)).toMatchObject({ state: 'failed', exitCode: 3 });
    const item = card(h, tree.id);
    expect(choices(item)).toEqual(['retry', 'skip']);
    expect(item.detail).toContain('exited with 3');
    expect(item.detail).toContain('first try');
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('setup');
    await h.setups.reply(CANVAS, item.id, 'retry', 'you');
    expect(await settled(h.t, tree.id)).toMatchObject({ state: 'done', exitCode: 0 });
    expect(h.t.workspaces.worktree(tree.id)?.state).toBe('ready');
  });

  it('keeps a bounded private log, and shows only an escaped tail of it', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const tree = await offered(h);
    await h.setups.setCommand(
      CANVAS,
      "printf '\\033[31mred\\033[0m\\n'; head -c 2000000 /dev/zero | tr '\\000' x; echo; printf 'the \\342\\200\\256end\\n'; exit 1",
    );
    await h.setups.reply(CANVAS, setupNeedId(tree.id, 2), 'run', 'you');
    const setup = await settled(h.t, tree.id);
    const log = path.join(h.t.profile, 'workspaces', 'setup', 'logs', `${setup.logKey ?? ''}.log`);
    const { size, mode } = statSync(log);
    expect(mode & 0o777).toBe(0o600);
    expect(size).toBeLessThanOrEqual(MAX_LOG_HEAD + MAX_LOG_TAIL + 256);
    expect(readFileSync(log, 'utf8')).toContain('not kept');
    const detail = card(h, tree.id).detail ?? '';
    expect(detail).toContain('the end');
    expect(detail.length).toBeLessThan(4000);
    // eslint-disable-next-line no-control-regex
    expect(detail).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u202e]/);
  });

  it('runs at most so many at once: the next waits for a slot', async () => {
    const h = await harness({ 'README.md': 'hello\n' }, { maxRunning: 1 });
    const go = path.join(h.t.root, 'go');
    const one = await offered(h, 'agent/one');
    const two = await offered(h, 'agent/two');
    await h.setups.setCommand(
      CANVAS,
      `echo "$PWD" >> '${h.marker}'; while [ ! -f '${go}' ]; do sleep 0.05; done`,
    );
    await h.setups.reply(CANVAS, setupNeedId(one.id, 2), 'run', 'you');
    await h.setups.reply(CANVAS, setupNeedId(two.id, 2), 'run', 'you');
    await until(() => existsSync(h.marker));
    // Both allowed, and on disk as running; only one has started.
    expect(setupOf(h.t, two.id).state).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readFileSync(h.marker, 'utf8').trim().split('\n')).toEqual([one.path]);
    writeFileSync(go, '');
    expect(await settled(h.t, one.id)).toMatchObject({ state: 'done' });
    expect(await settled(h.t, two.id)).toMatchObject({ state: 'done' });
    expect(readFileSync(h.marker, 'utf8').trim().split('\n')).toEqual([one.path, two.path]);
  });

  it('the core closing interrupts what runs, ending its group; it never runs again by itself', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const pids = path.join(h.t.root, 'pids');
    await offered(h, 'agent/first');
    const command = `echo ran >> '${h.marker}'; sleep 300 & echo $! >> '${pids}'; wait`;
    await h.setups.setCommand(CANVAS, command);
    const first = h.t.workspaces.worktreesOf(CANVAS)[0];
    if (first === undefined) throw new Error('No workspace.');
    await h.setups.reply(CANVAS, setupNeedId(first.id, 2), 'always', 'you');
    await until(() => existsSync(pids));
    const grandchild = Number(readFileSync(pids, 'utf8').trim());
    await h.setups.close();
    expect(alive(grandchild)).toBe(false);
    expect(setupOf(h.t, first.id)).toMatchObject({ state: 'interrupted', approvedBy: 'you' });
    // The next core: nothing runs again by itself, Always or not.
    const next = service(h.t, h.children);
    await next.recover();
    await next.reconcile();
    await next.prepare(first.id);
    expect(setupOf(h.t, first.id).state).toBe('interrupted');
    const item = next.items(CANVAS).find((one) => one.id.startsWith(`setup/${first.id}/`));
    expect(item && choices(item)).toEqual(['retry', 'skip']);
    expect(item?.detail).toContain('interrupted');
    expect(readFileSync(h.marker, 'utf8')).toBe('ran\n');
  });

  it('a crash while it runs leaves it interrupted on restart, its group ended, never run again', async () => {
    const h = await harness({ 'README.md': 'hello\n' });
    const pids = path.join(h.t.root, 'pids');
    const tree = await offered(h);
    await h.setups.setCommand(
      CANVAS,
      `echo ran >> '${h.marker}'; sleep 300 & echo $! >> '${pids}'; wait`,
    );
    // The core that crashes: once it is gone, it writes nothing more.
    let crashed = false;
    const dying = new Proxy(h.t.workspaces, {
      get(target, key, receiver) {
        if (key === 'write' && crashed) return () => Promise.reject(new Error('It crashed.'));
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const doomed = service(h.t, h.children, { workspaces: dying });
    await doomed.reply(CANVAS, setupNeedId(tree.id, 2), 'always', 'you');
    await until(() => existsSync(pids));
    const grandchild = Number(readFileSync(pids, 'utf8').trim());
    crashed = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The next core: its process owner ends what the last one left running, then setups recover.
    const children = new Children(h.t.profile);
    await children.recover();
    expect(alive(grandchild)).toBe(false);
    const next = service(h.t, children);
    await next.recover();
    expect(setupOf(h.t, tree.id)).toMatchObject({ state: 'interrupted', approvedBy: 'you' });
    await next.reconcile();
    await next.prepare(tree.id);
    expect(setupOf(h.t, tree.id).state).toBe('interrupted');
    expect(readFileSync(h.marker, 'utf8')).toBe('ran\n');
  });

  it('runs no setup on Windows, saying why: its process tree can’t be ended yet', async () => {
    const h = await harness(PNPM, { platform: 'win32' });
    const tree = await offered(h);
    const item = card(h, tree.id);
    expect(choices(item)).toEqual(['skip']);
    expect(item.detail).toContain('Windows');
    expect(await refusal(h.setups.reply(CANVAS, item.id, 'run', 'you'))).toBe('unavailable');
    expect(await refusal(h.setups.reply(CANVAS, item.id, 'always', 'you'))).toBe('unavailable');
    // Not even what was allowed always.
    const repository = tree.repository;
    const spec = setupOf(h.t, tree.id).specHash;
    await h.t.workspaces.write((x) => x.setAlways(repository, spec));
    const other = await offered(h, 'agent/other');
    expect(setupOf(h.t, other.id).state).toBe('pending');
    expect(ran(h.sentinel)).toEqual([]);
  });

  it('holds a workspace whose local files can’t be copied safely in error, saying why', async () => {
    const h = await harness({ '.gitignore': 'linked\n', '.worktreeinclude': 'linked\n' });
    writeFileSync(path.join(h.t.root, 'outside'), 'not the project’s\n');
    symlinkSync(path.join(h.t.root, 'outside'), path.join(h.t.app, 'linked'));
    const tree = await offered(h);
    expect(h.t.workspaces.worktree(tree.id)).toMatchObject({
      state: 'error',
      errorCode: 'copy-symlink',
    });
    expect(h.t.workspaces.setup(tree.id)).toBeUndefined();
    expect(h.setups.items(CANVAS)).toEqual([]);
  });
});
