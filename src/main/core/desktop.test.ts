import { legacyDirectories } from './workspaces/test-directories';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { MAX_LINK_LENGTH } from '../../shared/ipc';
import { toFile } from '../../shared/model/file';
import { journaledRun } from './store/test-store';
import { createCore } from './core';
import type { Core } from './core';
import { mintTrustedPath } from './host';
import type { HostServices } from './host';
import { CALLERS, NO_DESKTOP } from './test-registry';

const SEVEN = { ...CALLERS.you, window: 7 };
const EIGHT = { ...CALLERS.you, window: 8 };
let profile: string;
let project: string;
let core: Core;
let host: ReturnType<typeof desktop>;

function desktop() {
  return {
    ...NO_DESKTOP,
    askOpenLink: vi
      .fn<HostServices['askOpenLink']>()
      .mockResolvedValue({ open: false, always: false }),
    openExternal: vi.fn<HostServices['openExternal']>().mockResolvedValue(null),
    showFile: vi.fn<HostServices['showFile']>().mockResolvedValue(null),
    pickFolder: vi.fn<HostServices['pickFolder']>().mockResolvedValue(null),
  };
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-desktop-'));
  project = path.join(profile, 'project');
  await mkdir(project);
  host = desktop();
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: { connectors: {}, environment: () => Promise.resolve({}) },
    },
    host,
  );
});

afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});

/** Picks the project folder of the canvas `caller`'s window shows, in the folder dialog. */
async function chooseProject(caller: typeof SEVEN) {
  const shown = await core.call('window.get', {}, caller);
  if (!shown.ok) throw new Error(shown.error.sentence);
  return core.call('project.choose', { canvas: shown.value.canvas }, caller);
}
/** Begins a new canvas in `caller`'s window, as New does: its id. */
async function created(caller: typeof SEVEN) {
  const made = await core.call('canvas.create', {}, caller);
  if (!made.ok || !('canvas' in made.value)) throw new Error('No canvas was made');
  return made.value.canvas;
}

