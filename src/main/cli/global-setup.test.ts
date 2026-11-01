import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_BUILD_USERS, filtersFromArgv, needsCliBuild } from './global-setup';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

function testFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return testFiles(rel);
    return /\.test\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

describe('needsCliBuild', () => {
  it('builds for a full run and for any filter that is not one exact test file', () => {
    expect(needsCliBuild([])).toBe(true);
    expect(needsCliBuild(['serve'])).toBe(true);
    expect(needsCliBuild(['src/main/cli'])).toBe(true);
    expect(needsCliBuild(['src/main/core/messages.test.ts', 'token'])).toBe(true);
  });

  it('builds when a named file runs the CLI, and skips for files that do not', () => {
    expect(needsCliBuild(['src/main/cli/serve.test.ts'])).toBe(true);
    expect(needsCliBuild(['./src/main/core/entry.test.ts'])).toBe(true);
    expect(needsCliBuild(['src/main/core/messages.test.ts', 'src/renderer/App.test.tsx'])).toBe(
      false,
    );
  });

  it('reads filters from the command line, and builds when it cannot', () => {
    const run = ['node', 'vitest.mjs', 'run'];
    expect(filtersFromArgv([...run, '--project', 'main', '--maxWorkers=2', 'a.test.ts'])).toEqual([
      'a.test.ts',
    ]);
    expect(filtersFromArgv([...run, '--project', 'main'])).toEqual([]);
    expect(needsCliBuild(filtersFromArgv(['node', 'vitest.mjs', 'a.test.ts']))).toBe(true);
    expect(needsCliBuild(filtersFromArgv([...run, '--other', 'x', 'a.test.ts']))).toBe(true);
  });

  it('covers every test file that uses the built outputs', () => {
    const uses = /dist-cli|test-children|test-lifetime|corrallm\.cjs/;
    const users = testFiles('src')
      .filter((file) => uses.test(readFileSync(path.join(root, file), 'utf8')))
      .filter((file) => !CLI_BUILD_USERS.test(file));
    expect(users).toEqual([]);
  });
});
