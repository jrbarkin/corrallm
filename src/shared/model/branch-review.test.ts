import { describe, expect, it } from 'vitest';

import { BRANCH_LIMITS } from '../api/branch';
import {
  branchPosition,
  decodeBranchCursor,
  encodeBranchCursor,
  uncommittedDigest,
  uncommittedManifest,
} from './branch-review';

const utf8 = (value: string) => new TextEncoder().encode(value);
const tip = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const cursor = { version: 1 as const, tip, digest, position: 51 };
const entry = (path: string, mode = '100644', oid = 'b'.repeat(40)) => ({
  path: utf8(path),
  mode,
  oid,
});

describe('stateless branch continuations', () => {
  it('round trips both object formats, null digests and the inventory end in bounded base64url', () => {
    for (const value of [
      cursor,
      { ...cursor, tip: 'c'.repeat(64), digest: null, position: 20_000 },
    ]) {
      const encoded = encodeBranchCursor(value);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded.length).toBeLessThanOrEqual(512);
      expect(decodeBranchCursor(encoded)).toEqual({ ok: true, value });
    }
  });

  it('refuses malformed, noncanonical, future, extra-key and out-of-range cursors', () => {
    const encode = (data: unknown) =>
      btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const value of [
      '',
      'a'.repeat(513),
      '!',
      'e30=',
      'e31',
      'a',
      encode({ ...cursor, version: 2 }),
      encode({ ...cursor, position: -1 }),
      encode({ ...cursor, position: 20_001 }),
      encode({ ...cursor, position: 1.5 }),
      encode({ ...cursor, tip: '--all' }),
      encode({ ...cursor, path: '/somewhere' }),
      encode({ ...cursor, digest: 'bad' }),
      encode(JSON.stringify(cursor)),
    ])
      expect(decodeBranchCursor(value)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('compares the supplied pins, returning conflict on change and invalid on malformed input', () => {
    expect(branchPosition(undefined, { tip, digest })).toEqual({ ok: true, value: 0 });
    expect(branchPosition(encodeBranchCursor(cursor), { tip, digest })).toEqual({
      ok: true,
      value: 51,
    });
    for (const current of [
      { tip: 'c'.repeat(40), digest },
      { tip, digest: null },
      { tip, digest: 'd'.repeat(64) },
    ])
      expect(branchPosition(encodeBranchCursor(cursor), current)).toMatchObject({
        ok: false,
        error: { code: 'conflict' },
      });
    expect(branchPosition('--all', { tip, digest })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
  });
});

describe('uncommitted review manifest', () => {
  it('uses the frozen byte format, byte order rather than locale/UTF-16, and deletion zero OIDs', () => {
    const entries = [
      entry('𐀀'),
      entry('\ue000'),
      entry('deleted', '000000', '0'.repeat(40)),
      entry('a\tline\n'),
      entry('link', '120000'),
    ];
    const expected =
      `corrallm uncommitted 1\0${tip}\0` +
      `100644 ${'b'.repeat(40)}\ta\tline\n\0` +
      `000000 ${'0'.repeat(40)}\tdeleted\0` +
      `120000 ${'b'.repeat(40)}\tlink\0` +
      `100644 ${'b'.repeat(40)}\t\ue000\0` +
      `100644 ${'b'.repeat(40)}\t𐀀\0`;
    expect(uncommittedManifest(tip, entries)).toEqual(utf8(expected));
    expect(
      new TextDecoder().decode(
        uncommittedManifest('c'.repeat(64), [entry('gone', '000000', '0'.repeat(64))]),
      ),
    ).toBe(`corrallm uncommitted 1\0${'c'.repeat(64)}\0` + `000000 ${'0'.repeat(64)}\tgone\0`);
  });

  it('hashes the canonical bytes with SHA-256, independent of input order, without mutating entries', async () => {
    // Known SHA-256 values computed independently for the frozen format.
    expect(await uncommittedDigest(tip, [])).toBe(
      '67a9699a9cfe39f0ed94a4c8a2d74aaa2bbc7994d270bbcd5d41d38a13db82d7',
    );
    const entries = [entry('b'), entry('a')];
    expect(await uncommittedDigest(tip, entries)).toBe(
      'b0ae39f41b28386f2ba4d350de99d7b7733e3f077d132cde5b7ba02a5986b3e3',
    );
    expect(await uncommittedDigest(tip, [...entries].reverse())).toBe(
      await uncommittedDigest(tip, entries),
    );
    expect(entries.map(({ path }) => new TextDecoder().decode(path))).toEqual(['b', 'a']);
    expect(await uncommittedDigest('c'.repeat(40), entries)).not.toBe(
      await uncommittedDigest(tip, entries),
    );
    expect(await uncommittedDigest(tip, [entry('b', '100755'), entry('a')])).not.toBe(
      await uncommittedDigest(tip, entries),
    );
  });

  it('refuses ambiguous, lossy, duplicate, oversized and unsupported entries instead of digesting a partial inventory', () => {
    for (const entries of [
      [entry('a'), entry('a')],
      [entry('a\0b')],
      [entry('../a')],
      [entry('/a')],
      [entry('a//b')],
      [entry('a', '160000')],
      [entry('a', '000000')],
      [entry('a', '100644', 'b'.repeat(64))],
      [entry('a', '100644', 'B'.repeat(40))],
      [entry('x'.repeat(4097))],
      [{ ...entry('a'), path: new Uint8Array([0xff]) }],
      Array.from({ length: BRANCH_LIMITS.inventoryEntries + 1 }, (_, i) => entry(String(i))),
    ])
      expect(() => uncommittedManifest(tip, entries)).toThrow();
  });
});
