import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The platform names no CLI: what is particular to one belongs in its adapter's folder
 * (src/main/sessions/claude-code/, src/main/sessions/codex/), which the
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
  'src/main/sessions/codex',
  'src/main/sessions/acp',
  'src/main/sessions/muse',
];
/** The registry: the one platform file that imports the adapters' folders, by their names. */
const REGISTRY = 'src/main/sessions/adapters.ts';
/** A CLI's name, its maker's, or a connection id only one CLI has. */
const NAMES = /claude|codex|anthropic|openai|chatgpt|(['"])(?:sdk|app-server)\1/gi;

/** Today's offenders, by file: how many names each has. */
const ALLOWED: Readonly<Record<string, number>> = {
  'src/main/files.ts': 1,
  'src/main/native-selftest.ts': 1,
  'src/main/sessions/args.ts': 4,
  'src/main/sessions/connector.ts': 8,
  'src/main/sessions/fake.ts': 12,
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
  'src/renderer/agent/modes.ts': 9,
  'src/renderer/agent/tools.ts': 1,
  'src/renderer/graph/GraphEditor.css': 4,
  'src/renderer/graph/Questions.tsx': 3,
  'src/renderer/graph/agents.ts': 39,
  'src/shared/examples.ts': 7,
  'src/shared/examples/cross-check.corral': 2,
  'src/shared/examples/fan-out.corral': 4,
  'src/shared/examples/feature-crew.corral': 4,
  'src/shared/examples/head-to-head.corral': 18,
  'src/shared/examples/release-checks.corral': 2,
  'src/shared/examples/review-loop.corral': 2,
  'src/shared/examples/review-panel.corral': 4,
  'src/shared/examples/tdd-relay.corral': 3,
  'src/shared/examples/team-lead.corral': 4,
  'src/renderer/open-link.ts': 1,
  'src/renderer/terminal/TerminalPane.css': 1,
  'src/renderer/terminal/TerminalPane.tsx': 6,
  'src/renderer/terminal/keyboard.ts': 1,
  'src/renderer/terminal/screen.ts': 4,
  'src/shared/engine/delivery/mailbox.ts': 5,
  'src/shared/engine/run/asks.ts': 1,
  'src/shared/engine/run/runner.ts': 4,
  'src/shared/engine/run/turns.ts': 1,
  'src/shared/engine/transcript/driver.ts': 1,
  'src/shared/engine/transcript/receive.ts': 5,
  'src/shared/engine/transcript/unavailable.ts': 2,
  'src/shared/ipc.ts': 4,
  'src/shared/model/session.ts': 7,
  'src/shared/model/words.ts': 5,
  'src/shared/session.ts': 5,
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
