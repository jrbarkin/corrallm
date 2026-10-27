import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm, type MakerRpmConfigOptions } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig, ForgePackagerOptions } from '@electron-forge/shared-types';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { copyNativeModule, NATIVE_MODULES } from './build/native-modules.js';
import { shipCli, LINUX_CLI_BIN } from './build/shipped-cli.js';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
// Invoke Vite through Node: pnpm's Windows .cmd shim cannot be spawned with execFile.
const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');

// extraResource keeps notices visible outside app.asar. Stage the SDK's installed license under
// its own name on every build, so upgrades cannot leave a stale checked-in copy behind.
const agentSdkLicense = path.join(
  projectDir,
  'node_modules/.cache/corrallm-licenses/claude-agent-sdk-LICENSE.md',
);

// ---------------------------------------------------------------------------------------------
// Code signing: enabled only when credentials are present in the environment (see .env.example).
// A local, git-ignored .env file is loaded if it exists. Never commit credentials.
// ---------------------------------------------------------------------------------------------
const envFile = path.join(projectDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SIGNING_ENV = [
  'APPLE_SIGNING_IDENTITY',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'WINDOWS_CERTIFICATE_FILE',
  'WINDOWS_CERTIFICATE_PASSWORD',
] as const;

// CORRALLM_UNSIGNED=1 skips signing and notarization even when credentials are set (used by the
// e2e build, which only needs the Vite output).
const unsigned = process.env.CORRALLM_UNSIGNED === '1';
// e2e launches .vite/ with its own Electron; it never uses a packaged command or Node.
const e2eBuild = unsigned && process.env.CORRALLM_E2E_BUILD === '1';

const {
  APPLE_SIGNING_IDENTITY,
  APPLE_API_KEY,
  APPLE_API_KEY_ID,
  APPLE_API_ISSUER,
  APPLE_ID,
  APPLE_APP_SPECIFIC_PASSWORD,
  APPLE_TEAM_ID,
  WINDOWS_CERTIFICATE_FILE,
  WINDOWS_CERTIFICATE_PASSWORD,
} = process.env;

// Omit osxSign entirely (never `{}`) when unsigned: FusesPlugin treats any object as "signing
// configured" and skips its arm64 ad-hoc re-sign.
const osxSign: ForgePackagerOptions['osxSign'] | undefined =
  !unsigned && APPLE_SIGNING_IDENTITY
    ? {
        identity: APPLE_SIGNING_IDENTITY,
        // @electron/packager defaults to warning and shipping unsigned on failure.
        continueOnError: false,
        optionsForFile: (filePath: string) =>
          // Keep @electron/osx-sign's default entitlements for Electron's helper apps.
          /\((GPU|Renderer|Plugin)\)\.app/.test(filePath)
            ? {}
            : {
                entitlements: path.join(
                  projectDir,
                  filePath.endsWith('/Resources/cli/node')
                    ? 'build/entitlements.node.plist'
                    : 'build/entitlements.mac.plist',
                ),
                hardenedRuntime: true,
              },
      }
    : undefined;

const osxNotarize: ForgePackagerOptions['osxNotarize'] | undefined = !osxSign
  ? undefined
  : APPLE_API_KEY && APPLE_API_KEY_ID
    ? {
        appleApiKey: APPLE_API_KEY,
        appleApiKeyId: APPLE_API_KEY_ID,
        ...(APPLE_API_ISSUER ? { appleApiIssuer: APPLE_API_ISSUER } : {}),
      }
    : APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID
      ? { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
      : undefined;

// With `windowsSign: true`, @electron/windows-sign reads WINDOWS_CERTIFICATE_FILE and
// WINDOWS_CERTIFICATE_PASSWORD itself. Squirrel signs its installer with its own options.
const windowsCertificate =
  !unsigned && WINDOWS_CERTIFICATE_FILE && WINDOWS_CERTIFICATE_PASSWORD
    ? {
        certificateFile: WINDOWS_CERTIFICATE_FILE,
        certificatePassword: WINDOWS_CERTIFICATE_PASSWORD,
      }
    : undefined;

// ---------------------------------------------------------------------------------------------
// electron-installer-redhat 4.0.0's default spec fails on rpmbuild >= 4.20; build/rpm.spec.ejs
// carries the fix. Forge's option type omits specTemplate and desktopTemplate, which the
// installer still honors. The desktop entry opens the app, not the command linked in /usr/bin.
const rpmOptions: MakerRpmConfigOptions & { specTemplate: string; desktopTemplate: string } = {
  categories: ['Development'],
  // Electron links libasound. Linux process identity reads /proc, not ps.
  requires: ['alsa-lib'],
  bin: LINUX_CLI_BIN,
  desktopTemplate: path.join(projectDir, 'build/corrallm.desktop.ejs'),
  specTemplate: path.join(projectDir, 'build/rpm.spec.ejs'),
};

const config = {
  packagerConfig: {
    extraResource: [
      path.join(projectDir, 'NOTICE'),
      path.join(projectDir, 'LICENSE'),
      agentSdkLicense,
      path.join(projectDir, 'build/presence'),
    ],
    asar: {
      // Binaries must be real files on disk. JS stays packed (and integrity-checked).
      // `{.**,**}` keeps the globs matching when the staging path contains a dot-directory.
      unpack: '{**/{.**,**}/**/*.node,**/{.**,**}/**/node_modules/node-pty/prebuilds/**}',
    },
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
    ...(windowsCertificate ? { windowsSign: true as const } : {}),
    // TODO: set appBundleId (macOS) and icons before the first signed release.
  },
  rebuildConfig: {
    // These ship Node-API prebuilds that work in Electron as-is. Without this,
    // @electron/rebuild would recompile them from source.
    ignoreModules: ['node-pty'],
  },
  hooks: {
    generateAssets: async () => {
      await mkdir(path.dirname(agentSdkLicense), { recursive: true });
      await cp(
        path.join(projectDir, 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md'),
        agentSdkLicense,
      );
    },
    prePackage: async () => {
      await execFileAsync(process.execPath, [viteCli, 'build', '--config', 'vite.cli.config.mts'], {
        cwd: projectDir,
      });
    },
    preStart: () => {
      // `electron-forge start` passes its environment to the app and everything it spawns:
      // keep signing credentials (possibly loaded from .env) out of it.
      for (const name of SIGNING_ENV) Reflect.deleteProperty(process.env, name);
      return Promise.resolve();
    },
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      for (const [name, module] of Object.entries(NATIVE_MODULES)) {
        await copyNativeModule(name, module, buildPath, platform, arch);
      }
      if (!e2eBuild) await shipCli(buildPath, platform, arch);
    },
    postPackage: async (_config, { platform, outputPaths }) => {
      // Unsigned macOS builds keep Electron's original ad-hoc signature, which packager
      // invalidates when it rewrites Info.plist (Gatekeeper then calls the app "damaged").
      // Re-sign them ad hoc so they verify. Signed builds are handled by osxSign instead.
      if (osxSign || process.platform !== 'darwin' || !['darwin', 'mas'].includes(platform)) {
        return;
      }
      for (const outputPath of outputPaths) {
        for (const entry of await readdir(outputPath)) {
          if (!entry.endsWith('.app')) continue;
          // Keep the bundled Node's JIT entitlement when the enclosing unsigned app is re-signed.
          if (!e2eBuild) {
            await execFileAsync('codesign', [
              '--force',
              '--sign',
              '-',
              '--entitlements',
              path.join(projectDir, 'build/entitlements.node.plist'),
              path.join(outputPath, entry, 'Contents/Resources/cli/node'),
            ]);
          }
          await execFileAsync('codesign', [
            '--preserve-metadata=entitlements',
            '--force',
            '--deep',
            '--sign',
            '-',
            path.join(outputPath, entry),
          ]);
        }
      }
    },
  },
  makers: [
    new MakerDMG({}),
    new MakerZIP({}, ['darwin']),
    new MakerSquirrel({ ...windowsCertificate }),
    new MakerDeb({
      options: {
        categories: ['Development'],
        // The installer only recommends audio, which Electron links.
        depends: ['libasound2t64 | libasound2'],
        bin: LINUX_CLI_BIN,
        desktopTemplate: path.join(projectDir, 'build/corrallm.desktop.ejs'),
      },
    }),
    new MakerRpm({ options: rpmOptions }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        // Object entries name the outputs main.cjs / core.cjs / preload.cjs (all in .vite/build).
        { entry: { main: 'src/main/index.ts' }, config: 'vite.main.config.mts', target: 'main' },
        // The core process (an Electron utility process main forks): built as main is, with its
        // externals (node-pty) and defines.
        {
          entry: { core: 'src/main/core/entry.ts' },
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: { preload: 'src/preload/index.ts' },
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
    // Flipped at package time, before signing. Every fuse is set explicitly.
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Enforced on macOS and Windows; Electron has no ASAR integrity check on Linux.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      // The renderer is served from app://, so file:// needs no extra privileges.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    }),
  ],
} satisfies ForgeConfig;

export default config;
