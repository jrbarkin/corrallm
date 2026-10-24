import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  exec: vi.fn(),
  exists: vi.fn<(file: unknown) => boolean>(() => true),
  electron: vi.fn(),
  webgl: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock('node:child_process', () => ({ execFileSync: fakes.exec }));
vi.mock('node:fs', () => ({ existsSync: fakes.exists }));
vi.mock('../../e2e/agent-electron', () => ({ makeAgentElectron: fakes.electron }));
vi.mock('../../e2e/webgl', () => ({ checkWebGL2: fakes.webgl }));

import globalSetup from '../../e2e/global-setup';

beforeEach(() => {
  vi.clearAllMocks();
  fakes.exists.mockReturnValue(true);
  vi.stubEnv('E2E_SKIP_BUILD', undefined);
  vi.stubEnv('CORRALLM_E2E_BUILD', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('builds once through Forge, then checks WebGL2 before starting specs', async () => {
  await globalSetup();
  expect(fakes.electron).toHaveBeenCalledOnce();
  expect(fakes.exec).toHaveBeenCalledOnce();
  const [file, args, options] = fakes.exec.mock.calls[0] as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  expect(file).toBe(process.execPath);
  expect(args[0]).toMatch(/electron-forge\.js$/);
  expect(args[1]).toBe('package');
  // Never print the rest of the inherited environment in assertion output.
  expect(options.env.CORRALLM_UNSIGNED).toBe('1');
  expect(options.env.CORRALLM_E2E_BUILD).toBe('1');
  expect(process.env.CORRALLM_E2E_BUILD).toBeUndefined();
  expect(fakes.webgl).toHaveBeenCalledOnce();
  expect(fakes.exec.mock.invocationCallOrder[0]).toBeLessThan(
    fakes.webgl.mock.invocationCallOrder[0] ?? 0,
  );
});

it('reuses only a complete build and still checks WebGL2 when explicitly requested', async () => {
  vi.stubEnv('E2E_SKIP_BUILD', '1');
  await globalSetup();
  expect(fakes.exec).not.toHaveBeenCalled();
  expect(fakes.webgl).toHaveBeenCalledOnce();
  for (const missing of ['.vite/renderer/main_window/index.html', 'dist-cli/corrallm.cjs']) {
    fakes.exists.mockImplementation((file) => !String(file).endsWith(path.normalize(missing)));
    await expect(async () => globalSetup()).rejects.toThrow(/No (production build|CLI bundle)/);
  }
  expect(fakes.webgl).toHaveBeenCalledOnce();
});

it('refuses to start the suite when the WebGL2 preflight fails', async () => {
  fakes.webgl.mockRejectedValueOnce(new Error('E2E WebGL2 preflight failed'));
  await expect(async () => globalSetup()).rejects.toThrow('E2E WebGL2 preflight failed');
});
