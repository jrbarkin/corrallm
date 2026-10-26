import { builtinModules } from 'node:module';

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import { reactRefresh } from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import type { Linter } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = builtinModules.flatMap((name) =>
  name.startsWith('node:') ? [name] : [name, `node:${name}`],
);

/** Adapter folders, including those reserved for future connections. */
const ADAPTERS = ['claude-code', 'codex', 'acp', 'muse'];
const adapterFolders = (names: readonly string[]) => ({
  regex: `(?:^|/)(?:${names.join('|')})(?:/|$)`,
  message:
    'Platform code must not import an adapter’s folder, and adapters never import each other: reach an adapter through sessions/adapters.ts.',
});
/** Remaining platform importers outside the registry; each must leave as it uses the seam. */
const ADAPTER_IMPORTERS: string[] = [];

/**
 * The core's side of main, which runs wherever it is hosted (main, the core process, plain Node;
 * src/main/core/host.ts): its folders, and the Electron-free services it uses. It never imports
 * Electron or the host (src/main/host/): what needs the desktop is a HostServices request.
 */
const CORE_FOLDERS = 'src/main/{core,sessions,api,cli}/**/*.ts';
const CORE_SERVICES =
  'src/main/{memory,settings,usage,files,git,canvas,project,run-journal,loopback,links,reveal,whole-file}.ts';
const ELECTRON = {
  group: ['electron', 'electron/*'],
  message:
    'The core never imports Electron: what needs the desktop is a HostServices request (src/main/core/host.ts).',
};
/** An import of the host's folder (`regex`: as written from a folder below main, or from main). */
const host = (regex: string) => ({
  regex,
  message: 'The core never imports the host (src/main/host/): it asks it through HostServices.',
});

/** Shared model and view helpers never depend on the renderer or React Flow. */
const SHARED_MESSAGE = 'Shared code never imports the renderer or React Flow.';
const RENDERER = { group: ['**/renderer/**', '@xyflow/*'], message: SHARED_MESSAGE };

export default defineConfig(
  globalIgnores([
    '.vite/',
    'dist-cli/',
    'out/',
    'coverage/',
    'playwright-report/',
    'test-results/',
  ]),
  {
    name: 'app/typescript',
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // Follows the tsconfig.json project references (node, web, tooling).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    name: 'app/node',
    files: ['src/main/**', 'src/preload/**', 'e2e/**', '*.config.{ts,mts}'],
    languageOptions: { globals: globals.node },
  },
  {
    name: 'app/renderer',
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite()],
    languageOptions: { globals: globals.browser },
    rules: {
      // Allow async handlers as JSX event props (onClick={async () => ...}).
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // Process boundaries (see AGENTS.md and docs/architecture/core.md). Core no-restricted-imports also catches `import type`.
  {
    name: 'app/boundaries-web',
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS,
          patterns: [
            {
              group: ['electron', 'electron/*'],
              message:
                'Renderer and shared code must not import Electron. Go through the generated window.api operations and topics.',
            },
            {
              group: ['**/main/**', '**/preload/**'],
              message: 'Renderer and shared code must not import main or preload code.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'app/boundaries-preload',
    files: ['src/preload/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message: 'The preload is sandboxed: it may import only electron and src/shared.',
          })),
          patterns: [
            {
              group: ['**/main/**', '**/renderer/**'],
              message: 'The preload must not import main or renderer code.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'app/adapters',
    files: ['src/main/**/*.ts'],
    ignores: [
      ...ADAPTERS.map((name) => `src/main/sessions/${name}/**`),
      'src/main/sessions/adapters.ts',
      '**/*.test.ts',
      ...ADAPTER_IMPORTERS,
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [adapterFolders(ADAPTERS)] }] },
  },
  ...ADAPTERS.map((name): Linter.Config => ({
    name: `app/adapter-${name}`,
    files: [`src/main/sessions/${name}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [adapterFolders(ADAPTERS.filter((other) => other !== name))] },
      ],
    },
  })),
  // typescript-eslint's rule, so that it applies beside app/adapters' (`import type` included).
  {
    name: 'app/boundaries-core',
    files: [CORE_FOLDERS],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            ELECTRON,
            host('^(?:\\.\\./)+host/'),
            {
              group: ['**/renderer/**', '@xyflow/*'],
              message: 'Core code never imports the renderer or React Flow.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'app/boundaries-core-services',
    files: [CORE_SERVICES],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [ELECTRON, host('^\\./host/')] },
      ],
    },
  },
  // typescript-eslint's rule, so that it applies beside app/boundaries-web's (`import type` included).
  {
    name: 'app/boundaries-shared',
    files: ['src/shared/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns: [RENDERER] }] },
  },
  {
    name: 'app/javascript',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  // Last: turns off stylistic rules that conflict with Prettier.
  eslintConfigPrettier,
);
