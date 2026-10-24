import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AgentId } from '../../../shared/api/ids';
import { newCanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import { ProjectFolders } from '../../project';
import { mintTrustedPath } from '../host';
import type { HostServices } from '../host';
import { openTestStore } from '../store/test-store';
import type { Store } from '../store/store';
import { ProjectDirectories } from './resolver';

let folder: string;
let store: Store;
let memory: CanvasMemory;
let projects: ProjectFolders;
let directories: ProjectDirectories;
const canvas = newCanvasId();
const agent = AgentId.parse('agent');
const pick = vi.fn<HostServices['pickFolder']>();

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-directories-'));
  store = await openTestStore(folder);
  memory = new CanvasMemory(store);
  projects = new ProjectFolders({ memory, host: { pickFolder: pick } });
  directories = new ProjectDirectories(projects);
});
afterEach(async () => {
  projects.close();
  await memory.flush();
  await store.close();
  await rm(folder, { recursive: true, force: true });
});

it('resolves the picked TrustedPath with legacy workspace and binding metadata', async () => {
  const cwd = mintTrustedPath(path.join(folder, 'project'));
  pick.mockResolvedValueOnce(cwd);
  await projects.choose(7, canvas);
  await expect(directories.workingDirectory(canvas, agent)).resolves.toEqual({
    state: 'ready',
    cwd,
    workspace: null,
    generation: 0,
    branch: null,
  });
  expect(directories.projectRoot(canvas)).toBe(cwd);
});

it('holds an agent with no project, without minting a path or a Need', async () => {
  await expect(directories.workingDirectory(canvas, agent)).resolves.toEqual({
    state: 'held',
    reason: 'no-project',
    sentence:
      'Choose a project folder for this canvas first (in the bar at the top left): its agents work in it.',
  });
  expect(directories.projectRoot(canvas)).toBeUndefined();
});

it('announces choose, change and forget, with no event for cancellation or another canvas', async () => {
  const changed = vi.fn();
  const stop = directories.onAvailability(canvas, changed);
  pick.mockResolvedValueOnce(mintTrustedPath(path.join(folder, 'first')));
  await projects.choose(7, canvas);
  expect(changed).toHaveBeenCalledOnce();
  pick.mockResolvedValueOnce(null);
  await projects.choose(7, canvas);
  expect(changed).toHaveBeenCalledOnce();
  pick.mockResolvedValueOnce(mintTrustedPath(path.join(folder, 'second')));
  await projects.choose(7, canvas);
  expect(changed).toHaveBeenCalledTimes(2);
  pick.mockResolvedValueOnce(mintTrustedPath(folder));
  await projects.choose(7, newCanvasId());
  expect(changed).toHaveBeenCalledTimes(2);
  await memory.forget(canvas);
  expect(changed).toHaveBeenCalledTimes(3);
  await expect(directories.workingDirectory(canvas, agent)).resolves.toMatchObject({
    state: 'held',
    reason: 'no-project',
  });
  stop();
  pick.mockResolvedValueOnce(mintTrustedPath(folder));
  await projects.choose(7, canvas);
  expect(changed).toHaveBeenCalledTimes(3);
});

it('announces restored and missing project folders', async () => {
  const cwd = mintTrustedPath(path.join(folder, 'project'));
  await mkdir(cwd);
  await memory.update(canvas, (before) => ({ ...before, project: cwd }));
  const changed = vi.fn();
  directories.onAvailability(canvas, changed);
  await projects.restore(canvas);
  expect(changed).toHaveBeenCalledOnce();
  expect(directories.projectRoot(canvas)).toBe(cwd);
  await rm(cwd, { recursive: true });
  await projects.restore(canvas);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(directories.projectRoot(canvas)).toBeUndefined();
});
