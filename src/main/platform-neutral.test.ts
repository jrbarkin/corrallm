import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The platform names no CLI: what is particular to one belongs in its adapter's folder
 * (src/main/sessions/claude-code/, src/main/sessions/sdk/, src/main/sessions/codex/), which the
 * registry alone imports (src/main/sessions/adapters.ts). This scans the platform's code, strings
 * and comments (src/shared, src/preload, src/main outside the adapters' folders and the registry,
 * the terminal toolkit included, and src/renderer with its templates; never tests) for a CLI's
 * name, its maker's, or a connection's id. The files that name them today are allowed exactly as
 * many names as they have: a file that names one more fails, and so does one that names fewer,
 * until its count here is lowered (to nothing: out of the list), so the list only ever shrinks.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCANNED = ['src/shared', 'src/preload', 'src/main', 'src/renderer'];
const ADAPTERS = [
  'src/main/sessions/claude-code',
  'src/main/sessions/sdk',
  'src/main/sessions/codex',
];
/** The registry: the one platform file that imports the adapters' folders, by their names. */
const REGISTRY = 'src/main/sessions/adapters.ts';
/** A CLI's name, its maker's, or a connection id only one CLI has. */
const NAMES = /claude|codex|anthropic|openai|chatgpt|(['"])(?:sdk|app-server)\1/gi;

/** Today's offenders, by file: how many names each has. */
const ALLOWED: Readonly<Record<string, number>> = {
  'src/main/core/selftest-claude.mjs': 2,
  'src/main/core/selftest.ts': 21,
  'src/main/files.ts': 1,
  'src/main/forge-env.d.ts': 2,
  'src/main/host/reveal.ts': 1,
  'src/main/index.ts': 2,
  'src/main/native-selftest.ts': 2,
  'src/main/sessions/args.ts': 4,
  'src/main/sessions/claude-errors.ts': 6,
  'src/main/sessions/claude-settings.ts': 27,
  'src/main/sessions/claude.ts': 27,
  'src/main/sessions/connector.ts': 8,
  'src/main/sessions/connectors.ts': 58,
  'src/main/sessions/environment.ts': 15,
  'src/main/sessions/executables.ts': 3,
  'src/main/sessions/fake.ts': 13,
  'src/main/sessions/installed.ts': 18,
  'src/main/sessions/manager.ts': 13,
  'src/main/sessions/terminal/claude-code.ts': 24,
  'src/main/sessions/terminal/cli.ts': 13,
  'src/main/sessions/terminal/connector.ts': 40,
  'src/main/sessions/terminal/drop.ts': 1,
  'src/main/sessions/terminal/fake-claude.ts': 11,
  'src/main/sessions/terminal/first-run.ts': 1,
  'src/main/sessions/terminal/hooks-off.ts': 14,
  'src/main/sessions/terminal/hooks.ts': 9,
  'src/main/sessions/terminal/screen.ts': 6,
  'src/main/sessions/terminal/session.ts': 17,
  'src/main/sessions/terminal/status.ts': 3,
  'src/main/sessions/terminal/statusline.ts': 18,
  'src/main/sessions/terminal/typing.ts': 3,
  'src/main/sessions/transcript.ts': 4,
  'src/main/usage.ts': 2,
  'src/renderer/agent/AgentChip.tsx': 2,
  'src/renderer/agent/AgentView.css': 1,
  'src/renderer/agent/AgentView.tsx': 27,
  'src/renderer/agent/Composer.tsx': 8,
  'src/renderer/agent/McpPanel.tsx': 3,
  'src/renderer/agent/ResumePicker.tsx': 1,
  'src/renderer/agent/Rewind.tsx': 1,
  'src/renderer/agent/Settings.tsx': 8,
  'src/renderer/agent/Transcript.tsx': 31,
  'src/renderer/agent/commands.ts': 15,
  'src/renderer/agent/completion.ts': 1,
  'src/renderer/agent/connected.ts': 5,
  'src/renderer/agent/driver.ts': 1,
  'src/renderer/agent/session.ts': 18,
  'src/renderer/agent/sessions.ts': 5,
  'src/renderer/agent/tools.ts': 1,
  'src/renderer/agent/unavailable.ts': 2,
  'src/renderer/graph/GraphEditor.css': 4,
  'src/renderer/graph/Questions.tsx': 6,
  'src/renderer/graph/agents.ts': 57,
  'src/renderer/graph/examples.ts': 7,
  'src/renderer/graph/examples/cross-check.corral': 2,
  'src/renderer/graph/examples/fan-out.corral': 4,
  'src/renderer/graph/examples/feature-crew.corral': 4,
  'src/renderer/graph/examples/head-to-head.corral': 18,
  'src/renderer/graph/examples/release-checks.corral': 2,
  'src/renderer/graph/examples/review-loop.corral': 2,
  'src/renderer/graph/examples/review-panel.corral': 4,
  'src/renderer/graph/examples/tdd-relay.corral': 3,
  'src/renderer/graph/examples/team-lead.corral': 4,
  'src/renderer/graph/labels.ts': 1,
  'src/renderer/graph/nodes.tsx': 1,
  'src/renderer/graph/time.ts': 2,
  'src/renderer/open-link.ts': 1,
  'src/renderer/run/asks.ts': 1,
  'src/renderer/run/runner.ts': 6,
  'src/renderer/run/turns.ts': 1,
  'src/renderer/terminal/TerminalPane.css': 1,
  'src/renderer/terminal/TerminalPane.tsx': 6,
  'src/renderer/terminal/keyboard.ts': 1,
  'src/renderer/terminal/screen.ts': 4,
  'src/renderer/usage/usage.ts': 3,
  'src/shared/ipc.ts': 4,
  'src/shared/session.ts': 43,
  'src/shared/terminal.ts': 1,
  'src/shared/usage.ts': 2,
};

/** Every platform file, by its path from the repository's root. */
function platformFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ADAPTERS.includes(file) ? [] : platformFiles(file);
    return /\.test\.[jt]sx?$/.test(entry.name) ||
      entry.name.startsWith('test-') ||
      file === REGISTRY
      ? []
      : [file];
  });
}

/** Where a file names a CLI: each line that does, with its number. */
function named(file: string): string[] {
  return readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .flatMap((line, i) => (line.match(NAMES) ?? []).map(() => `${file}:${String(i + 1)}: ${line}`));
}

describe('the platform', () => {
  const files = SCANNED.flatMap(platformFiles);

  it('names no CLI outside the files that do today', () => {
    const found = files.filter((file) => !(file in ALLOWED)).flatMap(named);
    expect(found, 'A CLI’s name in platform code: move it into its adapter').toEqual([]);
  });

  it('names a CLI no more, and no less, in each of those files than it did', () => {
    const counts = Object.fromEntries(
      Object.keys(ALLOWED).map((file) => [file, files.includes(file) ? named(file).length : 0]),
    );
    expect(counts, 'Lower a file’s count when it names fewer; never raise it').toEqual(ALLOWED);
  });
});
