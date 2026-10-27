import { BRANCH_LIMITS, BranchAfter, BranchDiffOutput, BranchLimit } from '../api/branch';
import type { BranchFile } from '../api/branch';
import type { OpResult } from '../api/errors';
import { MAX_PAGE_BYTES } from '../api/limits';
import { BranchState, branchPosition, encodeBranchCursor } from './branch-review';

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text).length;
const jsonBytes = (value: unknown) => utf8(JSON.stringify(value));

export interface BranchPatch {
  patch?: string;
  binary?: true;
  cut?: true;
}

/** Complete lines only when cut; a complete, uncut last line need not have a newline. */
export function cutBranchPatch(
  patch: string,
  budget: number,
  sourceCut = false,
): { patch: string; cut?: true } {
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new RangeError('A nonnegative byte budget is required.');
  patch = patch.toWellFormed();
  if (!sourceCut && utf8(patch) <= budget) return { patch };
  let size = 0,
    end = 0,
    line = 0;
  for (const character of patch) {
    size += utf8(character);
    if (size > budget) break;
    end += character.length;
    if (character === '\n') line = end;
  }
  return { patch: patch.slice(0, line), cut: true };
}

/** Display only: never pass a lossy name back to Git. */
export function branchPath(bytes: Uint8Array): { path: string; note?: 'lossy-name' } {
  const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  let valid = true;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    valid = false;
  }
  if (valid && utf8(decoded) <= BRANCH_LIMITS.pathBytes) return { path: decoded };
  const path =
    utf8(decoded) <= BRANCH_LIMITS.pathBytes
      ? decoded
      : prefix(decoded, BRANCH_LIMITS.pathBytes - utf8('�')) + '�';
  return { path, note: 'lossy-name' };
}

/** Render already-read bytes, never reading a file, following a link or starting diff --no-index. */
export function untrackedFilePatch(
  path: string,
  bytes: Uint8Array,
  options: { cut?: boolean; symlink?: boolean; executable?: boolean } = {},
): BranchPatch {
  const input = bytes.subarray(0, BRANCH_LIMITS.untrackedBytes);
  if (input.subarray(0, BRANCH_LIMITS.binaryProbeBytes).includes(0)) return { binary: true };
  const sourceCut = options.cut === true || bytes.length > input.length;
  let text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(input);
  // An upstream byte cap may stop mid-codepoint or mid-line. Neither is a complete diff line.
  if (sourceCut) text = text.slice(0, text.lastIndexOf('\n') + 1);
  const from = quoteGitPath(`a/${path}`),
    to = quoteGitPath(`b/${path}`);
  const mode = options.symlink ? '120000' : options.executable ? '100755' : '100644';
  let patch = `diff --git ${from} ${to}\nnew file mode ${mode}\n--- /dev/null\n+++ ${to}\n`;
  if (text !== '') {
    const ends = text.endsWith('\n');
    const lines = text.split('\n');
    if (ends) lines.pop();
    patch += `@@ -0,0 +1${lines.length === 1 ? '' : `,${String(lines.length)}`} @@\n`;
    patch += lines.map((line) => `+${line}\n`).join('');
    if (!ends) patch += '\\ No newline at end of file\n';
  }
  return cutBranchPatch(patch, MAX_PAGE_BYTES, sourceCut);
}

/** Git-style quoted names prevent a name's newline from inventing a patch header. */
function quoteGitPath(path: string): string {
  let needsQuotes = /[\s"\\]/u.test(path);
  for (const char of path)
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) needsQuotes = true;
  if (!needsQuotes) return path;
  const escapes: Readonly<Record<string, string>> = {
    '\u0007': '\\a',
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\u000b': '\\v',
    '\f': '\\f',
    '\r': '\\r',
    '"': '\\"',
    '\\': '\\\\',
  };
  let quoted = '';
  for (const char of path) {
    const code = char.charCodeAt(0);
    quoted +=
      escapes[char] ??
      (code < 32 || code === 127 ? `\\${code.toString(8).padStart(3, '0')}` : char);
  }
  return `"${quoted}"`;
}

export type BranchDiffHeader = Omit<BranchDiffOutput, 'files' | 'next'>;
export interface BranchPageOptions {
  after?: string | undefined;
  limit?: number;
  /** The review's state (`BranchState`), as the core read it for this page. */
  state: string;
}

