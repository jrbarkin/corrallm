import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

import { mainDefine, NATIVE_EXTERNALS, PREFIX_ONLY_BUILTINS } from './vite.main.config.mts';

/**
 * The `corrallm` CLI (src/main/cli/index.ts), the core's code for plain Node: `pnpm build:cli`
 * builds it into dist-cli/corrallm.cjs, outside .vite/, which Forge empties on every `pnpm dev`
 * and `pnpm package`. Built as Forge builds main (a CommonJS library, Node's built-ins and the
 * native modules external) with main's defines: the Agent SDK needs `import.meta.url`'s.
 */
export default defineConfig({
  define: mainDefine,
  publicDir: false,
  resolve: {
    // Node's entries, as Forge resolves main's.
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  plugins: [noElectron()],
  build: {
    outDir: 'dist-cli',
    emptyOutDir: true,
    // Readable stack traces: the CLI is a development tool, not shipped.
    minify: false,
    lib: {
      entry: 'src/main/cli/index.ts',
      formats: ['cjs'],
      fileName: () => 'corrallm.cjs',
    },
    rollupOptions: {
      external: [
        ...builtinModules.flatMap((name) => [name, `node:${name}`]),
        ...NATIVE_EXTERNALS,
        ...PREFIX_ONLY_BUILTINS,
      ],
    },
  },
});

/** Plain Node has no Electron: the build fails if the CLI's code imports it. */
function noElectron(): Plugin {
  return {
    name: 'corrallm:no-electron',
    resolveId(id) {
      if (id === 'electron' || id.startsWith('electron/')) {
        this.error(`The CLI runs under plain Node: it cannot import “${id}”.`);
      }
      return null;
    },
  };
}
