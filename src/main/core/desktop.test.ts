import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LINK_LENGTH } from '../../shared/ipc';
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
      sessions: { connectors: {}, environment: () => Promise.resolve({}) },
    },
    host,
  );
});

afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});

describe('link.open', () => {
  it('opens a normalized allowlisted URL through the host', async () => {
    expect(await core.call('link.open', { url: 'HTTPS://GITHUB.COM/openai' }, SEVEN)).toEqual({
      ok: true,
      value: { opened: true },
    });
    expect(host.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/openai');
    expect(host.askOpenLink).not.toHaveBeenCalled();
  });

  it('parents the question to the calling window, and respects its answer', async () => {
    const url = 'https://docs.example.com/a';
    expect(await core.call('link.open', { url }, SEVEN)).toEqual({
      ok: true,
      value: { opened: false },
    });
    expect(host.askOpenLink).toHaveBeenCalledExactlyOnceWith(7, 'docs.example.com', url);
    expect(host.openExternal).not.toHaveBeenCalled();
    host.askOpenLink.mockResolvedValue({ open: true, always: false });
    expect(await core.call('link.open', { url }, EIGHT)).toEqual({
      ok: true,
      value: { opened: true },
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
      value: { opened: false },
    });
    expect(host.askOpenLink).not.toHaveBeenCalled();
    expect(host.openExternal).not.toHaveBeenCalled();
  });
});

describe('link.reveal', () => {
  it('reveals a real path only inside the calling window’s project folder', async () => {
    host.pickFolder.mockResolvedValue(mintTrustedPath(project));
    await core.channels.call(7, 'project:choose', []);
    const file = path.join(project, 'notes.txt');
    await writeFile(file, 'Notes');
    expect(await core.call('link.reveal', { url: pathToFileURL(file).href }, SEVEN)).toEqual({
      ok: true,
      value: { revealed: true },
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
        value: { revealed: false },
      });
    }
    expect(host.showFile).toHaveBeenCalledOnce();
  });

  it('uses the window’s canvas, including after another window chooses a different folder', async () => {
    await core.channels.call(7, 'run:get', []);
    await core.channels.call(8, 'canvas:forget', []);
    host.pickFolder.mockResolvedValue(mintTrustedPath(project));
    await core.channels.call(7, 'project:choose', []);
    const file = path.join(project, 'notes.txt');
    await writeFile(file, 'Notes');
    const url = pathToFileURL(file).href;
    expect(await core.call('link.reveal', { url }, EIGHT)).toEqual({
      ok: true,
      value: { revealed: false },
    });
    expect(host.showFile).not.toHaveBeenCalled();
    expect(await core.call('link.reveal', { url }, SEVEN)).toEqual({
      ok: true,
      value: { revealed: true },
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
  it('returns the calling window’s canvas, restoring it on its first call', async () => {
    const first = await core.call('window.get', {}, SEVEN);
    const context = await core.channels.call(7, 'run:get', []);
    if (!first.ok) throw new Error(first.error.sentence);
    expect(context).toMatchObject({ id: first.value.c });
    await core.channels.call(8, 'run:get', []);
    const next = await core.channels.call(7, 'canvas:forget', []);
    expect(await core.call('window.get', undefined, SEVEN)).toEqual({
      ok: true,
      value: { c: next },
    });
    expect(await core.call('window.get', {}, EIGHT)).toEqual({
      ok: true,
      value: { c: first.value.c },
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
