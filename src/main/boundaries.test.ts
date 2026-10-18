import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/*
 * The boundaries kept in src/main: what ESLint lets each file import (eslint.config.ts), checked on
 * fixtures, as the config resolved for each path says; and, scanned, which files import Electron
 * and which mint trusted paths.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });
const RULES = ['no-restricted-imports', '@typescript-eslint/no-restricted-imports'] as const;

/** The import errors ESLint's config gives `code` at `file` (a path from the repository's root). */
async function importErrors(file: string, code: string): Promise<string[]> {
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, Linter.RuleEntry>;
  };
  const rules = Object.fromEntries(
    RULES.flatMap((rule) => {
      const entry = config.rules?.[rule];
      return entry === undefined ? [] : [[rule, entry]];
    }),
  );
  return new Linter({ cwd: ROOT })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { '@typescript-eslint': tseslint.plugin },
          rules,
        },
      ],
      { filename: path.join(ROOT, file) },
    )
    .map((message) => message.message);
}

/** Every file of main but its tests, by its path from the repository's root. */
function mainFiles(dir = 'src/main'): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return mainFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('ESLint’s boundaries in main', () => {
  it('keeps platform files from importing an adapter’s folder', async () => {
    for (const [file, from] of [
      ['src/main/files.ts', './sessions/sdk/conversations'],
      ['src/main/sessions/environment.ts', './codex/codex'],
      ['src/main/sessions/terminal/session.ts', '../sdk/tools'],
      ['src/main/api/mcp.ts', '../sessions/codex/login'],
      ['src/main/settings.ts', './sessions/codex/login'],
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

  it('keeps the core from importing Electron or the host (app/boundaries-core)', async () => {
    for (const [file, host] of [
      ['src/main/core/call.ts', '../host/windows'],
      ['src/main/sessions/manager.ts', '../host/windows'],
      ['src/main/sessions/terminal/session.ts', '../../host/dialogs'],
      ['src/main/api/mcp.ts', '../host/services'],
      ['src/main/cli/serve.ts', '../host/windows'],
      ['src/main/memory.ts', './host/dialogs'],
      ['src/main/settings.ts', './host/services'],
      ['src/main/run-journal.ts', './host/windows'],
    ] as const) {
      const errors = await importErrors(
        file,
        `import { app } from 'electron';\nimport type { WebContents } from 'electron';\n` +
          `import { x } from '${host}';\n`,
      );
      expect(errors.filter((error) => error.includes('never imports Electron'))).toHaveLength(2);
      expect(errors.filter((error) => error.includes('never imports the host'))).toHaveLength(1);
    }
  });

  it('lets the core import what it asks the host for, and the host import Electron', async () => {
    expect(
      await importErrors('src/main/core/call.ts', "import type { HostServices } from './host';\n"),
    ).toEqual([]);
    expect(
      await importErrors(
        'src/main/canvas.ts',
        "import type { HostServices } from './core/host';\n",
      ),
    ).toEqual([]);
    expect(
      await importErrors(
        'src/main/host/dialogs.ts',
        "import { dialog } from 'electron';\nimport { mintTrustedPath } from '../core/host';\n",
      ),
    ).toEqual([]);
  });
});

describe('main’s files', () => {
  it('import Electron only in the host and the app’s own entry, window and security', () => {
    const importers = mainFiles().filter((file) => read(file).includes("from 'electron'"));
    const allowed = [
      'src/main/index.ts',
      'src/main/window.ts',
      'src/main/security.ts',
      'src/main/app-protocol.ts',
      'src/main/ipc.ts',
      'src/main/run-shutdown.ts',
      'src/main/native-selftest.ts',
    ];
    expect(
      importers.filter((file) => !file.startsWith('src/main/host/') && !allowed.includes(file)),
    ).toEqual([]);
  });

  it('mint trusted paths only from the dialogs and the stores reading back what they wrote', () => {
    const minting = mainFiles().filter((file) => read(file).includes('mintTrustedPath('));
    expect(minting.sort()).toEqual([
      'src/main/core/host.ts',
      'src/main/host/dialogs.ts',
      'src/main/memory.ts',
      'src/main/run-journal.ts',
    ]);
    expect(minting.filter((file) => file.startsWith('src/main/cli/'))).toEqual([]);
  });
});
