import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
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

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromProject = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

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
                entitlements: path.join(projectDir, 'build/entitlements.mac.plist'),
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
// Native modules. The Vite plugin packages only `.vite/`, so every module the main process
// loads at runtime must be: (1) in package.json "dependencies", (2) externalized in
// vite.main.config.mts, (3) listed here so it is copied into the app, and (4) have its binaries
// covered by `asar.unpack` below.
// ---------------------------------------------------------------------------------------------
interface NativeModule {
  /** Top-level entries of the package needed at runtime. */
  files: readonly string[];
  /** Entries of the package's "dependencies" that are only needed to compile it. */
  buildOnlyDependencies: readonly string[];
}

const NATIVE_MODULES: Readonly<Record<string, NativeModule>> = {
  'node-pty': {
    files: ['package.json', 'LICENSE', 'lib', 'prebuilds'],
    buildOnlyDependencies: ['node-addon-api'],
  },
};

const DROPPED_FILES = /\.(pdb|map|d\.ts)$|\.test\.js$/;

async function copyNativeModule(
  name: string,
  module: NativeModule,
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  const source = path.dirname(requireFromProject.resolve(`${name}/package.json`));
  const destination = path.join(buildPath, 'node_modules', name);
  const target = `${platform === 'mas' ? 'darwin' : platform}-${arch}`;

  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).filter(
    (dependency) => !module.buildOnlyDependencies.includes(dependency),
  );
  if (runtimeDependencies.length > 0) {
    throw new Error(
      `${name} has runtime dependencies (${runtimeDependencies.join(', ')}) that are not copied ` +
        'into the package. Add them to NATIVE_MODULES in forge.config.mts.',
    );
  }

  for (const entry of module.files) {
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      filter: (file) => {
        if (DROPPED_FILES.test(file)) return false;
        // Keep only the prebuilt binaries for the platform being packaged.
        const [top, prebuild] = path.relative(source, file).split(path.sep);
        return top !== 'prebuilds' || prebuild === undefined || prebuild === target;
      },
    });
  }

  if (
    module.files.includes('prebuilds') &&
    !existsSync(path.join(destination, 'prebuilds', target))
  ) {
    throw new Error(`${name} ships no prebuilt binary for ${target}.`);
  }
}

// electron-installer-redhat 4.0.0's default spec fails on rpmbuild >= 4.20; build/rpm.spec.ejs
// carries the fix. Forge's option type omits specTemplate, which the installer still honors.
const rpmOptions: MakerRpmConfigOptions & { specTemplate: string } = {
  categories: ['Development'],
  specTemplate: path.join(projectDir, 'build/rpm.spec.ejs'),
};

const config = {
  packagerConfig: {
    extraResource: [
      path.join(projectDir, 'NOTICE'),
      path.join(projectDir, 'LICENSE'),
      agentSdkLicense,
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
    ignoreModules: ['node-pty', 'better-sqlite3'],
  },
  hooks: {
    generateAssets: async () => {
      await mkdir(path.dirname(agentSdkLicense), { recursive: true });
      await cp(
        path.join(projectDir, 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md'),
        agentSdkLicense,
      );
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
          await execFileAsync('codesign', [
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
    new MakerDeb({ options: { categories: ['Development'] } }),
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
