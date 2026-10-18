import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/*
 * The boundaries kept in src/main, and around the run in the renderer: what ESLint lets each file
 * import (eslint.config.ts), checked on fixtures, as the config resolved for each path says; and,
 * scanned, which files import Electron, which mint trusted paths, and what the run imports.
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

/** What `file` imports: its imports' and re-exports' specifiers, as written. */
function importsOf(file: string): string[] {
  const text = read(file);
  return [
    ...text.matchAll(/^(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...text.matchAll(/^import\s*['"]([^'"]+)['"]/gm),
  ].flatMap(([, from]) => (from === undefined ? [] : [from]));
}

/** The source file a relative import in `file` names (from the root), if it is one. */
function resolve(file: string, from: string): string | undefined {
  const base = path.posix.join(path.posix.dirname(file), from);
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find(
    (candidate) => /\.tsx?$/.test(candidate) && existsSync(path.join(ROOT, candidate)),
  );
}

/** Every source file `entries` import, themselves and their imports' imports included. */
function closure(entries: readonly string[]): Set<string> {
  const files = new Set(entries);
  for (const file of files) {
    for (const from of importsOf(file)) {
      const found = from.startsWith('.') ? resolve(file, from) : undefined;
      if (found !== undefined) files.add(found);
    }
  }
  return files;
}

/** The run and the sessions it sends to: the files B5b moves, and what they import comes along. */
const RUN_ENTRIES = [
  ...readdirSync(path.join(ROOT, 'src/renderer/run'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `src/renderer/run/${name}`),
  'src/renderer/agent/sessions.ts',
  'src/renderer/agent/connected.ts',
];

describe('ESLint’s boundaries in main', () => {
  it('keeps platform files from importing an adapter’s folder', async () => {
    for (const [file, from] of [
      ['src/main/files.ts', './sessions/sdk/conversations'],
      ['src/main/sessions/environment.ts', './codex/codex'],
      ['src/main/sessions/terminal/session.ts', '../sdk/tools'],
      ['src/main/api/mcp.ts', '../sessions/codex/login'],
      ['src/main/settings.ts', './sessions/codex/login'],
      ['src/main/ipc.ts', './sessions/claude-code/adapter'],
      ['src/main/sessions/terminal/session.ts', '../claude-code/adapter'],
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
      ['src/main/core/selftest.ts', '../sessions/sdk/inbox'],
      ['src/main/sessions/adapters.ts', './claude-code/adapter'],
      ['src/main/sessions/claude-code/adapter.ts', '../sdk/session'],
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
      await importErrors(
        'src/main/host/dialogs.ts',
        "import { dialog } from 'electron';\nimport { mintTrustedPath } from '../core/host';\n",
      ),
    ).toEqual([]);
  });
});

describe('ESLint’s boundary around the run', () => {
  const RUN_ERROR = 'The run never reads';
  /** React Flow's nodes, the renderer's CLI tables and the catalog it loaded. */
  const BANNED_FROM_RUN = [
    'src/renderer/graph/graph.ts',
    'src/renderer/graph/agents.ts',
    'src/renderer/catalog.ts',
  ];

  it('keeps the run and its helpers from React Flow, the renderer’s CLI tables and its catalog', async () => {
    for (const [file, from] of [
      ['src/renderer/run/runner.ts', '@xyflow/react'],
      ['src/renderer/run/runner.ts', '../graph/agents'],
      ['src/renderer/run/runner.ts', '../catalog'],
      ['src/renderer/run/asks.ts', '../graph/graph'],
      ['src/renderer/run/controls.ts', '@xyflow/system'],
      ['src/renderer/agent/sessions.ts', '../graph/agents'],
      ['src/renderer/agent/connected.ts', '../graph/graph'],
      ['src/renderer/agent/connected.ts', '../catalog'],
      ['src/renderer/agent/session.ts', '../graph/agents'],
      ['src/renderer/agent/session.ts', '../catalog'],
      ['src/renderer/graph/labels.ts', './graph'],
      ['src/renderer/graph/labels.ts', '../catalog'],
      ['src/renderer/graph/time.ts', './agents'],
      ['src/renderer/graph/time.ts', '../catalog'],
      ['src/renderer/graph/group-members.ts', './graph'],
      ['src/renderer/usage/usage.ts', '../graph/agents'],
      ['src/renderer/usage/usage.ts', '../catalog'],
      ['src/shared/model/canvas.ts', '../../renderer/graph/graph'],
      ['src/shared/model/queue.ts', '../../renderer/catalog'],
    ] as const) {
      const errors = await importErrors(file, `import type { A } from '${from}';\n`);
      expect(
        errors.filter((error) => error.includes(RUN_ERROR)),
        `${file} importing ${from}`,
      ).toHaveLength(1);
    }
  });

  it('lets the run read the model, the catalog it is given and the shared types', async () => {
    expect(
      await importErrors(
        'src/renderer/run/runner.ts',
        "import type { AgentNode } from '../../shared/model/canvas';\n" +
          "import type { EngineCatalog } from './catalog';\n" +
          "import { agentName } from '../graph/labels';\n" +
          "import type { AgentAction } from '../../shared/adapter';\n",
      ),
    ).toEqual([]);
    expect(
      await importErrors(
        'src/renderer/agent/connected.ts',
        "import type { EngineCatalog } from '../run/catalog';\n",
      ),
    ).toEqual([]);
  });

  it('lets the views, and the run’s tests, use React Flow, the renderer’s tables and catalog', async () => {
    for (const file of ['src/renderer/graph/edits.ts', 'src/renderer/run/runner.test.ts']) {
      expect(
        await importErrors(
          file,
          "import type { Node } from '@xyflow/react';\nimport { actionsOf } from '../graph/agents';\n" +
            "import { catalog } from '../catalog';\n",
        ),
        file,
      ).toEqual([]);
    }
  });

  it('covers every file the run imports, none of which imports React Flow, the CLI tables or the catalog', async () => {
    const files = [...closure(RUN_ENTRIES)].filter((file) => file.startsWith('src/'));
    expect(files).toContain('src/renderer/run/runner.ts');
    expect(files).toContain('src/shared/model/canvas.ts');
    for (const file of files) {
      expect(
        importsOf(file).filter((from) => from.startsWith('@xyflow/')),
        file,
      ).toEqual([]);
      expect(
        importsOf(file).flatMap((from) => {
          const found = from.startsWith('.') ? resolve(file, from) : undefined;
          return found !== undefined && BANNED_FROM_RUN.includes(found) ? [found] : [];
        }),
        file,
      ).toEqual([]);
      if (file.startsWith('src/renderer/')) {
        const errors = await importErrors(file, "import type { Node } from '@xyflow/react';\n");
        expect(
          errors.filter((error) => error.includes(RUN_ERROR)),
          `${file}: add it to the run's files in eslint.config.ts`,
        ).toHaveLength(1);
      }
    }
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

  it('make a human caller nowhere: no token, and nothing an agent or a page sends, is you', () => {
    // core/gui.ts (B8), for a window's port main made, will be the one place that makes one.
    const makers = mainFiles().filter((file) => /\basHuman\b/.test(read(file)));
    expect(makers).toEqual(['src/main/core/caller.ts']);
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
