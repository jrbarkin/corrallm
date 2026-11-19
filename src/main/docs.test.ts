import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// Extend this list as the remaining public docs are reviewed against the implementation.
const PUBLIC_DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/architecture/registry.md',
  'docs/architecture/renderer.md',
  'docs/architecture/run-recovery.md',
  'docs/architecture/security.md',
  'docs/architecture/sessions.md',
  'docs/architecture/store.md',
  'docs/architecture/testing.md',
  'docs/architecture/toolchain.md',
  'docs/architecture/updates.md',
  'docs/architecture/usage.md',
  'docs/architecture/workspaces.md',
];

/** References a reader cannot resolve from the public repository. */
function internalReferences(markdown: string): string[] {
  const patterns = [
    /\b(?:B\d+[a-z]?|[CX]\d+[a-z]?)\b/g,
    /\btasks?(?:[\s_-]+#?|#)?\d+[a-z]?\b/gi,
    /\bBuild[\s_-]+Plan\b/gi,
    /\bcorrallm-docs\b|\bprivate[\s-]+(?:design|plan)(?:\s+(?:documents?|docs?|notes?))?\b/gi,
    /\bcorrallm\s*[—–-]\s*[^`\r\n]*?\bDesign\b|\bDesign\.md\b/g,
    /§\s*[\d.a-z-]*/gi,
  ];
  return markdown
    .split('\n')
    .flatMap((line, index) =>
      patterns.flatMap((pattern) =>
        [...line.matchAll(pattern)].map((match) => `${String(index + 1)}: ${match[0]}`),
      ),
    );
}

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
  it.each(PUBLIC_DOCS)('keeps %s understandable without private plans', (file) => {
    expect(internalReferences(readFileSync(path.join(ROOT, file), 'utf8'))).toEqual([]);
  });

  it.each([
    'B9a',
    'B11',
    'B22b',
    'X12',
    'C7',
    'task 224',
    'task224',
    'task #224',
    'Task-224b',
    'Build Plan Q23',
    'private design notes',
    '~/Repos/corrallm-docs/review.md',
    'corrallm — Store Writer Design.md',
    'Design §3',
    '§9.2',
  ])('recognizes an internal reference in %s', (text) => {
    expect(internalReferences(text)).not.toEqual([]);
  });

  it('allows public links, feature names and technical versions', () => {
    expect(
      internalReferences(
        '[Store](docs/architecture/store.md) uses SQLite and a writer thread. ' +
          'Node 24.22.1, WebGL2, x64, C++ and a task queue are public terms.',
      ),
    ).toEqual([]);
  });

  it('keeps the canonical instructions within 20,000 bytes', () => {
    expect(readFileSync(path.join(ROOT, 'AGENTS.md')).byteLength).toBeLessThanOrEqual(20_000);
  });

  it('loads the same canonical instructions for every agent', () => {
    expect(readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
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
    ['README.md', 'GitHub CI '],
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
      ...PUBLIC_DOCS.map((file) => path.join(ROOT, file)),
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
