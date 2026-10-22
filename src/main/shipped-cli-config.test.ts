import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  exec: vi.fn(
    (
      _: unknown,
      __: unknown,
      ___: unknown,
      done: (error: null, stdout: string, stderr: string) => void,
    ) => {
      done(null, '', '');
    },
  ),
  constructor: vi.fn(function (options: unknown) {
    return { config: options };
  }),
  copy: vi.fn(() => Promise.resolve()),
  ship: vi.fn(() => Promise.resolve()),
}));
vi.mock('electron', () => ({}));
vi.mock('node:child_process', () => ({ execFile: fakes.exec }));
vi.mock('../../build/native-modules', () => ({ NATIVE_MODULES: {}, copyNativeModule: fakes.copy }));
vi.mock('../../build/shipped-cli', () => ({
  LINUX_CLI_BIN: 'resources/bin/corrallm',
  shipCli: fakes.ship,
}));
vi.mock('@electron-forge/maker-deb', () => ({ MakerDeb: fakes.constructor }));
vi.mock('@electron-forge/maker-dmg', () => ({ MakerDMG: fakes.constructor }));
vi.mock('@electron-forge/maker-rpm', () => ({ MakerRpm: fakes.constructor }));
vi.mock('@electron-forge/maker-squirrel', () => ({ MakerSquirrel: fakes.constructor }));
vi.mock('@electron-forge/maker-zip', () => ({ MakerZIP: fakes.constructor }));
vi.mock('@electron-forge/plugin-fuses', () => ({ FusesPlugin: fakes.constructor }));
vi.mock('@electron-forge/plugin-vite', () => ({ VitePlugin: fakes.constructor }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('APPLE_SIGNING_IDENTITY', 'test identity');
  vi.stubEnv('CORRALLM_UNSIGNED', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('builds the CLI before packaging, then stages its external files beside Resources/app', async () => {
  const { default: config } = await import('../../forge.config.mjs');
  expect(config.hooks.prePackage).toBeTypeOf('function');
  // Forge supplies a resolved config; these hooks read none of its fields.
  await Reflect.apply(config.hooks.prePackage, undefined, []);
  expect(fakes.exec).toHaveBeenCalledWith(
    'pnpm',
    ['build:cli'],
    expect.objectContaining({ cwd: expect.any(String) as string }),
    expect.any(Function),
  );
  await Reflect.apply(config.hooks.packageAfterCopy, undefined, [
    {},
    '/tmp/example/Resources/app',
    '',
    'darwin',
    'arm64',
  ]);
  expect(fakes.ship).toHaveBeenCalledWith('/tmp/example/Resources/app', 'darwin', 'arm64');
});

it('gives the bundled Node JIT alone under the hardened runtime, without relaxing its host app', async () => {
  const { default: config } = await import('../../forge.config.mjs');
  const sign = config.packagerConfig.osxSign;
  if (!sign || typeof sign === 'boolean') throw new Error('Expected test signing configuration');
  const node = sign.optionsForFile?.('/My.app/Contents/Resources/cli/node', { platform: 'darwin' });
  expect(node).toMatchObject({
    hardenedRuntime: true,
    entitlements: expect.stringMatching(/entitlements\.node\.plist$/) as string,
  });
  const entitlements = await readFile(path.resolve('build/entitlements.node.plist'), 'utf8');
  expect([...entitlements.matchAll(/<key>(.*?)<\/key>/g)].map((one) => one[1])).toEqual([
    'com.apple.security.cs.allow-jit',
  ]);
});

it('makes the Linux command symlink target the launcher while the desktop still opens the GUI', async () => {
  await import('../../forge.config.mjs');
  const options = fakes.constructor.mock.calls.map(
    ([one]) => one as { options?: { bin?: string; desktopTemplate?: string } },
  );
  const installers = options.filter((one) => one.options?.bin === 'resources/bin/corrallm');
  expect(installers).toHaveLength(2);
  for (const { options: installer } of installers) {
    const template = await readFile(installer?.desktopTemplate ?? '', 'utf8');
    expect(template).toContain('Exec=/usr/lib/<%= name %>/corrallm %U');
  }
});
