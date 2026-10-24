import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Party } from '../../shared/api/surface';
import { toolName } from '../../shared/api/registry';
import type { NeedsItem } from '../../shared/model/needs';
import { listTools } from '../api/mcp';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases, readOnDisk } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { GitRunner } from './workspaces/git';
import { Provisioner } from './workspaces/provision';
import { WorkspaceSetups, setupNeedId } from './workspaces/setup';
import { WorkspaceStore } from './workspaces/store';
import { gitEnvironment, makeRepository } from './workspaces/test-git';

/*
 * A worktree's setup through core.call, as every transport reaches it (B9a Design §14 item 2): the
 * setup command is yours alone (`project.setSetupCommand`: human-only, so no token is offered it or
 * may call it), and so is every answer to a setup card, which no token's view of Needs holds and no
 * token may name. Only your Run, at the card's generation, runs anything. The core composed as B9a
 * X11b is to compose it (CoreConfig.setups), on a real repository; the commands are fake ones.
 */

vi.setConfig({ testTimeout: 60_000 });

const PROFILE_ID = '5f607182-93a4-4b5c-8dce-4a5b6c7d8e9f';
const YOU = CALLERS.you;
const TOKENS: readonly Party[] = ['lead', 'worker', 'outside-read', 'outside-write'];

let root: string;
let core: Core;
let marker: string;
let made: { workspaces: WorkspaceStore; provisioner: Provisioner; setups: WorkspaceSetups };
let project: string;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'corrallm-setup-')));
  const env = gitEnvironment(path.join(root, 'home'));
  project = path.join(root, 'project');
  makeRepository(project, env, { 'README.md': 'hello\n' });
  const profile = path.join(root, 'profile');
  mkdirSync(profile);
  marker = path.join(root, 'marker');
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: ['builder', 'lead', 'worker'].map((id, i) => ({
        id,
        kind: 'agent',
        label: id,
        position: { x: i * 400, y: 0 },
        adapter: 'codex',
        connection: 'codex.app-server',
      })),
      links: [{ agents: ['lead', 'worker'] }],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  let clock = 0;
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      limitsClock: () => (clock += 1000),
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
      setups: ({ store, processes, directories, profile: at, changed }) => {
        const workspaces = new WorkspaceStore({ store });
        const git = new GitRunner({
          environment: () => Promise.resolve(env),
          processes,
          hooks: path.join(at, 'workspaces', 'hooks'),
        });
        const provisioner = new Provisioner({ workspaces, git, profile: PROFILE_ID });
        const setups = new WorkspaceSetups({
          workspaces,
          provisioner,
          git,
          directories,
          processes,
          environment: () => Promise.resolve({ PATH: process.env.PATH ?? '', HOME: root }),
          folder: path.join(at, 'workspaces', 'setup'),
          profile: at,
          changed,
        });
        made = { workspaces, provisioner, setups };
        return setups;
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
});
afterEach(async () => {
  await core.close();
  rmSync(root, { recursive: true, force: true });
});

/** A workspace made for the builder and offered its setup: its card's id. */
async function offered(): Promise<{ id: string; workspace: string }> {
  const found = await made.provisioner.repository(project);
  if (found.kind !== 'repository') throw new Error(JSON.stringify(found));
  const tree = await made.provisioner.provision({
    canvas: CANVAS,
    repository: found.record,
    owner: 'agent/builder',
  });
  await made.setups.prepare(tree.id);
  const setup = made.workspaces.setup(tree.id);
  if (setup === undefined) throw new Error('Not offered.');
  return { id: setupNeedId(tree.id, setup.generation), workspace: tree.id };
}

async function needsOf(party: Party): Promise<NeedsItem[]> {
  const result = await core.call('needs', { canvas: CANVAS }, CALLERS[party]);
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value.items as NeedsItem[];
}

