import { z } from 'zod';

import { BRANCH_LIMITS, BranchAfter, BranchDigest, BranchOid } from '../api/branch';
import type { OpResult } from '../api/errors';

/**
 * The review's state: a SHA-256 the core computes over everything a page's entries are read from
 * (the workspace, its base, its tip, and the worktree as Git and the file system had it), so a
 * continuation is refused wherever the work changed, even where the uncommitted digest is null.
 */
export const BranchState = BranchDigest;

const Cursor = z.strictObject({
  version: z.literal(1),
  tip: BranchOid,
  digest: BranchDigest.nullable(),
  state: BranchState,
  position: z
    .int()
    .min(0)
    .max(2 * BRANCH_LIMITS.inventoryEntries),
});
export type BranchCursor = z.infer<typeof Cursor>;
export type BranchReview = Pick<BranchCursor, 'tip' | 'digest' | 'state'>;

/** Opaque compared values only: no cursor component is ever a Git argument or a reach id. */
export function encodeBranchCursor(value: BranchCursor): string {
  const parsed = Cursor.parse(value);
  // The closed schema contains ASCII only. Fixed key order also makes encodings canonical.
  return btoa(JSON.stringify(parsed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBranchCursor(after: string): OpResult<BranchCursor> {
  try {
    BranchAfter.parse(after);
    const json: unknown = JSON.parse(atob(after.replace(/-/g, '+').replace(/_/g, '/')));
    const cursor = Cursor.parse(json);
    if (encodeBranchCursor(cursor) === after) return { ok: true, value: cursor };
  } catch {
    // A malformed cursor is a value, not a failed Git read or an empty page.
  }
  return {
    ok: false,
    error: { code: 'invalid', sentence: 'Invalid review cursor: review the changes again.' },
  };
}

/** Stateless continuation: callers still resolve reach and the workspace on every page. */
export function branchPosition(after: string | undefined, current: BranchReview): OpResult<number> {
  if (after === undefined) return { ok: true, value: 0 };
  const decoded = decodeBranchCursor(after);
  if (!decoded.ok) return decoded;
  if (
    decoded.value.tip !== current.tip ||
    decoded.value.digest !== current.digest ||
    decoded.value.state !== current.state
  )
    return {
      ok: false,
      error: { code: 'conflict', sentence: 'The work changed since you looked: review it again.' },
    };
  return { ok: true, value: decoded.value.position };
}

/** Already inventoried facts. Obtaining blob OIDs and deciding eligibility belong to the core. */
export interface UncommittedEntry {
  readonly path: Uint8Array;
  readonly mode: string;
  readonly oid: string;
}

/** The frozen canonical manifest, with raw UTF-8 path bytes, sorted without locale or normalization. */
export function uncommittedManifest(
  tip: string,
  entries: readonly UncommittedEntry[],
): Uint8Array<ArrayBuffer> {
  BranchOid.parse(tip);
  if (entries.length > BRANCH_LIMITS.inventoryEntries)
    throw new RangeError('The inventory is incomplete.');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const sorted = [...entries].sort((a, b) => compareBytes(a.path, b.path));
  const chunks: Uint8Array[] = [encoder.encode(`corrallm uncommitted 1\0${tip}\0`)];
  let previous: Uint8Array | undefined;
  for (const entry of sorted) {
    const { mode, oid, path } = entry;
    const name = decoder.decode(path);
    if (
      !['000000', '100644', '100755', '120000'].includes(mode) ||
      !BranchOid.safeParse(oid).success ||
      oid.length !== tip.length ||
      (mode === '000000' && oid !== '0'.repeat(tip.length)) ||
      path.length === 0 ||
      path.length > BRANCH_LIMITS.pathBytes ||
      name.includes('\0') ||
      name.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      (previous !== undefined && compareBytes(previous, path) === 0)
    )
      throw new TypeError('Not a complete, unambiguous uncommitted entry.');
    chunks.push(encoder.encode(`${mode} ${oid}\t`), path, new Uint8Array([0]));
    previous = path;
  }
  const result = new Uint8Array(chunks.reduce((bytes, chunk) => bytes + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Deterministic SHA-256 computation only; no Node, filesystem, Git or core dependency. */
export async function uncommittedDigest(
  tip: string,
  entries: readonly UncommittedEntry[],
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    uncommittedManifest(tip, entries),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