describe('link.open', () => {
  it('opens a normalized allowlisted URL through the host', async () => {
    expect(await core.call('link.open', { url: 'HTTPS://GITHUB.COM/openai' }, SEVEN)).toEqual({
      ok: true,
      value: { opened: true, revs: {} },
    });
    expect(host.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/openai');
    expect(host.askOpenLink).not.toHaveBeenCalled();
  });

  it('parents the question to the calling window, and respects its answer', async () => {
    const url = 'https://docs.example.com/a';
    expect(await core.call('link.open', { url }, SEVEN)).toEqual({
      ok: true,
      value: { opened: false, revs: {} },
    });
    expect(host.askOpenLink).toHaveBeenCalledExactlyOnceWith(7, 'docs.example.com', url);
    expect(host.openExternal).not.toHaveBeenCalled();
    host.askOpenLink.mockResolvedValue({ open: true, always: false });
    expect(await core.call('link.open', { url }, EIGHT)).toEqual({
      ok: true,
      value: { opened: true, revs: {} },
    });
    expect(host.askOpenLink).toHaveBeenLastCalledWith(8, 'docs.example.com', url);
    expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it.each([
    'javascript:alert(1)',
    'file:///work/app',
    'https://user:secret@example.com',
    'http://example.com',
    'not a URL',
  ])('leaves %s inert', async (url) => {
    expect(await core.call('link.open', { url }, SEVEN)).toEqual({
      ok: true,
      value: { opened: false, revs: {} },
    });
    expect(host.askOpenLink).not.toHaveBeenCalled();
    expect(host.openExternal).not.toHaveBeenCalled();
  });
});

describe('link.reveal', () => {
  it('reveals a real path only inside the calling window’s project folder', async () => {
    host.pickFolder.mockResolvedValue(mintTrustedPath(project));
    await chooseProject(SEVEN);
    const file = path.join(project, 'notes.txt');
    await writeFile(file, 'Notes');
    expect(await core.call('link.reveal', { url: pathToFileURL(file).href }, SEVEN)).toEqual({
      ok: true,
      value: { revealed: true, revs: {} },
    });
    expect(host.showFile).toHaveBeenCalledExactlyOnceWith(await realpath(file));
    const outside = path.join(profile, 'outside.txt');
    await writeFile(outside, 'Outside');
    const link = path.join(project, 'outside-link');
    await symlink(outside, link);
    for (const url of [
      pathToFileURL(outside).href,
      pathToFileURL(link).href,
      pathToFileURL(path.join(project, 'missing')).href,
      'file://other/work/notes.txt',
      'https://example.com',
    ]) {
      expect(await core.call('link.reveal', { url }, SEVEN)).toEqual({
        ok: true,
        value: { revealed: false, revs: {} },
      });
    }
    expect(host.showFile).toHaveBeenCalledOnce();
  });

  it('uses the window’s canvas, including after another window chooses a different folder', async () => {
    await core.call('window.get', {}, SEVEN);
    await created(EIGHT);
    host.pickFolder.mockResolvedValue(mintTrustedPath(project));
    await chooseProject(SEVEN);
    const file = path.join(project, 'notes.txt');
    await writeFile(file, 'Notes');
    const url = pathToFileURL(file).href;
    expect(await core.call('link.reveal', { url }, EIGHT)).toEqual({
      ok: true,
      value: { revealed: false, revs: {} },
    });
    expect(host.showFile).not.toHaveBeenCalled();
    expect(await core.call('link.reveal', { url }, SEVEN)).toEqual({
      ok: true,
      value: { revealed: true, revs: {} },
    });
  });
});

describe.each(['link.open', 'link.reveal'] as const)('%s arguments', (op) => {
  it.each([
    ['no URL', {}],
    ['a URL that is not a string', { url: { href: 'https://example.com' } }],
    ['an extra argument', { url: 'https://example.com', extra: true }],
    ['a URL too long', { url: 'x'.repeat(MAX_LINK_LENGTH + 1) }],
    ['a window supplied by the page', { url: 'https://example.com', window: 8 }],
    ['a canvas supplied by the page', { url: 'file:///work/app', canvas: crypto.randomUUID() }],
  ])('rejects %s before any OS action', async (_label, args) => {
    expect(await core.call(op, args, SEVEN)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(host.askOpenLink).not.toHaveBeenCalled();
    expect(host.openExternal).not.toHaveBeenCalled();
    expect(host.showFile).not.toHaveBeenCalled();
  });
});

describe('window.get', () => {
  it('never accepts a renderer checkpoint or document after a core operation', async () => {
    const shown = await core.call('window.get', {}, SEVEN);
    if (!shown.ok) throw new Error(shown.error.sentence);
    const canvas = shown.value.canvas as CanvasId;
    const stale = toFile({ id: canvas, arrange: false, nodes: [], links: [] });
    const added = await core.call(
      'canvas.addAgent',
      { canvas, adapter: 'codex', at: { x: 0, y: 0 } },
      SEVEN,
    );
    if (!added.ok || 'proposed' in added.value) throw new Error('Agent not added');
    const after = await core.call('canvas.get', { canvas }, SEVEN);
    for (const args of [
      [canvas, null],
      [canvas, null, stale, 0],
    ])
      expect(() => core.channels.call(7, 'run:save', args)).toThrow('no channel');
    expect(await core.call('canvas.get', { canvas }, SEVEN)).toEqual(after);
  });
  it('lists the live running state even when the journal clock does not move', async () => {
    const shown = await core.call('window.get', {}, SEVEN);
    if (!shown.ok) throw new Error(shown.error.sentence);
    const canvas = shown.value.canvas as CanvasId;
    const added = await core.call(
      'canvas.addAgent',
      { canvas, adapter: 'codex', at: { x: 0, y: 0 } },
      SEVEN,
    );
    if (!added.ok || 'proposed' in added.value) throw new Error('No agent');
    await core.call(
      'queue.add',
      { canvas, agent: added.value.id, entry: { message: 'Wait here' } },
      SEVEN,
    );
    const runtime = core.engines.canvas(canvas);
    if (!runtime) throw new Error('No runtime');
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    try {
      for (const running of [true, false, true]) {
        if (running) runtime.engine.run.start();
        else runtime.engine.run.stop();
        await core.flush();
        expect(journaledRun(profile, canvas)?.updatedAt).toBe(1234);
        const listed = await core.call('canvas.list', {}, SEVEN);
        if (!listed.ok) throw new Error(listed.error.sentence);
        expect(listed.value.items.find((item) => item.canvas === canvas)?.running).toBe(running);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('returns the calling window’s canvas, restoring it on its first call', async () => {
    const first = await core.call('window.get', {}, SEVEN);
    const context = await core.call('window.get', {}, SEVEN);
    if (!first.ok) throw new Error(first.error.sentence);
    expect(context).toMatchObject({ ok: true, value: { canvas: first.value.canvas } });
    await core.call('window.get', {}, EIGHT);
    const next = await created(SEVEN);
    expect(await core.call('window.get', undefined, SEVEN)).toEqual({
      ok: true,
      value: { canvas: next },
    });
    expect(await core.call('window.get', {}, EIGHT)).toEqual({
      ok: true,
      value: { canvas: first.value.canvas },
    });
  });

  it('takes no page-supplied window or canvas', async () => {
    for (const args of [{ window: 8 }, { c: crypto.randomUUID() }]) {
      expect(await core.call('window.get', args, SEVEN)).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
    }
  });
});

describe('window.show', () => {
  it('shows a kept canvas only in the calling window and restores its project', async () => {
    const first = await core.call('window.get', {}, SEVEN);
    if (!first.ok) throw new Error(first.error.sentence);
    host.pickFolder.mockResolvedValue(mintTrustedPath(project));
    await chooseProject(SEVEN);
    await core.call('window.get', {}, EIGHT);
    const draft = await created(SEVEN);
    expect(await core.call('window.show', { canvas: first.value.canvas }, SEVEN)).toEqual({
      ok: true,
      value: { revs: {} },
    });
    expect(await core.call('window.get', {}, SEVEN)).toEqual({
      ok: true,
      value: { canvas: first.value.canvas },
    });
    expect(await core.call('window.get', {}, SEVEN)).toMatchObject({
      ok: true,
      value: { canvas: first.value.canvas },
    });
    expect(await core.call('canvas.get', { canvas: first.value.canvas }, SEVEN)).toMatchObject({
      ok: true,
      value: { project: { path: project } },
    });
    expect(await core.call('window.get', {}, EIGHT)).toEqual({
      ok: true,
      value: { canvas: first.value.canvas },
    });
    expect(await core.call('window.show', { canvas: draft }, EIGHT)).toEqual({
      ok: true,
      value: { revs: {} },
    });
    expect(await core.call('window.get', {}, SEVEN)).toEqual({
      ok: true,
      value: { canvas: first.value.canvas },
    });
  });
  it('refuses a missing canvas and page-supplied window without changing the shown canvas', async () => {
    const first = await core.call('window.get', {}, SEVEN);
    expect(await core.call('window.show', { canvas: crypto.randomUUID() }, SEVEN)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(
      await core.call('window.show', { canvas: crypto.randomUUID(), window: 8 }, SEVEN),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await core.call('window.get', {}, SEVEN)).toEqual(first);
  });
});
