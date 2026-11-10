import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

import { mainDefine, NATIVE_EXTERNALS } from './vite.main.config.mts';

/**
 * The test-only bundle that seeds a throwaway profile for the packaged headless check
 * (scripts/lib/headless-smoke.sh): `pnpm build:seed` builds src/main/core/store/seed-profile-entry.ts
 * into dist-check/seed-profile.cjs, which the shipped Node runs by absolute path (an installed
 * package's image has no other Node). It is never packed into the app or a package.
 */
export default defineConfig({
  define: mainDefine,
  publicDir: false,
  resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
  build: {
    target: 'node24',
    outDir: 'dist-check',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'src/main/core/store/seed-profile-entry.ts',
      formats: ['cjs'],
      fileName: () => 'seed-profile.cjs',
    },
    rollupOptions: {
      output: { codeSplitting: false },
      external: [...builtinModules.flatMap((name) => [name, `node:${name}`]), ...NATIVE_EXTERNALS],
    },
  },
});
