import { renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { mintTrustedPath } from '../host';
import { WorkspaceSetups, setupNeedId } from './setup';
import { SetupProcess } from './setup-run';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';
import { makeRepository } from './test-git';

vi.setConfig({ testTimeout: 30_000 });
let t: TestWorkspaces | undefined;
let setups: WorkspaceSetups | undefined;
afterEach(async () => {
  await setups?.close();
  vi.restoreAllMocks();
  await t?.close();
  setups = undefined;
  t = undefined;
});

it.each(['stop', 'shutdown'] as const)(
  'does not spawn an approved setup if %s arrives while its environment is being read',
  async (why) => {
    const w = (t = await testWorkspaces({ 'README.md': 'hello\n' }));
    const { tree } = await w.provision();
    const environment = Promise.withResolvers<Record<string, string>>();
    const reading = Promise.withResolvers<undefined>();
    const start = vi.spyOn(SetupProcess, 'start').mockResolvedValue({
      exited: Promise.resolve({ code: null, signal: null, endedBy: why }),
      tail: () => '',
      stop: () => Promise.resolve({ code: null, signal: null, endedBy: why }),
    } as unknown as SetupProcess);
    const service = (setups = new WorkspaceSetups({
      workspaces: w.workspaces,
      provisioner: w.provisioner,
      git: w.git,
      directories: { projectRoot: () => mintTrustedPath(w.app) },
      processes: { run: (work) => work(), stop: () => Promise.resolve() },
      environment: () => {
        reading.resolve(undefined);
        return environment.promise;
      },
      folder: path.join(w.profile, 'workspaces', 'setup'),
      profile: w.profile,
    }));
    await service.prepare(tree.id);
    await service.setCommand(CANVAS, 'echo approved');
    const id = setupNeedId(tree.id, 2);
    await service.reply(CANVAS, id, 'run', 'you');
    await reading.promise;
    const ended = why === 'stop' ? service.reply(CANVAS, id, 'stop', 'you') : service.close();
    environment.resolve(w.env);
    await ended;
    expect(start).not.toHaveBeenCalled();
    expect(w.workspaces.setup(tree.id)?.state).toBe(why === 'stop' ? 'failed' : 'interrupted');
  },
);

it('does not record approval or run a setup whose reply was cancelled before its commit', async () => {
  const w = (t = await testWorkspaces({ 'README.md': 'hello\n' }));
  const { tree } = await w.provision();
  const service = (setups = new WorkspaceSetups({
    workspaces: w.workspaces,
    provisioner: w.provisioner,
    git: w.git,
    directories: { projectRoot: () => mintTrustedPath(w.app) },
    processes: { run: (work) => work(), stop: () => Promise.resolve() },
    environment: () => Promise.resolve(w.env),
    folder: path.join(w.profile, 'workspaces', 'setup'),
    profile: w.profile,
  }));
  await service.prepare(tree.id);
  await service.setCommand(CANVAS, 'echo approved');
  const checkpoint = await w.provisioner.checkout(tree.id);
  const checked = Promise.withResolvers<undefined>();
  const ready = Promise.withResolvers<typeof checkpoint>();
  vi.spyOn(w.provisioner, 'checkout').mockImplementation(() => {
    checked.resolve(undefined);
    return ready.promise;
  });
  const start = vi.spyOn(SetupProcess, 'start').mockResolvedValue({
    exited: Promise.resolve({ code: 0, signal: null }),
    tail: () => '',
    stop: () => Promise.resolve({ code: null, signal: null, endedBy: 'stop' }),
  } as unknown as SetupProcess);
  const controller = new AbortController();
  // The reply router supplies the call's no-return boundary as the last argument. The old
  // implementation accepted the call but ignored that boundary (the red probe used Reflect).
  const answered = service.reply(CANVAS, setupNeedId(tree.id, 2), 'always', 'you', {
    noReturn() {
      controller.signal.throwIfAborted();
    },
  });
  const refused = expect(answered).rejects.toThrow('cancelled');
  await checked.promise;
  controller.abort(new Error('cancelled'));
  ready.resolve(checkpoint);
  await refused;
  expect(start).not.toHaveBeenCalled();
  expect(w.workspaces.setup(tree.id)).toMatchObject({ state: 'pending', approvedBy: null });
  expect(w.workspaces.projectSetup(tree.repository)?.alwaysSpecHash).toBeNull();
});

it('rechecks the checkout after reading its environment, refusing a root swapped meanwhile', async () => {
  const w = (t = await testWorkspaces({ 'README.md': 'hello\n' }));
  const { tree } = await w.provision();
  const reading = Promise.withResolvers<undefined>();
  const environment = Promise.withResolvers<Record<string, string>>();
  const service = (setups = new WorkspaceSetups({
    workspaces: w.workspaces,
    provisioner: w.provisioner,
    git: w.git,
    directories: { projectRoot: () => mintTrustedPath(w.app) },
    processes: { run: (work) => work(), stop: () => Promise.resolve() },
    environment: () => {
      reading.resolve(undefined);
      return environment.promise;
    },
    folder: path.join(w.profile, 'workspaces', 'setup'),
    profile: w.profile,
  }));
  await service.prepare(tree.id);
  await service.setCommand(CANVAS, 'echo approved');
  const start = vi.spyOn(SetupProcess, 'start').mockResolvedValue({
    exited: Promise.resolve({ code: 0, signal: null }),
    tail: () => '',
    stop: () => Promise.resolve({ code: null, signal: null, endedBy: 'stop' }),
  } as unknown as SetupProcess);
  await service.reply(CANVAS, setupNeedId(tree.id, 2), 'run', 'you');
  await reading.promise;
  const outside = path.join(w.root, 'outside');
  makeRepository(outside, w.env, { 'README.md': 'outside\n' });
  renameSync(tree.path, `${tree.path}.kept`);
  symlinkSync(outside, tree.path);
  environment.resolve(w.env);
  await vi.waitFor(() => {
    expect(w.workspaces.setup(tree.id)?.state).not.toBe('running');
  });
  expect(start).not.toHaveBeenCalled();
  expect(w.workspaces.setup(tree.id)?.state).toBe('failed');
});

it.each(['stop', 'shutdown'] as const)(
  'refuses the actual spawn if %s arrives while its log is being opened',
  async (why) => {
    const w = (t = await testWorkspaces({ 'README.md': 'hello\n' }));
    const { tree } = await w.provision();
    const opening = Promise.withResolvers<undefined>();
    const opened = Promise.withResolvers<undefined>();
    const spawn = vi.fn(
      () =>
        ({
          exited: Promise.resolve({ code: 0, signal: null }),
          tail: () => '',
          stop: () => Promise.resolve({ code: null, signal: null, endedBy: why }),
        }) as unknown as SetupProcess,
    );
    vi.spyOn(SetupProcess, 'start').mockImplementation(async (processes) => {
      opening.resolve(undefined);
      await opened.promise;
      return processes.run(spawn);
    });
    const service = (setups = new WorkspaceSetups({
      workspaces: w.workspaces,
      provisioner: w.provisioner,
      git: w.git,
      directories: { projectRoot: () => mintTrustedPath(w.app) },
      processes: { run: (work) => work(), stop: () => Promise.resolve() },
      environment: () => Promise.resolve(w.env),
      folder: path.join(w.profile, 'workspaces', 'setup'),
      profile: w.profile,
    }));
    await service.prepare(tree.id);
    await service.setCommand(CANVAS, 'echo approved');
    const id = setupNeedId(tree.id, 2);
    await service.reply(CANVAS, id, 'run', 'you');
    await opening.promise;
    const ended = why === 'stop' ? service.reply(CANVAS, id, 'stop', 'you') : service.close();
    opened.resolve(undefined);
    await ended;
    expect(spawn).not.toHaveBeenCalled();
    expect(w.workspaces.setup(tree.id)?.state).toBe(why === 'stop' ? 'failed' : 'interrupted');
  },
);
