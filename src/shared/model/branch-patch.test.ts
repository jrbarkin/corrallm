import { describe, expect, it } from 'vitest';

import { BranchDiffOutput, BranchFile } from '../api/branch';
import { AgentId, WorktreeId } from '../api/ids';
import { MAX_PAGE_BYTES } from '../api/limits';
import {
  branchDiffPage,
  branchPath,
  branchPathSentence,
  cutBranchPatch,
  untrackedFilePatch,
} from './branch-patch';
import { decodeBranchCursor } from './branch-review';

const utf8 = (value: string) => new TextEncoder().encode(value);
const bytes = (value: unknown) => utf8(JSON.stringify(value)).length;
const tip = 'a'.repeat(40);
const header = {
  agent: AgentId.parse('builder'),
  workspace: WorktreeId.parse('22222222-2222-4222-8222-222222222222'),
  shared: [AgentId.parse('builder')],
  source: { ref: 'refs/heads/corrallm/p/w', oid: tip, onBranch: true },
  base: { ref: 'refs/heads/main', oid: tip },
  into: { ref: 'refs/heads/main', oid: tip },
  committed: { files: 3, complete: true },
  uncommitted: { changed: 0, untracked: 0, partlyStaged: 0, complete: true, digest: null },
};
const file = (path: string, patch?: string) =>
  BranchFile.parse({
    section: 'committed',
    path,
    status: 'modified',
    ...(patch === undefined ? {} : { patch }),
  });

describe('patch text and names from bytes', () => {
  it('cuts only complete lines and characters, keeping a complete last line without a newline', () => {
    const patch = 'é😀\r\n+next\n';
    expect(cutBranchPatch(patch, 8)).toEqual({ patch: 'é😀\r\n', cut: true });
    expect(cutBranchPatch(patch, 7)).toEqual({ patch: '', cut: true });
    expect(cutBranchPatch('😀', 4)).toEqual({ patch: '😀' });
    expect(cutBranchPatch('😀', 3)).toEqual({ patch: '', cut: true });
    expect(cutBranchPatch('first\npartial', 100, true)).toEqual({ patch: 'first\n', cut: true });
    expect(cutBranchPatch('first\n', 100, true)).toEqual({ patch: 'first\n', cut: true });
    expect(cutBranchPatch('', 0)).toEqual({ patch: '' });
  });

  it('renders text, empty and no-final-newline untracked additions without starting Git', () => {
    const start =
      'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n';
    expect(untrackedFilePatch('new.txt', utf8('one\ntwo\n'))).toEqual({
      patch: start + '@@ -0,0 +1,2 @@\n+one\n+two\n',
    });
    expect(untrackedFilePatch('new.txt', utf8('one'))).toEqual({
      patch: start + '@@ -0,0 +1 @@\n+one\n\\ No newline at end of file\n',
    });
    expect(untrackedFilePatch('new.txt', new Uint8Array())).toEqual({ patch: start });
    const quoted = untrackedFilePatch('a\n"b', utf8('link target'), { symlink: true });
    expect(quoted.patch).toContain('diff --git "a/a\\n\\"b" "b/a\\n\\"b"\nnew file mode 120000\n');
    expect(quoted.patch).toContain('+link target\n');
  });

  it('detects binary only in the first 8,000 bytes and decodes invalid UTF-8 with replacement', () => {
    expect(untrackedFilePatch('binary', new Uint8Array([65, 0, 66]))).toEqual({ binary: true });
    const edge = new Uint8Array(8001).fill(65);
    edge[8000] = 0;
    expect(untrackedFilePatch('edge', edge).binary).toBeUndefined();
    edge[7999] = 0;
    expect(untrackedFilePatch('edge', edge)).toEqual({ binary: true });
    expect(untrackedFilePatch('invalid', new Uint8Array([0xff, 10])).patch).toContain('+�\n');
  });

  it('bounds untracked reads to 1 MiB, marks upstream cuts and never emits a partial final line', () => {
    const source = utf8('a\n'.repeat(600_000));
    const result = untrackedFilePatch('large', source);
    expect(result.cut).toBe(true);
    expect(utf8(result.patch ?? '').length).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    expect(result.patch?.endsWith('\n')).toBe(true);
    expect(untrackedFilePatch('cut', utf8('one\npartial'), { cut: true }).patch).not.toContain(
      'partial',
    );
    expect(untrackedFilePatch('cut', utf8('one\npartial'), { cut: true }).cut).toBe(true);
  });

  it('shows lossy names within the UTF-8 bound, preserving well-formed pathspec-looking names as data', () => {
    expect(branchPath(utf8(':(glob)**\nfile'))).toEqual({ path: ':(glob)**\nfile' });
    expect(branchPath(new Uint8Array([0xff, 65]))).toEqual({ path: '�A', note: 'lossy-name' });
    for (const raw of [utf8('😀'.repeat(2000)), new Uint8Array(4096).fill(0xff)]) {
      const shown = branchPath(raw);
      expect(shown.note).toBe('lossy-name');
      expect(utf8(shown.path).length).toBeLessThanOrEqual(4096);
      expect(shown.path.isWellFormed()).toBe(true);
    }
  });
});

