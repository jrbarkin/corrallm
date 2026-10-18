import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests never load the real 'electron' module (importing it would download the binary).
const { showOpenDialog } = vi.hoisted(() => ({
  showOpenDialog:
    vi.fn<(options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog },
}));

import { CanvasMemory } from './memory';
import { ProjectFolders } from './project';

/** A stand-in for a renderer's web contents: project.ts only keys its memory by it. */
const contents = () => ({}) as Electron.WebContents;

let dir: string;
let memory: CanvasMemory;
/** Each renderer's canvas file, as canvas.ts would know it. */
let canvases: Map<Electron.WebContents, string>;
let projects: ProjectFolders;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-project-'));
  memory = new CanvasMemory(path.join(dir, 'canvases.json'));
  canvases = new Map();
  projects = new ProjectFolders(memory, (c) => canvases.get(c));
  showOpenDialog.mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Answers the next folder dialog with `folder` (undefined: cancelled). */
function pick(folder: string | undefined) {
  showOpenDialog.mockResolvedValueOnce(
    folder === undefined
      ? { canceled: true, filePaths: [] }
      : { canceled: false, filePaths: [folder] },
  );
}

describe('project folders', () => {
  it('asks for a folder, which the canvas’s agents then work in', async () => {
    const app = path.join(dir, 'app');
    const window = contents();
    pick(app);
    await expect(projects.choose(window)).resolves.toEqual({ name: 'app', path: app });
    expect(projects.of(window)).toBe(app);
    expect(showOpenDialog.mock.calls[0]?.[0].properties).toContain('openDirectory');

    // Cancelled: it keeps the one it had.
    pick(undefined);
    await expect(projects.choose(window)).resolves.toBeNull();
    expect(projects.of(window)).toBe(app);
    // Each renderer has its own.
    expect(projects.of(contents())).toBeUndefined();
  });

  it('is remembered with the canvas’s file, and comes back when the file opens', async () => {
    const app = path.join(dir, 'app');
    await mkdir(app);
    const window = contents();
    canvases.set(window, '/work/team.corral');
    pick(app);
    await projects.choose(window);

    const later = contents();
    canvases.set(later, '/work/team.corral');
    await expect(projects.restore(later)).resolves.toEqual({ name: 'app', path: app });
    expect(projects.of(later)).toBe(app);

    // Another canvas has none, and opening it forgets the one before.
    canvases.set(later, '/work/other.corral');
    await expect(projects.restore(later)).resolves.toBeUndefined();
    expect(projects.of(later)).toBeUndefined();
  });

  it('remembers the folder chosen before the canvas had a file once it is saved', async () => {
    const app = path.join(dir, 'app');
    await mkdir(app);
    const window = contents();
    pick(app);
    await projects.choose(window);
    canvases.set(window, '/work/new.corral');
    await projects.remember(window);
    expect((await memory.get('/work/new.corral')).project).toBe(app);
  });

  it('keeps Codex threads when the project folder is chosen again or the canvas is saved', async () => {
    const app = path.join(dir, 'app');
    const window = contents();
    const canvas = '/work/team.corral';
    const thread = '0199a3f0-1234-7000-8000-123456789abc';
    canvases.set(window, canvas);
    await memory.update(canvas, () => ({ project: app, sessions: {}, threads: { coder: thread } }));

    pick(app);
    await projects.choose(window);
    await projects.remember(window);

    // Check the saved file too: the thread must survive an app restart.
    const restored = new CanvasMemory(path.join(dir, 'canvases.json'));
    expect(await restored.get(canvas)).toEqual({
      project: app,
      sessions: {},
      threads: { coder: thread },
    });
  });

  it('does not bring back a folder that is gone', async () => {
    const window = contents();
    canvases.set(window, '/work/team.corral');
    pick(path.join(dir, 'gone'));
    await projects.choose(window);
    await expect(projects.restore(window)).resolves.toBeUndefined();
    expect(projects.of(window)).toBeUndefined();
  });

  it('forgets the folder, for a new canvas', async () => {
    const window = contents();
    pick(path.join(dir, 'app'));
    await projects.choose(window);
    projects.forget(window);
    expect(projects.of(window)).toBeUndefined();
  });
});
