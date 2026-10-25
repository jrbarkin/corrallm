import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import { MAX_FILE_MATCHES, MAX_FILE_QUERY_LENGTH } from '../../shared/session';
import { callTool } from '../api/mcp';
import { ProjectFiles } from '../files';
import { createCore } from './core';
import type { Core } from './core';
import { asHuman } from './gui';
import { mintTrustedPath } from './host';
import { CALLERS, NO_DESKTOP } from './test-registry';

let profile: string;
let folder: string;
let core: Core;
let canvas: CanvasId;
const caller = asHuman(7);

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-project-op-'));
  folder = path.join(profile, 'project');
  await mkdir(path.join(folder, 'src', 'main'), { recursive: true });
  await writeFile(path.join(folder, 'src', 'main', 'ipc.ts'), '');
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      sessions: { connectors: {}, environment: () => Promise.resolve({}) },
    },
    { ...NO_DESKTOP, pickFolder: () => Promise.resolve(mintTrustedPath(folder)) },
  );
  const current = await core.call('window.get', {}, caller);
  if (!current.ok) throw new Error(current.error.sentence);
  canvas = current.value.canvas as CanvasId;
});

afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

describe('project.files', () => {
  it('searches the canvas’s project folder, and returns none without one, without opening a run', async () => {
    const find = vi.spyOn(ProjectFiles.prototype, 'find');
    const runtime = core.engines.canvas(canvas);
    const open = vi.spyOn(core.engines, 'open');
    expect(await core.call('project.files', { canvas, query: 'ipc' }, caller)).toEqual({
      ok: true,
      value: { items: [] },
    });
    expect(find).not.toHaveBeenCalled();
    await core.call('project.choose', { canvas }, caller);
    expect(await core.call('project.files', { canvas, query: 'ipc' }, caller)).toEqual({
      ok: true,
      value: { items: ['src/main/ipc.ts'] },
    });
    expect(find).toHaveBeenCalledWith(folder, 'ipc', MAX_FILE_MATCHES);
    expect(open).not.toHaveBeenCalled();
    expect(core.engines.opened()).toEqual([canvas]);
    expect(core.engines.canvas(canvas)).toBe(runtime);
  });

  it('returns folders and the best matches, bounded by MAX_FILE_MATCHES', async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        writeFile(path.join(folder, `file-${String(i).padStart(2, '0')}.txt`), ''),
      ),
    );
    await core.call('project.choose', { canvas }, caller);
    expect(await core.call('project.files', { canvas, query: 'src/ma' }, caller)).toEqual({
      ok: true,
      value: { items: ['src/main/', 'src/main/ipc.ts'] },
    });
    expect(await core.call('project.files', { canvas, query: 'file-' }, caller)).toEqual({
      ok: true,
      value: {
        items: Array.from(
          { length: MAX_FILE_MATCHES },
          (_, i) => `file-${String(i).padStart(2, '0')}.txt`,
        ),
      },
    });
  });

  it('answers MCP within an outside token’s reach and returns not-found outside it', async () => {
    await core.call('project.choose', { canvas }, caller);
    const token = { ...CALLERS['outside-read'], canvases: [canvas] };
    expect(await callTool(core, token, 'project_files', { query: 'ipc' })).toMatchObject({
      structuredContent: { items: ['src/main/ipc.ts'] },
    });
    const outside = await callTool(core, token, 'project_files', {
      canvas: newCanvasId(),
      query: 'ipc',
    });
    expect(outside.isError).toBe(true);
    expect(
      outside.content.filter((part) => part.type === 'text').map((part) => part.text),
    ).toContainEqual(expect.stringContaining('"code":"not-found"'));
  });

  it.each([
    {},
    { query: 42 },
    { query: 'x'.repeat(MAX_FILE_QUERY_LENGTH + 1) },
    { query: 'ipc', folder: '/etc' },
  ])('rejects invalid arguments: %j', async (args) => {
    const find = vi.spyOn(ProjectFiles.prototype, 'find');
    expect(await core.call('project.files', { canvas, ...args }, caller)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(find).not.toHaveBeenCalled();
  });
});
