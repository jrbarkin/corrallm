import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { serveCommand } from './serve';
import type { ServeIO } from './serve';

const mocks = vi.hoisted(() => ({
  createCore: vi.fn(),
  startApiServer: vi.fn(),
  lockProfile: vi.fn(),
  processStart: vi.fn(() => 1234),
}));
vi.mock('../core/core', () => ({ createCore: mocks.createCore }));
vi.mock('../api/mcp', () => ({ startApiServer: mocks.startApiServer }));
vi.mock('../core/lock', () => ({
  lockProfile: mocks.lockProfile,
  processStart: mocks.processStart,
  ProfileLocked: class extends Error {},
}));
vi.mock('../sessions/adapters', () => ({ CATALOG: { adapters: [] }, ADAPTERS: [] }));

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01' as CanvasId;
const URL = 'http://127.0.0.1:43210/mcp';
let profile: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.processStart.mockReturnValue(1234);
  vi.stubGlobal('CORRALLM_DISTRIBUTION', 'local');
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-serve-startup-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(profile, { recursive: true, force: true });
});

function address(): unknown {
  try {
    return JSON.parse(readFileSync(path.join(profile, 'api.json'), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function fixture() {
  const stopped = Promise.withResolvers<undefined>();
  const release = vi.fn();
  const core = {
    watch: vi.fn(),
    keptCanvas: vi.fn(() => Promise.resolve(CANVAS)),
    openHeld: vi.fn(() => Promise.resolve([])),
    settings: {
      keepApiPort: vi.fn(() => Promise.resolve()),
    },
    served: vi.fn(),
    deliver: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const server = { url: URL, port: 43210, close: vi.fn(() => Promise.resolve()) };
  mocks.lockProfile.mockResolvedValue({ release });
  mocks.createCore.mockResolvedValue(core);
  mocks.startApiServer.mockResolvedValue(server);
  let said = '';
  const io: ServeIO = {
    env: { CORRALLM_AGENT_PATHS: '{}' },
    app: { name: 'corrallm', version: '1.0.0' },
    stopped: stopped.promise,
    stderr: {
      isTTY: false,
      write: (chunk: string | Uint8Array) => {
        const line = chunk.toString();
        said += line;
        onLine(line);
        return true;
      },
    },
  };
  let onLine: (line: string) => void = () => undefined;
  return {
    core,
    server,
    release,
    stopped,
    said: () => said,
    onLine: (hear: (line: string) => void) => {
      onLine = hear;
    },
    run: () => serveCommand({ command: 'serve', canvases: ['team.corral'], profile, port: 0 }, io),
  };
}

it('refuses an unwritable api.json before delivering or announcing service', async () => {
  // Atomic rename cannot replace a directory on either supported platform.
  await mkdir(path.join(profile, 'api.json'));
  const test = fixture();
  // The CLI maps an uncaught startup rejection to exit 4; refused starts must return 1.
  const code = await test.run().catch(() => 4);
  expect(test.core.deliver).not.toHaveBeenCalled();
  expect(test.said()).not.toContain('corrallm serve: serving ');
  expect(code).toBe(1);
  expect(test.said()).toContain('api.json');
  expect(test.server.close).toHaveBeenCalledOnce();
  expect(test.core.close).toHaveBeenCalledOnce();
  expect(test.release).toHaveBeenCalledOnce();
});

it('publishes api.json before delivery and before printing serving, then removes it on stop', async () => {
  const test = fixture();
  let atDelivery: unknown;
  let atServing: unknown;
  test.core.deliver.mockImplementation(() => {
    atDelivery = address();
    return Promise.resolve();
  });
  test.onLine((line) => {
    if (line.startsWith('corrallm serve: serving ')) {
      atServing = address();
      test.stopped.resolve(undefined);
    }
  });
  expect(await test.run()).toBe(0);
  for (const published of [atDelivery, atServing]) {
    expect(published).toMatchObject({ url: URL, port: 43210, pid: process.pid, started: 1234 });
  }
  expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  expect(test.release).toHaveBeenCalledOnce();
});

it('cleans up a successful publication when stopped during it, without delivering', async () => {
  const test = fixture();
  mocks.processStart.mockImplementation(() => {
    // Resolve the host signal as publication begins; its callback runs while the write awaits I/O.
    test.stopped.resolve(undefined);
    return 1234;
  });
  expect(await test.run()).toBe(0);
  expect(test.core.deliver).not.toHaveBeenCalled();
  expect(test.said()).not.toContain('corrallm serve: serving ');
  expect(test.said()).toContain('stopping…');
  expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  expect(test.release).toHaveBeenCalledOnce();
});
