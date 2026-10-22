import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Concrete repository paths in inline code; examples and globs name no single file. */
function codePaths(markdown: string): string[] {
  return [...markdown.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].flatMap((match) => {
    const value = match[1] ?? '';
    return /^(?:src|e2e|scripts|build)\//.test(value) && !/[<>…*{}]/.test(value)
      ? [value]
      : [];
  });
}

function markdownFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : file.endsWith('.md') ? [file] : [];
  });
}

describe('repository instructions and architecture docs', () => {
  it('keeps the canonical instructions within 20,000 bytes', () => {
    expect(readFileSync(path.join(ROOT, 'AGENTS.md')).byteLength).toBeLessThanOrEqual(20_000);
  });

  it('loads the same canonical instructions for every agent', () => {
    expect(readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
  });

  it('keeps every concrete backticked repository path valid', () => {
    const missing = [path.join(ROOT, 'AGENTS.md'), ...markdownFiles(path.join(ROOT, 'docs'))]
      .flatMap((file) =>
        codePaths(readFileSync(file, 'utf8')).flatMap((target) =>
          existsSync(path.join(ROOT, target)) ? [] : [`${path.relative(ROOT, file)}: ${target}`],
        ),
      );
    expect(missing).toEqual([]);
  });

  it('checks concrete paths while skipping placeholders and globs', () => {
    expect(
      codePaths(
        '`src/main/docs.test.ts` `e2e/missing.ts` `scripts/missing.mjs` `build/missing` ' +
          '`src/<area>/file.ts` `src/…/file.ts` `src/*.ts` `src/{main,shared}/` `other/path`',
      ),
    ).toEqual(['src/main/docs.test.ts', 'e2e/missing.ts', 'scripts/missing.mjs', 'build/missing']);
  });
});
