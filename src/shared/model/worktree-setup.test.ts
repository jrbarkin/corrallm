import { describe, expect, it } from 'vitest';

import { COPY_LIMITS, detectSetup, selectCopyFiles } from './worktree-setup';
import type { CopyCandidate, SetupFiles } from './worktree-setup';

const repository = (files: readonly string[], metadata: unknown = {}): SetupFiles => ({
  files: ['package.json', ...files],
  packageJson: JSON.stringify(metadata),
});
const candidate = (path: string, bytes = 10, ignored = true): CopyCandidate => ({
  path,
  bytes,
  ignored,
});
const paths = (manifest: string | undefined, names: readonly string[]) =>
  selectCopyFiles(
    manifest,
    names.map((path) => candidate(path)),
  ).files.map(({ path }) => path);

describe('repository setup suggestions', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile', ['install', '--frozen-lockfile']],
    ['package-lock.json', 'npm', 'npm ci', ['ci']],
    ['npm-shrinkwrap.json', 'npm', 'npm ci', ['ci']],
  ] as const)('suggests only the fixed command for %s', (lock, manager, command, args) => {
    expect(detectSetup(repository([lock]))).toEqual({
      kind: 'suggested',
      spec: { manager, command, args, evidence: ['package.json', lock] },
    });
  });

  it('recognizes npm’s two lock names as one manager, without depending on file order', () => {
    const files = repository(['npm-shrinkwrap.json', 'package-lock.json']);
    expect(detectSetup(files)).toEqual(
      detectSetup({ ...files, files: [...files.files].reverse() }),
    );
    expect(detectSetup(files)).toMatchObject({ kind: 'suggested', spec: { manager: 'npm' } });
  });

  it('needs configuration for multiple managers, including a supported and unsupported one', () => {
    expect(detectSetup(repository(['pnpm-lock.yaml', 'package-lock.json']))).toEqual({
      kind: 'manual',
      reason: 'multiple-managers',
      managers: ['npm', 'pnpm'],
    });
    expect(detectSetup(repository(['package-lock.json', 'yarn.lock']))).toEqual({
      kind: 'manual',
      reason: 'multiple-managers',
      managers: ['npm', 'yarn'],
    });
  });

  it('requires matching project metadata, not just a lockfile or a nested package', () => {
    expect(detectSetup({ files: ['pnpm-lock.yaml'] })).toMatchObject({
      kind: 'manual',
      reason: 'missing-package-json',
    });
    expect(detectSetup({ files: ['package.json', 'pnpm-lock.yaml'] })).toMatchObject({
      kind: 'manual',
      reason: 'invalid-package-json',
    });
    expect(
      detectSetup({ files: ['packages/app/package.json', 'packages/app/package-lock.json'] }),
    ).toMatchObject({ kind: 'manual', reason: 'no-lockfile' });
  });

  it.each(['[]', 'null', 'false', '"text"', '{broken'])(
    'needs configuration for malformed package metadata: %s',
    (packageJson) => {
      expect(
        detectSetup({ files: ['package.json', 'package-lock.json'], packageJson }),
      ).toMatchObject({ kind: 'manual', reason: 'invalid-package-json' });
    },
  );

  it('checks the declared manager against the lockfile without making the metadata executable', () => {
    expect(
      detectSetup(repository(['pnpm-lock.yaml'], { packageManager: 'pnpm@10.2.0+sha512.abc' })),
    ).toMatchObject({ kind: 'suggested', spec: { command: 'pnpm install --frozen-lockfile' } });
    expect(
      detectSetup(repository(['pnpm-lock.yaml'], { packageManager: 'npm@10.0.0' })),
    ).toMatchObject({ kind: 'manual', reason: 'conflicting-package-manager' });
    expect(
      detectSetup(
        repository(['package-lock.json'], { packageManager: { command: 'run something' } }),
      ),
    ).toMatchObject({ kind: 'manual', reason: 'conflicting-package-manager' });
  });

  it('does not invent installs from README text, scripts or a declared manager without a lock', () => {
    const files = repository(['README.md'], {
      packageManager: 'pnpm@10.0.0',
      scripts: { setup: 'arbitrary script', install: 'another script' },
    });
    expect(detectSetup(files)).toEqual({ kind: 'manual', reason: 'no-lockfile', managers: [] });
    expect(
      detectSetup(repository(['package-lock.json'], { scripts: { setup: 'something else' } })),
    ).toMatchObject({ kind: 'suggested', spec: { command: 'npm ci' } });
  });

  it.each([
    'yarn.lock',
    'bun.lock',
    'uv.lock',
    'Cargo.lock',
    'poetry.lock',
    'Gemfile.lock',
    'composer.lock',
  ])('does not suggest an unreviewed command for %s', (lock) => {
    expect(detectSetup(repository([lock]))).toMatchObject({
      kind: 'manual',
      reason: 'unsupported-manager',
    });
  });

  it('leaves the input untouched and returns independent suggestions', () => {
    const input = Object.freeze(repository(Object.freeze(['package-lock.json'])));
    const saved = structuredClone(input);
    const first = detectSetup(input),
      second = detectSetup(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(input).toEqual(saved);
  });
});

