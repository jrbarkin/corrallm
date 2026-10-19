import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// One project per process type. Inline projects inherit this root config and arrays such as
// `include` are concatenated, so keep environment-specific options inside each project.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
          // Builds the CLI bundle the tests of `corrallm serve` run.
          globalSetup: ['./src/main/cli/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'preload',
          environment: 'node',
          include: ['src/preload/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/renderer/test-setup.ts'],
          // Contract tests read CSS as text; other styles stay disabled in jsdom.
          css: { include: [/(?:GraphEditor|AdapterLogo)\.css\?raw$/] },
        },
      },
    ],
  },
});
