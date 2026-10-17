import { defineConfig } from 'vite';

// The `delegate` command (src/main/delegate/), bundled for Node to run from the repository
// (`pnpm delegate`). It is a tool for developing corrallm, never part of the app: Forge packages
// only .vite/, and this goes to .delegate/.
export default defineConfig({
  build: {
    ssr: 'src/main/delegate/bin.ts',
    outDir: '.delegate',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'delegate.mjs' } },
  },
  logLevel: 'warn',
});