describe('copy-manifest selection', () => {
  it('copies nothing without a manifest, an empty one or one containing only comments', () => {
    for (const manifest of [undefined, '', '# .env\n\n# local files\n'])
      expect(paths(manifest, ['.env', '.env.local'])).toEqual([]);
  });

  it('intersects the manifest with ignored files; a match alone does not select a tracked/unignored file', () => {
    const files = [
      candidate('.env'),
      candidate('.env.local', 4, false),
      candidate('config/local.json', 5),
      candidate('other', 7),
    ];
    expect(selectCopyFiles('.env*\nconfig/local.json', files)).toEqual({
      files: [files[0], files[2]],
      bytes: 15,
    });
  });

  it('supports the documented env, nested secrets, globstar and negated-example patterns', () => {
    expect(
      paths(
        '.env*\nconfig/**/local.json\n.local-secrets/**\n!.local-secrets/**/\n!.local-secrets/**/*.example',
        [
          '.env',
          '.env.local',
          'config/local.json',
          'config/nested/local.json',
          '.local-secrets/a',
          '.local-secrets/deep/a.example',
          'README.md',
        ],
      ),
    ).toEqual([
      '.env',
      '.env.local',
      '.local-secrets/a',
      'config/local.json',
      'config/nested/local.json',
    ]);
  });

  it('distinguishes anchored paths from names at any depth, and matches dotfiles', () => {
    expect(
      paths('/config/local.json\n.env', [
        'config/local.json',
        'nested/config/local.json',
        '.env',
        'nested/.env',
      ]),
    ).toEqual(['.env', 'config/local.json', 'nested/.env']);
  });

  it('handles directory patterns, question marks and character ranges', () => {
    expect(
      paths('local/\nconfig?.[jt]s', [
        'local/a',
        'nested/local/b',
        'local-file',
        'config1.js',
        'config2.ts',
        'config12.ts',
        'config1.css',
      ]),
    ).toEqual(['config1.js', 'config2.ts', 'local/a', 'nested/local/b']);
  });

  it('uses Git’s parent-directory exclusion semantics, not ordered general globs', () => {
    // A negation cannot re-include a child while its parent is excluded by a directory rule.
    expect(paths('cache/\n!cache/keep.json', ['cache/a', 'cache/keep.json'])).toEqual([
      'cache/a',
      'cache/keep.json',
    ]);
    // Matching contents instead leaves the parent traversable, so the negation can take effect.
    expect(paths('cache/**\n!cache/keep.json', ['cache/a', 'cache/keep.json'])).toEqual([
      'cache/a',
    ]);
  });

  it('honours escaping, CRLF, escaped trailing spaces and the last matching rule', () => {
    const manifest = '# comment\r\n\\#secret\r\n\\!secret\r\nspace\\ \r\n.env\r\n!.env\r\n.env\r\n';
    expect(paths(manifest, ['#secret', '!secret', 'space ', 'space', '.env'])).toEqual([
      '!secret',
      '#secret',
      '.env',
      'space ',
    ]);
  });

  it('keeps matching case-sensitive and preserves Unicode names', () => {
    expect(paths('.env\n秘密/**', ['.env', '.ENV', '秘密/設定.json'])).toEqual([
      '.env',
      '秘密/設定.json',
    ]);
  });

  it('returns a deterministic selection without mutating candidates or their order', () => {
    const files = Object.freeze([Object.freeze(candidate('b')), Object.freeze(candidate('a'))]);
    const selected = selectCopyFiles('*', files);
    expect(selected.files.map(({ path }) => path)).toEqual(['a', 'b']);
    expect(selected.files[0]).toBe(files[1]);
    expect(files.map(({ path }) => path)).toEqual(['b', 'a']);
    expect(selectCopyFiles('*', [...files].reverse())).toEqual(selected);
  });

  it('refuses duplicate candidate names instead of counting or copying them twice', () => {
    expect(() => selectCopyFiles('*', [candidate('a'), candidate('a')])).toThrow(
      /duplicate-candidate/,
    );
  });

  it.each(['', '/absolute', './relative', '../outside'])(
    'refuses a non-Git-relative parser input: %s',
    (path) => {
      expect(() => selectCopyFiles('*', [candidate(path)])).toThrow(/invalid-candidate/);
    },
  );

  it('bounds the manifest in UTF-8 bytes, including multi-byte text', () => {
    const full = '#' + 'x'.repeat(COPY_LIMITS.manifestBytes - 6) + '\n.env';
    expect(selectCopyFiles(full, [candidate('.env')]).files).toHaveLength(1);
    expect(() => selectCopyFiles(full + '\n', [])).toThrow(/manifest-bytes/);
    expect(() => selectCopyFiles('#' + 'é'.repeat(COPY_LIMITS.manifestBytes / 2), [])).toThrow(
      /manifest-bytes/,
    );
  });

  it('bounds selected file count and never returns a prefix when it exceeds the cap', () => {
    const files = Array.from({ length: COPY_LIMITS.files }, (_, i) =>
      candidate(`f${String(i)}`, 0),
    );
    expect(selectCopyFiles('*', files).files).toHaveLength(COPY_LIMITS.files);
    expect(() => selectCopyFiles('*', [...files, candidate('extra', 0)])).toThrow(/file-count/);
  });

  it('bounds each selected file and the selected total independently', () => {
    expect(selectCopyFiles('*', [candidate('one', COPY_LIMITS.fileBytes)]).bytes).toBe(
      COPY_LIMITS.fileBytes,
    );
    expect(() => selectCopyFiles('*', [candidate('one', COPY_LIMITS.fileBytes + 1)])).toThrow(
      /file-bytes/,
    );
    const files = Array.from({ length: COPY_LIMITS.totalBytes / COPY_LIMITS.fileBytes }, (_, i) =>
      candidate(`f${String(i)}`, COPY_LIMITS.fileBytes),
    );
    expect(selectCopyFiles('*', files).bytes).toBe(COPY_LIMITS.totalBytes);
    expect(() => selectCopyFiles('*', [...files, candidate('extra', 1)])).toThrow(/total-bytes/);
  });

  it.each([-1, NaN, Infinity, 0.5])('refuses an invalid selected size: %s', (bytes) => {
    expect(() => selectCopyFiles('*', [candidate('bad', bytes)])).toThrow(/invalid-size/);
  });

  it('counts only selected ignored files against the copy budget', () => {
    expect(
      selectCopyFiles('.env', [
        candidate('.env'),
        candidate('large', COPY_LIMITS.fileBytes + 1),
        candidate('.env.other', COPY_LIMITS.fileBytes + 1, false),
      ]).bytes,
    ).toBe(10);
  });
});
