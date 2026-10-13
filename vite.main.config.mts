import { defineConfig } from 'vite';

// Merged by Forge with its defaults (CJS output in .vite/build, Node builtins and electron
// external). Native modules must stay external: they load .node binaries relative to their
// own files, so they ship in node_modules instead (see NATIVE_MODULES in forge.config.mts).
export default defineConfig(({ command }) => ({
  // The bundle is CommonJS, where import.meta is not: modules that find their own file through
  // it (the Agent SDK does) get the bundle's file instead.
  define: {
    'import.meta.url': 'require("node:url").pathToFileURL(__filename).href',
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
    // Source maps for debugging under `electron-forge start` only; never shipped.
    sourcemap: command === 'serve',
  },
}));
