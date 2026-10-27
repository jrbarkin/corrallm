import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/*
 * The boundaries kept in src/main, and around shared model code and the core engine: what ESLint
 * lets each file import (eslint.config.ts), checked on fixtures, as the config resolved for each
 * path says; and, scanned, which files import Electron, which mint trusted paths, and what shared
 * code imports.
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

/** Every file of main but its tests and their helpers (test-*.ts), by its path from the root. */
function mainFiles(dir = 'src/main'): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return mainFiles(file);
    const test = entry.name.endsWith('.test.ts') || entry.name.startsWith('test-');
    return entry.name.endsWith('.ts') && !test ? [file] : [];
  });
}
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** Every TypeScript file of a folder, tests and their helpers included, by its path from the root. */
function filesIn(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return filesIn(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** What `file` imports: its imports' and re-exports' specifiers, as written. */
function importsOf(file: string): string[] {
  const text = read(file);
  return [
    ...text.matchAll(/^(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...text.matchAll(/^import\s*['"]([^'"]+)['"]/gm),
  ].flatMap(([, from]) => (from === undefined ? [] : [from]));
}

/** Every file of the repository's own that `entry` loads as it runs: what it imports, but types. */
function loadedBy(entry: string, seen = new Set<string>()): string[] {
  seen.add(entry);
  const text = read(entry);
  for (const [, from] of [
    ...text.matchAll(/^(?:import|export)(?!\s+type\b)[^;'"]*?\bfrom\s*['"](\.[^'"]+)['"]/gm),
    ...text.matchAll(/^import\s*['"](\.[^'"]+)['"]/gm),
  ]) {
    if (from === undefined) continue;
    const base = path.posix.join(path.posix.dirname(entry), from);
    const file = [`${base}.ts`, `${base}/index.ts`].find((candidate) =>
      existsSync(path.join(ROOT, candidate)),
    );
    if (file !== undefined && !seen.has(file)) loadedBy(file, seen);
  }
  return [...seen];
}

describe('ESLint’s boundaries in main', () => {
  it('keeps platform files from importing an adapter’s folder', async () => {
    for (const [file, from] of [
      ['src/main/files.ts', './sessions/claude-code/sdk/conversations'],
      ['src/main/sessions/environment.ts', './codex/codex'],
      ['src/main/sessions/terminal/session.ts', '../claude-code/sdk/tools'],
      ['src/main/api/mcp.ts', '../sessions/codex/login'],
      ['src/main/settings.ts', './sessions/codex/login'],
      ['src/main/ipc.ts', './sessions/claude-code/adapter'],
      ['src/main/sessions/terminal/session.ts', '../claude-code/adapter'],
      ['src/main/sessions/manager.ts', './claude-code/sdk/conversations'],
      ['src/main/core/selftest.ts', '../sessions/claude-code/sdk/inbox'],
      ['src/main/sessions/connectors.ts', './codex/terminal/connector'],
      ['src/main/files.ts', './sessions/acp/adapter'],
      ['src/main/sessions/environment.ts', './muse/adapter'],
      ['src/main/sessions/environment.ts', './codex'],
    ] as const) {
      expect(await importErrors(file, `import type { A } from '${from}';\n`)).toEqual([
        expect.stringContaining('adapter’s folder'),
      ]);
    }
  });

  it('keeps adapters from importing each other, including types', async () => {
    for (const [file, from] of [
      ['src/main/sessions/claude-code/sdk/session.ts', '../../codex/codex'],
      ['src/main/sessions/codex/app-server/session.ts', '../../claude-code/sdk/tools'],
      ['src/main/sessions/acp/adapter.ts', '../muse/adapter'],
      ['src/main/sessions/muse/session.ts', '../acp/adapter'],
      ['src/main/sessions/claude-code/adapter.ts', '../codex'],
    ] as const) {
      expect(await importErrors(file, `import type { A } from '${from}';\n`)).toEqual([
        expect.stringContaining('adapter’s folder'),
      ]);
    }
  });

  it('lets the registry import adapters, and each adapter import its own files and the toolkit', async () => {
    for (const [file, from] of [
      ['src/main/sessions/adapters.ts', './claude-code/adapter'],
      ['src/main/sessions/adapters.ts', './codex/adapter'],
      ['src/main/sessions/claude-code/adapter.ts', './sdk/session'],
      ['src/main/sessions/claude-code/sdk/session.ts', '../../terminal/hooks'],
      ['src/main/sessions/codex/app-server/session.ts', '../terminal/tui'],
      ['src/main/sessions/codex/terminal/tui.ts', '../../terminal/screen'],
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

  it('keeps the registry (src/shared/api/) to plain code: no main, Node or Electron', async () => {
    for (const from of ['../../main/core/call', 'node:crypto', 'electron']) {
      expect(
        await importErrors('src/shared/api/registry.ts', `import { a } from '${from}';\n`),
        from,
      ).toHaveLength(1);
    }
    expect(await importErrors('src/shared/api/registry.ts', "import { z } from 'zod';\n")).toEqual(
      [],
    );
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
      await importErrors('src/main/host/dialogs.ts', "import { dialog } from 'electron';\n"),
    ).toEqual([]);
  });
});

describe('ESLint’s boundary around shared code', () => {
  const SHARED_ERROR = 'Shared code never imports the renderer or React Flow';

  it('keeps the model and its tests from the renderer and React Flow', async () => {
    for (const [file, from] of [
      ['src/shared/model/words.ts', '../../renderer/graph/graph'],
      ['src/shared/model/file.ts', '@xyflow/system'],
      ['src/shared/model/valid.test.ts', '../../renderer/test-setup'],
    ] as const) {
      const errors = await importErrors(file, `import type { A } from '${from}';\n`);
      expect(
        errors.filter((error) => error.includes(SHARED_ERROR)),
        `${file} importing ${from}`,
      ).toHaveLength(1);
    }
  });

  it('lets the core engine read the model, the catalog it is given and the shared types', async () => {
    expect(
      await importErrors(
        'src/main/core/engine/run/runner.ts',
        "import type { AgentNode } from '../../../../shared/model/canvas';\n" +
          "import type { EngineCatalog } from '../../../../shared/model/catalog';\n" +
          "import { agentName } from '../../../../shared/model/queries';\n" +
          "import type { AgentAction } from '../../../../shared/adapter';\n",
      ),
    ).toEqual([]);
  });

  it('lets the renderer use shared view queries, React Flow, its own tables and the catalog it loaded', async () => {
    expect(
      await importErrors(
        'src/renderer/graph/edits.ts',
        "import type { Node } from '@xyflow/react';\nimport { actionsOf } from './agents';\n" +
          "import { catalog } from '../catalog';\n" +
          "import { heldAsks } from '../../shared/model/run-words';\n",
      ),
    ).toEqual([]);
  });

  it('keeps engine execution and helpers out of the renderer and shared model', async () => {
    for (const file of ['src/renderer/graph/edits.ts', 'src/shared/model/run-words.ts']) {
      const errors = await importErrors(
        file,
        "import { Engine } from '../../main/core/engine/engine';\n",
      );
      expect(errors.filter((e) => e.includes('must not import main'))).toHaveLength(1);
    }
    for (const file of [
      'src/main/core/engine/run/runner.ts',
      'src/main/core/engine/test-backend.ts',
      'src/main/core/engine/run/runner.test.ts',
    ]) {
      for (const from of ['../../../../renderer/catalog', '@xyflow/react']) {
        const errors = await importErrors(file, `import type { A } from '${from}';\n`);
        expect(
          errors.filter((e) => e.includes('Core code never imports the renderer')),
        ).toHaveLength(1);
      }
    }
  });

  it('imports nothing of the renderer or React Flow anywhere in shared code', () => {
    const files = filesIn('src/shared');
    expect(files).toContain('src/shared/model/run-words.ts');
    for (const file of files) {
      expect(
        importsOf(file).filter((from) => {
          if (from.startsWith('@xyflow/')) return true;
          if (!from.startsWith('.')) return false;
          const found = path.posix.normalize(path.posix.join(path.posix.dirname(file), from));
          return found.startsWith('src/renderer/');
        }),
        file,
      ).toEqual([]);
    }
  });
});

describe('main’s files', () => {
  it('loads the update checker only in the app, never the CLI or core process', () => {
    for (const entry of ['src/main/cli/main.ts', 'src/main/core/entry.ts']) {
      expect(loadedBy(entry)).not.toContain('src/main/updates.ts');
      expect(loadedBy(entry)).not.toContain('src/main/host/updates.ts');
    }
    expect(loadedBy('src/main/index.ts')).toContain('src/main/host/updates.ts');
  });
  it('import Electron only in the host and the app’s own entry, window and security', () => {
    const importers = mainFiles().filter((file) => read(file).includes("from 'electron'"));
    const allowed = [
      'src/main/index.ts',
      'src/main/window.ts',
      'src/main/security.ts',
      'src/main/app-protocol.ts',
      'src/main/ipc.ts',
      'src/main/native-selftest.ts',
    ];
    expect(
      importers.filter((file) => !file.startsWith('src/main/host/') && !allowed.includes(file)),
    ).toEqual([]);
  });

  it('make a human caller only for a window’s port main made: no token, agent or page is you', () => {
    const makers = mainFiles().filter((file) => /\basHuman\b/.test(read(file)));
    expect(makers).toEqual(['src/main/core/gui.ts']);
    // Loaded only in the core process, whose parentPort only main posts to: under plain Node (the
    // CLI) no human caller can exist.
    const loaders = mainFiles().filter((file) =>
      importsOf(file).some(
        (from) => path.posix.join(path.posix.dirname(file), from) === 'src/main/core/gui',
      ),
    );
    expect(loaders).toEqual(['src/main/core/entry.ts']);
  });

  it('compose the profile’s stores only in the core process', () => {
    const stores = [
      'src/main/memory.ts',
      'src/main/settings.ts',
      'src/main/usage.ts',
      'src/main/run-journal.ts',
      'src/main/core/tokens.ts',
      'src/main/core/core.ts',
      'src/main/core/engines.ts',
      'src/main/sessions/manager.ts',
    ];
    expect(loadedBy('src/main/core/entry.ts')).toEqual(expect.arrayContaining(stores));
    expect(loadedBy('src/main/index.ts').filter((file) => stores.includes(file))).toEqual([]);
  });

  it('make a temporary index only in the merge service’s private folder, and point Git at no other', () => {
    // B9b §9 C6: GIT_INDEX_FILE is set only to a path made there, never from a caller's string.
    const minting = mainFiles().filter((file) => /\bas TemporaryIndex\b/.test(read(file)));
    expect(minting).toEqual(['src/main/core/workspaces/merge-index.ts']);
    const index = read('src/main/core/workspaces/merge-index.ts');
    expect(index.match(/\bas TemporaryIndex\b/g)).toHaveLength(1);
    expect(mainFiles().filter((file) => /GIT_INDEX_FILE\s*[:=]/.test(read(file)))).toEqual([
      'src/main/core/workspaces/git.ts',
    ]);
  });

  it('mint trusted paths only from the host’s dialog answers in the core, the stores reading back what they wrote, and verified workspace checkouts', () => {
    const minting = mainFiles().filter((file) => read(file).includes('mintTrustedPath('));
    expect(minting.sort()).toEqual([
      'src/main/core/host.ts',
      'src/main/core/host/app.ts',
      // A workspace's checkout, minted only once it is verified, at every use, as the one the
      // core made of the picked repository in the folder it owns there (B9a Design §2).
      'src/main/core/workspaces/checkout.ts',
      'src/main/memory.ts',
      'src/main/run-journal.ts',
    ]);
    expect(minting.filter((file) => file.startsWith('src/main/cli/'))).toEqual([]);
    // There, only `verifiedCheckout` mints, after `checkCheckout`.
    const checkout = read('src/main/core/workspaces/checkout.ts');
    expect(checkout.match(/mintTrustedPath\(/g)).toHaveLength(1);
    expect(
      /export async function verifiedCheckout[\s\S]*checkCheckout\([\s\S]*if \(!checked\.ok\) return checked;[\s\S]*mintTrustedPath\(checked\.checkout\.path\)/.test(
        checkout,
      ),
    ).toBe(true);
  });
});
