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

// Merged by Forge with its defaults (CJS output in .vite/build, Node builtins and electron
// external). Native modules must stay external: they load .node binaries relative to their
// own files, so they ship in node_modules instead (see NATIVE_MODULES in forge.config.mts).
export default defineConfig(({ command }) => ({
  // The bundle is CommonJS, where import.meta is not: modules that find their own file through
  // it (the Agent SDK does) get the bundle's file instead.
  define: {
    'import.meta.url': 'require("node:url").pathToFileURL(__filename).href',
    CORRALLM_DISTRIBUTION: JSON.stringify(distribution),
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
    // Source maps for debugging under `electron-forge start` only; never shipped.
    sourcemap: command === 'serve',
  },
}));
