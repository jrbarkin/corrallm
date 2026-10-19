import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

/**
 * How the build is offered (src/main/sessions/codex/login.ts): an app the user runs locally, as
 * corrallm is by default, or a commercial or hosted product (CORRALLM_DISTRIBUTION=commercial or
 * hosted), which may not run Codex's app server on a ChatGPT login.
 */
const DISTRIBUTIONS = ['local', 'commercial', 'hosted'];
const distribution = process.env.CORRALLM_DISTRIBUTION ?? 'local';
if (!DISTRIBUTIONS.includes(distribution)) {
  throw new Error(`CORRALLM_DISTRIBUTION must be one of ${DISTRIBUTIONS.join(', ')}`);
}

/** corrallm's version, as package.json says: what the CLI's core says it is (app.info). */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

/** What main's bundles (main.cjs, core.cjs) define, and the CLI's too (vite.cli.config.mts). */
export const mainDefine = {
  // The bundles are CommonJS, where import.meta is not: modules that find their own file through
  // it (the Agent SDK does) get the bundle's file instead.
  'import.meta.url': 'require("node:url").pathToFileURL(__filename).href',
  CORRALLM_DISTRIBUTION: JSON.stringify(distribution),
  CORRALLM_VERSION: JSON.stringify(version),
};

/** Native modules stay external: they load .node binaries relative to their own files. */
export const NATIVE_EXTERNALS = ['node-pty'];

// Merged by Forge with its defaults (CJS output in .vite/build, Node builtins and electron
// external). Native modules ship in node_modules instead (see NATIVE_MODULES in forge.config.mts).
export default defineConfig(({ command }) => ({
  define: mainDefine,
  build: {
    rollupOptions: {
      external: NATIVE_EXTERNALS,
    },
    // Source maps for debugging under `electron-forge start` only; never shipped.
    sourcemap: command === 'serve',
  },
}));