describe.skipIf(process.platform === 'win32')('a worktree’s setup, through core.call', () => {
  it('only you set the setup command: no token is offered it or may call it, and nothing is kept', async () => {
    const pwned = path.join(root, 'pwned');
    for (const party of TOKENS) {
      expect(listTools(core, CALLERS[party]).map(({ name }) => name)).not.toContain(
        toolName('project.setSetupCommand'),
      );
      expect(
        await core.call(
          'project.setSetupCommand',
          { canvas: CANVAS, command: `touch '${pwned}'` },
          CALLERS[party],
        ),
      ).toMatchObject({ ok: false, error: { code: 'human-only' } });
    }
    const kept = () =>
      readOnDisk(path.join(root, 'profile'), (db) =>
        db.prepare('SELECT command, shell_kind AS shell FROM project_setup').all(),
      );
    expect(kept()).toEqual([]);
    expect(
      await core.call('project.setSetupCommand', { canvas: CANVAS, command: 'make setup' }, YOU),
    ).toMatchObject({ ok: true, value: { changed: true, offered: 0 } });
    expect(kept()).toEqual([{ command: 'make setup', shell: 'posix' }]);
    for (const command of ['make\nsetup', 'make \u202esetup', 'make\u2028setup', '']) {
      expect(
        await core.call('project.setSetupCommand', { canvas: CANVAS, command }, YOU),
        JSON.stringify(command),
      ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    }
    expect(kept()).toEqual([{ command: 'make setup', shell: 'posix' }]);
    expect(existsSync(pwned)).toBe(false);
  });

  it('a setup card is yours alone: no token sees it or answers it, and only your Run runs it', async () => {
    await core.call(
      'project.setSetupCommand',
      { canvas: CANVAS, command: `echo ran >> '${marker}'` },
      YOU,
    );
    const { id, workspace } = await offered();
    const yours = (await needsOf('you')).find((item) => item.id === id);
    expect(yours).toMatchObject({ kind: 'worktree', by: ['you'] });
    expect(yours?.detail).toContain(`echo ran >> '${marker}'`);
    for (const party of TOKENS) {
      expect((await needsOf(party)).map((item) => item.id)).not.toContain(id);
    }
    for (const party of ['lead', 'worker', 'outside-write'] as const) {
      for (const choice of ['run', 'always', 'skip']) {
        const answered = await core.call(
          'reply',
          { canvas: CANVAS, to: id, answer: { choice } },
          CALLERS[party],
        );
        expect(answered.ok, `${party} ${choice}`).toBe(false);
      }
    }
    expect(made.workspaces.setup(workspace)).toMatchObject({ state: 'pending', approvedBy: null });
    expect(existsSync(marker)).toBe(false);
    expect(
      await core.call('reply', { canvas: CANVAS, to: id, answer: { choice: 'run' } }, YOU),
    ).toMatchObject({ ok: true, value: { outcome: 'started' } });
    await vi.waitFor(
      () => {
        expect(made.workspaces.setup(workspace)?.state).toBe('done');
      },
      { timeout: 30_000, interval: 25 },
    );
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(made.workspaces.worktree(workspace)?.state).toBe('ready');
    expect((await needsOf('you')).map((item) => item.id)).not.toContain(id);
    // Settled: a second Run runs nothing.
    expect(
      await core.call('reply', { canvas: CANVAS, to: id, answer: { choice: 'run' } }, YOU),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
  });

  it('only you clear Always: no token is offered it or may call it', async () => {
    const always = () =>
      readOnDisk(path.join(root, 'profile'), (db) =>
        db.prepare('SELECT always_spec_hash AS always FROM project_setup').all(),
      );
    await core.call('project.setSetupCommand', { canvas: CANVAS, command: 'echo set' }, YOU);
    const { id } = await offered();
    await core.call('reply', { canvas: CANVAS, to: id, answer: { choice: 'always' } }, YOU);
    expect(always()).toEqual([{ always: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown }]);
    for (const party of TOKENS) {
      expect(listTools(core, CALLERS[party]).map(({ name }) => name)).not.toContain(
        toolName('project.clearSetupApproval'),
      );
      expect(
        await core.call('project.clearSetupApproval', { canvas: CANVAS }, CALLERS[party]),
      ).toMatchObject({ ok: false, error: { code: 'human-only' } });
    }
    expect(always()).toEqual([{ always: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown }]);
    expect(await core.call('project.clearSetupApproval', { canvas: CANVAS }, YOU)).toMatchObject({
      ok: true,
      value: { cleared: true },
    });
    expect(always()).toEqual([{ always: null }]);
  });

  it('an answer to a card raised anew, its command changed, is stale and runs nothing', async () => {
    await core.call('project.setSetupCommand', { canvas: CANVAS, command: 'echo first' }, YOU);
    const { id, workspace } = await offered();
    expect(
      await core.call(
        'project.setSetupCommand',
        { canvas: CANVAS, command: `echo second >> '${marker}'` },
        YOU,
      ),
    ).toMatchObject({ ok: true, value: { changed: true, offered: 1 } });
    expect(
      await core.call('reply', { canvas: CANVAS, to: id, answer: { choice: 'run' } }, YOU),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(made.workspaces.setup(workspace)).toMatchObject({ generation: 2, state: 'pending' });
    expect((await needsOf('you')).map((item) => item.id)).toContain(setupNeedId(workspace, 2));
    expect(existsSync(marker)).toBe(false);
  });
});