describe('whole-result branch page budgeting', () => {
  it('continues through committed then uncommitted entries without repetition and obeys count limits', () => {
    const files = [
      file('c1'),
      file('c2'),
      BranchFile.parse({ section: 'uncommitted', path: 'u1', status: 'untracked' }),
    ];
    const first = branchDiffPage(header, files, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.files.map(({ path }) => path)).toEqual(['c1', 'c2']);
    expect(decodeBranchCursor(first.value.next ?? '')).toMatchObject({
      ok: true,
      value: { tip, digest: null, position: 2 },
    });
    const second = branchDiffPage(header, files, {
      after: first.value.next ?? undefined,
      limit: 2,
    });
    expect(second).toMatchObject({ ok: true, value: { files: [files[2]], next: null } });
    expect(branchDiffPage(header, [], {})).toMatchObject({
      ok: true,
      value: { files: [], next: null },
    });
    const many = Array.from({ length: 201 }, (_, i) => file(String(i)));
    const capped = branchDiffPage(header, many, { limit: 200 });
    expect(capped.ok && capped.value.files).toHaveLength(200);
    const defaults = branchDiffPage(header, many);
    expect(defaults.ok && defaults.value.files).toHaveLength(50);
  });

  it('counts JSON escaping and envelopes, cuts a patch to fit, and still advances past a cut file', () => {
    const files = [file('"\n'.repeat(1000), '\\"😀\n'.repeat(6000)), file('next', '+ok\n')];
    const result = branchDiffPage(header, files, { limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bytes(result.value)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    expect(BranchDiffOutput.safeParse(result.value).success).toBe(true);
    expect(result.value.files[0]?.cut).toBe(true);
    expect(result.value.files[0]?.patch?.endsWith('\n')).toBe(true);
    expect(branchDiffPage(header, files, { after: result.value.next ?? undefined })).toMatchObject({
      ok: true,
      value: { files: [files[1]], next: null },
    });
  });

  it('returns at least one nonempty inventory entry even when its first patch line cannot fit', () => {
    const result = branchDiffPage(header, [file('huge', 'x'.repeat(MAX_PAGE_BYTES))]);
    expect(result).toMatchObject({
      ok: true,
      value: { files: [{ path: 'huge', patch: '', cut: true }], next: null },
    });
  });

  it('removes an incomplete final line from an upstream-capped patch even when the page has room', () => {
    const result = branchDiffPage(header, [{ ...file('capped', '+whole\n+part'), cut: true }]);
    expect(result).toMatchObject({
      ok: true,
      value: { files: [{ patch: '+whole\n', cut: true }] },
    });
  });

  it('keeps every page within budget across escaped and multibyte patches and consumes every entry once', () => {
    const inventory = Array.from({ length: 25 }, (_, i) =>
      file(String(i), ['+é😀\n', '+\\\t\n', '+plain\r\n'][i % 3]?.repeat(2000)),
    );
    let after: string | undefined;
    const seen: string[] = [];
    while (seen.length < inventory.length) {
      const result = branchDiffPage(header, inventory, { after, limit: 7 });
      if (!result.ok) throw new Error(result.error.sentence);
      expect(bytes(result.value)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(result.value.files.length).toBeGreaterThan(0);
      expect(BranchDiffOutput.safeParse(result.value).success).toBe(true);
      for (const entry of result.value.files) {
        seen.push(entry.path);
        if (entry.cut && entry.patch) expect(entry.patch.endsWith('\n')).toBe(true);
      }
      if (result.value.next === null) break;
      after = result.value.next;
    }
    expect(seen).toEqual(inventory.map(({ path }) => path));
  });

  it('ends before metadata that does not fit, and refuses an oversized header rather than loop on an empty page', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(String(i) + '\n'.repeat(4000)));
    const result = branchDiffPage(header, files, { limit: 200 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.length).toBeGreaterThan(0);
      expect(result.value.files.length).toBeLessThan(files.length);
      expect(bytes(result.value)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(result.value.next).not.toBeNull();
    }
    const shared = Array.from({ length: 500 }, (_, i) => AgentId.parse(String(i).padEnd(256, 'x')));
    expect(branchDiffPage({ ...header, shared }, [file('a')])).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });

  it('refuses stale pins and malformed or impossible continuations before making a page', () => {
    const first = branchDiffPage(header, [file('a'), file('b')], { limit: 1 });
    if (!first.ok) throw new Error('The fixture must have a first page.');
    const after = first.value.next ?? undefined;
    expect(
      branchDiffPage(
        { ...header, source: { ...header.source, oid: 'c'.repeat(40) } },
        [file('a'), file('b')],
        { after },
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(branchDiffPage(header, [], { after })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(branchDiffPage(header, [file('a')], { after: '--all' })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
  });
});

describe('bounded repository-path sentences', () => {
  it('escapes names and lists five at most, then the number left', () => {
    expect(
      branchPathSentence('Cannot merge', [
        'one',
        'two\n"',
        'three',
        'four',
        'five',
        'six',
        'seven',
      ]),
    ).toBe('Cannot merge: "one", "two\\n\\"", "three", "four", "five" and 2 more.');
    expect(branchPathSentence('Cannot merge', ['one'], 10)).toBe('Cannot merge: "one" and 9 more.');
    expect(branchPathSentence('Cannot merge', [])).toBe('Cannot merge.');
  });

  it('bounds even long multibyte and control-character names without inserting raw newlines', () => {
    const sentence = branchPathSentence(
      'Cannot merge',
      Array.from({ length: 7 }, () => '\n😀'.repeat(2000)),
    );
    expect(utf8(sentence).length).toBeLessThanOrEqual(2048);
    expect(sentence).not.toContain('\n');
    expect(sentence).toContain('…');
    expect(sentence).toContain('and 2 more.');
    expect(sentence.isWellFormed()).toBe(true);
  });
});
