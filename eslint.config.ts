import { builtinModules } from 'node:module';

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import { reactRefresh } from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = builtinModules.flatMap((name) =>
  name.startsWith('node:') ? [name] : [name, `node:${name}`],
);

export default defineConfig(
  globalIgnores([
    '.vite/',
    '.delegate/',
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
  // Process boundaries (see CLAUDE.md). Core no-restricted-imports also catches `import type`.
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
                'Renderer and shared code must not import Electron. Go through window.api and src/shared/ipc.ts.',
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
    name: 'app/javascript',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  // Last: turns off stylistic rules that conflict with Prettier.
  eslintConfigPrettier,
);
