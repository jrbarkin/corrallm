import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * A blocking write (`Database.writeBlocking`) is the rare write whose function needs SQL as it
 * runs; every other write is planned (`Database.write`) and reads nothing. This pins where the
 * blocking ones are, exactly, file by file: a file that gains a call fails, and so does one that
 * lost one until its count here is lowered (to nothing: out of the list), so the list only ever
 * shrinks (as src/main/platform-neutral.test.ts does for CLI names).
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** Today's blocking writers, by file: how many `.writeBlocking(` calls each has. */
const BLOCKING: Readonly<Record<string, number>> = {
  'src/main/core/canvas/proposals.ts': 1,
  'src/main/core/leads.ts': 3,
  'src/main/core/selftest.ts': 1,
  'src/main/core/workspaces/merge-journal.ts': 1,
  'src/main/memory.ts': 2,
};

/** Every production file under `dir` (tests and their helpers aside), from the repository's root. */
function productionFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return productionFiles(file);
    return /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.startsWith('test-')
      ? [file]
      : [];
  });
}

describe('blocking writes', () => {
  it('are in exactly the files pinned here, as many as are pinned', () => {
    const found: Record<string, number> = {};
    for (const file of productionFiles('src')) {
      const count = readFileSync(path.join(ROOT, file), 'utf8').match(/\.writeBlocking\(/g)?.length;
      if (count !== undefined) found[file] = count;
    }
    expect(found).toEqual(BLOCKING);
  });
});
