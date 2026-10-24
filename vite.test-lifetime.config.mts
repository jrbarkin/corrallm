import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'node_modules/.cache/test-lifetime',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'src/main/cli/test-lifetime-entry.ts',
      formats: ['es'],
      fileName: () => 'entry.mjs',
    },
    rolldownOptions: { platform: 'node', external: /^node:/, output: { codeSplitting: false } },
  },
});
