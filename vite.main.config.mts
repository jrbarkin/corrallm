import { defineConfig } from 'vite';

// Merged by Forge with its defaults (CJS output in .vite/build, Node builtins and electron
// external). Native modules must stay external: they load .node binaries relative to their
// own files, so they ship in node_modules instead (see NATIVE_MODULES in forge.config.mts).
export default defineConfig(({ command }) => ({
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
    // Source maps for debugging under `electron-forge start` only; never shipped.
    sourcemap: command === 'serve',
  },
}));
