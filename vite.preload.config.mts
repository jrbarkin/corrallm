import { defineConfig } from 'vite';

// Forge forces a single CJS file (.vite/build/preload.cjs), which sandboxed preloads require.
export default defineConfig(({ command }) => ({
  build: {
    // Source maps for debugging under `electron-forge start` only; never shipped.
    sourcemap: command === 'serve',
  },
}));
