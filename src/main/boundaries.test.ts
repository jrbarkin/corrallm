import path from 'node:path';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/*
 * The import boundaries ESLint keeps in src/main (eslint.config.ts), checked on fixtures: what each
 * file may import, as the config resolved for its path says.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });

/** The import errors ESLint's config gives `code` at `file` (a path from the repository's root). */
async function importErrors(file: string, code: string): Promise<string[]> {
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, Linter.RuleEntry>;
  };
  const rule = config.rules?.['no-restricted-imports'];
  if (rule === undefined) return [];
  return new Linter({ cwd: ROOT })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          rules: { 'no-restricted-imports': rule },
        },
      ],
      { filename: path.join(ROOT, file) },
    )
    .map((message) => message.message);
}

describe('ESLint’s boundaries in main', () => {
  it('keeps platform files from importing an adapter’s folder', async () => {
    for (const [file, from] of [
      ['src/main/files.ts', './sessions/sdk/conversations'],
      ['src/main/sessions/environment.ts', './codex/codex'],
      ['src/main/sessions/terminal/session.ts', '../sdk/tools'],
      ['src/main/api/mcp.ts', '../sessions/codex/login'],
    ] as const) {
      expect(await importErrors(file, `import type { A } from '${from}';\n`)).toEqual([
        expect.stringContaining('adapter’s folder'),
      ]);
    }
  });

  it('lets adapters, Claude’s own files and today’s importers import adapters’ folders', async () => {
    for (const [file, from] of [
      ['src/main/sessions/sdk/session.ts', '../codex/codex'],
      ['src/main/sessions/codex/app-server/session.ts', '../../sdk/tools'],
      ['src/main/sessions/terminal/claude-code.ts', '../sdk/tools'],
      ['src/main/sessions/claude-settings.ts', './sdk/session'],
      ['src/main/sessions/connectors.ts', './codex/terminal/connector'],
    ] as const) {
      expect(await importErrors(file, `import { a } from '${from}';\n`)).toEqual([]);
    }
  });

  it('lets platform files import the terminal toolkit and packages with an sdk folder', async () => {
    expect(
      await importErrors(
        'src/main/api/mcp.ts',
        "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
          "import { drop } from '../sessions/terminal/drop';\n",
      ),
    ).toEqual([]);
  });
});
