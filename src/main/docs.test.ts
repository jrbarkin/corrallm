import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Concrete repository paths in inline code; examples and globs name no single file. */
function codePaths(markdown: string): string[] {
  return [...markdown.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].flatMap((match) => {
    const value = match[1] ?? '';
    return /^(?:src|e2e|scripts|build)\//.test(value) && !/[<>…*{}]/.test(value) ? [value] : [];
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

  it('documents the kept-file CLI exception without giving command lines TrustedPath authority', () => {
    const agents = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    expect(agents.includes('No command line mints a `TrustedPath`')).toBe(true);
    expect(/`--canvas`[^\n]*canvas memory/.test(agents)).toBe(true);
    expect(agents.includes('No CLI/renderer argument supplies a project/file path')).toBe(false);
  });

  it('keeps model and effort argv guards in the canonical security rules', () => {
    const agents = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    expect(agents.includes('`MODEL_PATTERN`')).toBe(true);
    expect(agents.includes('`EFFORT_PATTERN`')).toBe(true);
    expect(/model and effort[^\n]*never[^\n]*leading dash/i.test(agents)).toBe(true);
  });

  it.each(['claude-code', 'codex'])(
    'documents %s native ids as adapter checks after R42a',
    (adapter) => {
      const doc = readFileSync(path.join(ROOT, `docs/architecture/${adapter}.md`), 'utf8');
      expect(doc.includes('Session ids are UUIDs (`sessions/id.ts`)')).toBe(false);
      expect(doc.includes('[R42a](sessions.md#connected-sessions)')).toBe(true);
      expect(doc.includes('`isConversationId`')).toBe(true);
    },
  );

  it('links the slash-permission refusal to the adapter’s local safety section', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/architecture/codex.md'), 'utf8');
    const commands = doc.split('\n').find((line) => line.includes('Slash commands are'));
    expect(commands?.includes('[Native IDs and safety](#native-ids-and-safety)')).toBe(true);
  });

  it.each([
    ['README.md', 'Local CI '],
    ['docs/architecture/toolchain.md', 'corrallm.mjs (`pnpm corrallm`)'],
  ])('names every local gate script where %s introduces them', (file, start) => {
    const line = readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .find((one) => one.startsWith(start));
    const gates = readdirSync(path.join(ROOT, 'scripts')).filter((name) => name.endsWith('.sh'));
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.filter((name) => !line?.includes(`\`scripts/${name}`))).toEqual([]);
  });

  it('keeps every concrete backticked repository path valid', () => {
    const missing = [
      path.join(ROOT, 'AGENTS.md'),
      ...markdownFiles(path.join(ROOT, 'docs')),
    ].flatMap((file) =>
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
