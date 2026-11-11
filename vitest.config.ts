import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// One project per process type. Inline projects inherit this root config and arrays such as
// `include` are concatenated, so keep environment-specific options inside each project.
export default defineConfig({
  test: {
    // Locally leave 40% of the cores to the rest of the machine: all of them peg a laptop and turn
    // timing-sensitive tests red. CI keeps Vitest's default (every core of a runner that is ours).
    ...(process.env.CI ? {} : { maxWorkers: '60%' }),
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
          exclude: ['src/main/core/store/snapshots-loop.test.ts'],
          // Builds the CLI bundle the tests of `corrallm serve` run.
          globalSetup: ['./src/main/cli/global-setup.ts'],
        },
      },
      // The same suites with every store on the writer's thread (Store Writer, step 6a), opt-in:
      // CORRALLM_STORE_WRITER=1 pnpm exec vitest run --project main-writer
      ...(process.env.CORRALLM_STORE_WRITER === '1'
        ? [
            {
              test: {
                name: 'main-writer',
                environment: 'node' as const,
                include: [
                  'src/main/core/**/*.test.ts',
                  'src/main/{memory,run-journal,canvas,project}.test.ts',
                ],
                exclude: ['src/main/core/store/snapshots-loop.test.ts'],
                setupFiles: ['./src/main/core/store/test-writer-matrix.ts'],
              },
            },
          ]
        : []),
      {
        test: {
          name: 'store-performance',
          environment: 'node',
          include: ['src/main/core/store/snapshots-loop.test.ts'],
          // Disk/loop measurements must not compete with the suite's parallel workers.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
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
