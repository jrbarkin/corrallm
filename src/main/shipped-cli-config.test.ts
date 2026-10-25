import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type * as Files from 'node:fs/promises';
import { createRequire } from 'node:module';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  exec: vi.fn(
    (
      _: unknown,
      __: unknown,
      ___: unknown,
      done?: (error: null, stdout: string, stderr: string) => void,
    ) => {
      const callback =
        typeof ___ === 'function'
          ? (___ as (error: null, stdout: string, stderr: string) => void)
          : done;
      if (callback === undefined) throw new Error('Expected an execFile callback');
      callback(null, '', '');
    },
  ),
  constructor: vi.fn(function (options: unknown) {
    return { config: options };
  }),
  copy: vi.fn(() => Promise.resolve()),
  ship: vi.fn(() => Promise.resolve()),
  readdir: vi.fn(() => Promise.resolve(['corrallm.app'])),
}));
vi.mock('electron', () => ({}));
vi.mock('node:child_process', () => ({ execFile: fakes.exec }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Files>()),
  readdir: fakes.readdir,
}));
vi.mock('../../build/native-modules', () => ({
  NATIVE_MODULES: { 'node-pty': { files: [], buildOnlyDependencies: [] } },
  copyNativeModule: fakes.copy,
}));
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
  vi.stubEnv('CORRALLM_E2E_BUILD', undefined);
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
    process.execPath,
    [
      path.join(
        path.dirname(createRequire(import.meta.url).resolve('vite/package.json')),
        'bin/vite.js',
      ),
      'build',
      '--config',
      'vite.cli.config.mts',
    ],
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

it.each([
  ['1', '1', false],
  ['1', undefined, true],
  ['0', '1', true],
])(
  'skips shipped files only for an unsigned e2e build (unsigned: %s, e2e: %s)',
  async (unsigned, e2e, ship) => {
    vi.stubEnv('CORRALLM_UNSIGNED', unsigned);
    vi.stubEnv('CORRALLM_E2E_BUILD', e2e);
    const { default: config } = await import('../../forge.config.mjs');
    await Reflect.apply(config.hooks.packageAfterCopy, undefined, [
      {},
      '/example/Resources/app',
      '',
      'darwin',
      'arm64',
    ]);
    expect(fakes.copy).toHaveBeenCalledWith(
      'node-pty',
      expect.any(Object),
      '/example/Resources/app',
      'darwin',
      'arm64',
    );
    expect(fakes.ship).toHaveBeenCalledTimes(ship ? 1 : 0);
  },
);

it.skipIf(process.platform !== 'darwin').each([false, true])(
  'ad-hoc signs the app, and its Node only when shipped (e2e: %s)',
  async (e2e) => {
    vi.stubEnv('CORRALLM_UNSIGNED', '1');
    vi.stubEnv('CORRALLM_E2E_BUILD', e2e ? '1' : undefined);
    const { default: config } = await import('../../forge.config.mjs');
    await Reflect.apply(config.hooks.postPackage, undefined, [
      {},
      { platform: 'darwin', outputPaths: ['/example/output'] },
    ]);
    const calls = fakes.exec.mock.calls.map(([, args]) => args as string[]);
    const app = '/example/output/corrallm.app';
    expect(
      calls.filter((args) => args.includes(`${app}/Contents/Resources/cli/node`)),
    ).toHaveLength(e2e ? 0 : 1);
    expect(calls.at(-1)).toEqual([
      '--preserve-metadata=entitlements',
      '--force',
      '--deep',
      '--sign',
      '-',
      app,
    ]);
  },
);

it('never excludes an absent dependency from native rebuilds', async () => {
  const { default: config } = await import('../../forge.config.mjs');
  const { dependencies } = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(config.rebuildConfig.ignoreModules.filter((name) => !(name in dependencies))).toEqual([]);
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

it('requires the linked audio library even with optional dependencies disabled, and no process tools', async () => {
  await import('../../forge.config.mjs');
  const options = fakes.constructor.mock.calls.map(
    ([one]) => one as { options?: { depends?: string[]; requires?: string[] } },
  );
  // Linux process identity reads /proc (process-identity.ts); only macOS runs ps.
  expect(options.flatMap((one) => one.options?.depends ?? [])).toEqual([
    'libasound2t64 | libasound2',
  ]);
  expect(options.flatMap((one) => one.options?.requires ?? [])).toEqual(['alsa-lib']);
});
