import type { CanvasId } from '../../shared/canvas';
import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { spawn } from '../sessions/process';
import { createCore } from './core';
import type { Core } from './core';
import { CALLERS, NO_DESKTOP } from './test-registry';

const { spawned } = vi.hoisted(() => ({ spawned: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: spawned,
}));
let profile: string;
let core: Core | undefined;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-owned-core-'));
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('starts a usable core even when a stale CLI cannot be signalled', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const file = path.join(profile, 'sessions', 'pids.json');
  await mkdir(path.dirname(file));
  await writeFile(file, JSON.stringify({ version: 1, children: [{ pid: 42, started: 1000 }] }));
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1' },
      check: true,
      distribution: 'local',
      fakeSessions: true,
      children: {
        platform: 'linux',
        inspect: () => ({ started: 1000, group: 42 }),
        alive: () => true,
        signal: () => {
          throw new Error('EPERM');
        },
        wait: () => Promise.resolve(),
        now: () => 1000,
      },
      sessions: { connectors: {}, environment: () => Promise.resolve({}) },
    },
    NO_DESKTOP,
  );
  expect(await core.call('app.info', {}, CALLERS.you)).toMatchObject({
    ok: true,
    value: { name: 'corrallm', version: '1' },
  });
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('42'),
    expect.objectContaining({ message: 'EPERM' }),
  );
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    version: 1,
    children: [{ pid: 42, started: 1000 }],
  });
});

it.each(['operation', 'channel', 'engine'] as const)(
  'owns processes started by a core %s’s asynchronous services',
  async (from) => {
    const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });
    spawned.mockReturnValue(child);
    vi.stubEnv('CORRALLM_CLAUDE_PATH', path.join(profile, 'no-claude'));
    vi.stubEnv('CORRALLM_CODEX_PATH', path.join(profile, 'no-codex'));
    const canvas = '4b1f6c2e-8d3a-4e5f-9a0b-7c6d5e4f3a2b' as CanvasId;
    if (from === 'engine') {
      const project = path.join(profile, 'project');
      const file = path.join(profile, 'canvas.corral');
      await mkdir(project);
      await copyFile(path.join(import.meta.dirname, 'test-worker.corral'), file);
      await writeFile(
        path.join(profile, 'canvases.json'),
        JSON.stringify({
          version: 2,
          canvases: { [canvas]: { file, project, conversations: {} } },
        }),
      );
    }
    core = await createCore(
      {
        profile,
        app: { name: 'corrallm', version: '1' },
        check: true,
        distribution: 'local',
        fakeSessions: true,
        children: {
          platform: 'linux',
          inspect: () => ({ started: 1000, group: 42 }),
          alive: () => false,
          signal: vi.fn(),
          wait: () => Promise.resolve(),
          now: () => 1000,
        },
        sessions: {
          connectors: {},
          environment: async () => {
            await Promise.resolve();
            spawn('fake-shell', [], {});
            return {};
          },
        },
      },
      NO_DESKTOP,
    );
    if (from === 'operation') await core.call('catalog.installed', {}, CALLERS.you);
    else if (from === 'channel') await core.channels.call(7, 'session:clis', []);
    else await (await core.engines.open(canvas)).sessions.settingsOptions('codex');
    const file = path.join(profile, 'sessions', 'pids.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      children: [{ pid: 42, started: 1000 }],
    });
    child.emit('exit', 0);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, children: [] });
  },
);
