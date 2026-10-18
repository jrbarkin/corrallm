import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import { mintTrustedPath } from './core/host';
import type { HostServices } from './core/host';
import { CanvasMemory } from './memory';
import { ProjectFolders } from './project';

const WINDOW = 7;
const THREAD = '0199a3f0-1234-7000-8000-123456789abc';

let dir: string;
let memory: CanvasMemory;
let pickFolder: ReturnType<typeof vi.fn<HostServices['pickFolder']>>;
let projects: ProjectFolders;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-project-'));
  memory = new CanvasMemory(path.join(dir, 'canvases.json'));
  pickFolder = vi.fn<HostServices['pickFolder']>();
  projects = new ProjectFolders({ host: { pickFolder }, memory });
});
afterEach(async () => {
  await memory.flush();
  await rm(dir, { recursive: true, force: true });
});

/** Answers the next folder dialog with `folder` (undefined: cancelled). */
function pick(folder: string | undefined) {
  pickFolder.mockResolvedValueOnce(folder === undefined ? null : mintTrustedPath(folder));
}

describe('project folders', () => {
  it('asks for a folder in the window’s dialog, which the canvas’s agents then work in', async () => {
    const app = path.join(dir, 'app');
    const canvas = newCanvasId();
    pick(app);
    await expect(projects.choose(WINDOW, canvas)).resolves.toEqual({ name: 'app', path: app });
    expect(projects.of(canvas)).toBe(app);
    expect(pickFolder).toHaveBeenLastCalledWith(WINDOW, undefined);

    // Cancelled: it keeps the one it had, which the dialog started at.
    pick(undefined);
    await expect(projects.choose(WINDOW, canvas)).resolves.toBeNull();
    expect(projects.of(canvas)).toBe(app);
    expect(pickFolder).toHaveBeenLastCalledWith(WINDOW, app);
    // Each canvas has its own.
    expect(projects.of(newCanvasId())).toBeUndefined();
  });

  it('is remembered with the canvas, and comes back when it is shown again', async () => {
    const app = path.join(dir, 'app');
    await mkdir(app);
    const canvas = newCanvasId();
    pick(app);
    await projects.choose(WINDOW, canvas);

    const later = new ProjectFolders({ host: { pickFolder }, memory });
    expect(later.of(canvas)).toBeUndefined();
    await expect(later.restore(canvas)).resolves.toEqual({ name: 'app', path: app });
    expect(later.of(canvas)).toBe(app);
    // Another canvas has none.
    await expect(later.restore(newCanvasId())).resolves.toBeUndefined();
  });

  it('keeps the canvas’s file and conversations when its folder is chosen', async () => {
    const app = path.join(dir, 'app');
    const canvas = newCanvasId();
    const file = mintTrustedPath('/work/team.corral');
    await memory.setFile(canvas, file);
    await memory.update(canvas, (m) => ({
      ...m,
      conversations: { codex: { coder: { id: THREAD } } },
    }));

    pick(app);
    await projects.choose(WINDOW, canvas);

    // Check the saved file too: the thread must survive an app restart.
    expect(await new CanvasMemory(path.join(dir, 'canvases.json')).get(canvas)).toEqual({
      file,
      project: app,
      conversations: { codex: { coder: { id: THREAD } } },
    });
  });

  it('does not bring back a folder that is gone', async () => {
    const canvas = newCanvasId();
    pick(path.join(dir, 'gone'));
    await projects.choose(WINDOW, canvas);
    const later = new ProjectFolders({ host: { pickFolder }, memory });
    await expect(later.restore(canvas)).resolves.toBeUndefined();
    expect(later.of(canvas)).toBeUndefined();
  });
});
