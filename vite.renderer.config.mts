import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { DEV_CSP } from './src/main/csp.ts';

// Forge merges this over its renderer defaults (base './', dev server URL injection).
export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  build: {
    // outDir resolves against `root`, so it must be absolute once root moves.
    outDir: path.join(import.meta.dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
  plugins: [react()],
  // Development CSP, sent with every dev-server response. Production CSP is sent by the
  // app:// protocol handler in the main process.
  server: { headers: { 'Content-Security-Policy': DEV_CSP } },
});