/**
 * Budget the serialized result, including its header and actual continuation. The service supplies
 * bounded inventories in their frozen order (committed first, then uncommitted by path bytes).
 * Successful nonempty inventories always advance by at least one file, including a cut patch.
 */
export function branchDiffPage(
  header: BranchDiffHeader,
  inventory: readonly BranchFile[],
  options: BranchPageOptions,
): OpResult<BranchDiffOutput> {
  const parsedLimit = BranchLimit.safeParse(options.limit);
  if (
    !parsedLimit.success ||
    (options.after !== undefined && !BranchAfter.safeParse(options.after).success)
  )
    return invalidPage();
  const current = {
    tip: header.source.oid,
    digest: header.uncommitted.digest,
    state: BranchState.parse(options.state),
  };
  const position = branchPosition(options.after, current);
  if (!position.ok) return position;
  if (position.value > inventory.length) return invalidPage();
  const count = (section: BranchFile['section']) =>
    inventory.filter((file) => file.section === section).length;
  if (
    count('committed') > BRANCH_LIMITS.inventoryEntries ||
    count('uncommitted') > BRANCH_LIMITS.inventoryEntries
  )
    throw new RangeError('Supply the bounded inventories, with complete/count metadata.');
  const files: BranchFile[] = [];
  const result = (end: number): BranchDiffOutput => ({
    ...header,
    files,
    next:
      end < inventory.length ? encodeBranchCursor({ version: 1, ...current, position: end }) : null,
  });
  let end = position.value;
  for (const original of inventory.slice(end, end + parsedLimit.data)) {
    let file =
      original.cut && original.patch !== undefined
        ? { ...original, ...cutBranchPatch(original.patch, MAX_PAGE_BYTES, true) }
        : original;
    const fits = (candidate: BranchFile) =>
      jsonBytes({ ...result(end + 1), files: [...files, candidate] }) <= MAX_PAGE_BYTES;
    if (!fits(file) && file.patch !== undefined) {
      const patch = file.patch;
      file = { ...file, patch: '', cut: true };
      if (fits(file)) {
        // JSON escaping is part of the budget. Monotonic byte-prefix search, rounded down to a line.
        let low = 0,
          high = Math.min(utf8(patch), MAX_PAGE_BYTES);
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          const candidate = { ...file, ...cutBranchPatch(patch, middle, true) };
          if (fits(candidate)) low = middle;
          else high = middle - 1;
        }
        file = { ...file, ...cutBranchPatch(patch, low, true) };
      }
    }
    if (!fits(file)) break;
    files.push(file);
    end++;
  }
  if (
    (files.length === 0 && position.value < inventory.length) ||
    jsonBytes(result(end)) > MAX_PAGE_BYTES
  )
    return {
      ok: false,
      error: { code: 'unavailable', sentence: 'The review metadata cannot fit in a page.' },
    };
  return { ok: true, value: BranchDiffOutput.parse(result(end)) };
}

function invalidPage(): OpResult<never> {
  return {
    ok: false,
    error: { code: 'invalid', sentence: 'Invalid review page: review the changes again.' },
  };
}

/** A bounded sentence with at most five escaped relative names and the number omitted. */
export function branchPathSentence(
  reason: string,
  paths: readonly string[],
  total = paths.length,
): string {
  if (utf8(reason) > 512 || !Number.isSafeInteger(total) || total < paths.length)
    throw new RangeError('Supply a short reason and the full count of paths.');
  const shown = paths.slice(0, BRANCH_LIMITS.sentencePaths).map(quotedPath);
  const more = total - shown.length;
  return `${reason}${shown.length ? `: ${shown.join(', ')}` : ''}${more ? ` and ${String(more)} more` : ''}.`;
}

function quotedPath(path: string): string {
  path = path.toWellFormed();
  if (utf8(JSON.stringify(path)) <= BRANCH_LIMITS.quotedPathBytes) return JSON.stringify(path);
  let kept = '';
  for (const character of path) {
    if (utf8(JSON.stringify(kept + character + '…')) > BRANCH_LIMITS.quotedPathBytes) break;
    kept += character;
  }
  return JSON.stringify(kept + '…');
}

function prefix(text: string, budget: number): string {
  let end = 0,
    bytes = 0;
  for (const character of text) {
    bytes += utf8(character);
    if (bytes > budget) break;
    end += character.length;
  }
  return text.slice(0, end);
}
