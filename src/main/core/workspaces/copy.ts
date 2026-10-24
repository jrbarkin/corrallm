import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COPY_LIMITS,
  CopySelectionError,
  selectCopyFiles,
} from '../../../shared/model/worktree-setup';
import type { CopyCandidate } from '../../../shared/model/worktree-setup';
import type { TrustedPath } from '../host';
import { GitError } from './git';
import type { GitRunner } from './git';
import { EXCLUDED } from './owned';
import type { RepositoryRecord, WorktreeRecord } from './store';

/*
 * A new workspace's local files (B9a Design §4, Copy rules): the regular files of the picked
 * checkout that both the `.worktreeinclude` committed at the workspace's base commit selects (Git's
 * ignore rules, `selectCopyFiles`) and Git ignores there, copied into the workspace's verified
 * checkout before any agent runs in it. No file means nothing is copied: no `.env` is taken by
 * default. What a manifest selects is listed by Git (NUL-separated, no glob of a shell's), its
 * ignored status asked of Git, then each file checked on the file system:
 *
 * - never through a symlink on either side: every folder from the picked checkout down to a file,
 *   and from the workspace's checkout down to its copy, must be a real folder, the file itself a
 *   regular file, opened without following a link and checked to be the one listed;
 * - never over anything: a copy goes where nothing is (one already there with the same bytes, a
 *   crash's, is adopted), never over a file the workspace tracks or one changed there;
 * - never past the limits (COPY_LIMITS: the manifest's size, 256 files, 16 MiB each, 64 MiB in all),
 *   and never a part: a limit or an unsafe path refuses the whole copy before anything is written,
 *   and a failure part way takes back what it wrote;
 * - never `.git`, the workspaces' own folder (`.corral/worktrees/`) or the profile's.
 *
 * Copies are private (0600; 0700 for one its owner may run) and made whole before they appear. Its
 * record holds the names, sizes and hashes of what was copied, never what they hold: no copy's
 * contents go in a Need, a log, a transcript or a `.corral` file.
 */

/** What was copied into a workspace: names, sizes and hashes only. */
export interface CopyRecord {
  /** The `.worktreeinclude` blob at the base commit (none: there was none, so nothing copied). */
  manifest: string | null;
  files: { path: string; bytes: number; sha256: string }[];
  bytes: number;
  /** A hash of all of the above: the setup's copy manifest hash. */
  hash: string;
}

/** Why the copy was refused: nothing of it stays in the workspace. */
export type CopyFault =
  /** The `.worktreeinclude` at the base isn't a regular file, or isn't text. */
  | 'manifest'
  | 'manifest-bytes'
  /** Git couldn't list what it selects, or it selects too much to list. */
  | 'listing'
  | 'file-count'
  | 'file-bytes'
  | 'total-bytes'
  /** A name that isn't a safe relative one (`..`, absolute, `.git`, a control character...). */
  | 'unsafe-path'
  /** A symlink on either side. */
  | 'symlink'
  /** Something selected that isn't a regular file (a folder of a repository of its own...). */
  | 'not-regular'
  /** The workspace tracks a file there. */
  | 'tracked'
  /** Something else is where a copy would go. */
  | 'exists'
  /** A file changed while it was being copied. */
  | 'changed'
  /** The file system failed. */
  | 'io';

export class CopyError extends Error {
  readonly code: CopyFault;
  /** The file it is about, relative to the checkout, if one. */
  readonly file: string | undefined;
  constructor(code: CopyFault, message: string, file?: string) {
    super(message);
    this.name = 'CopyError';
    this.code = code;
    this.file = file;
  }
}

/** The repository-root file that selects local files, by Git's ignore rules. */
export const MANIFEST = '.worktreeinclude';
/** At most this many files a manifest selects are listed, ignored or not, before giving up. */
const MAX_LISTED = 4096;
/** Paths asked of Git at once, by their bytes. */
const MAX_ASKED_BYTES = 64 * 1024;
const LIST_TIMEOUT_MS = 60_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Not following a final symlink as a file is opened: Windows has no such flag. */
export const O_NOFOLLOW: number = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export interface CopyRequest {
  repository: RepositoryRecord;
  worktree: WorktreeRecord;
  /** The workspace's checkout, verified at this use (checkout.ts). */
  cwd: TrustedPath;
  /** The profile's folder: nothing in it is ever copied. */
  profile?: string;
}

/** Copies the workspace's selected local files in: what was copied, or a CopyError, copying none. */
export async function copyLocalFiles(git: GitRunner, request: CopyRequest): Promise<CopyRecord> {
  const { repository, worktree, cwd } = request;
  const source = repository.realRoot;
  const target = cwd as string;
  checkRoot(source);
  checkRoot(target);
  // Profiles may have been opened through a symlink or a different spelling of their path.
  // Compare their real location, rather than allowing an alias to bypass the exclusion.
  const profile = request.profile === undefined ? undefined : realpathSync(request.profile);
  // Read from the picked checkout's object database: the base commit is the repository's.
  const manifest = await readManifest(git, source, worktree.baseOid);
  if (manifest === undefined) return recordOf(null, []);
  const listed = await selected(git, source, manifest.text);
  const ignored = await ignoredOf(git, source, listed);
  const candidates: CopyCandidate[] = [];
  /** What isn't a regular file, by name: refused if it is selected. */
  const unsafe = new Map<string, { fault: CopyFault; why: string }>();
  const found = new Map<string, Stats>();
  for (const file of listed) {
    if (file.endsWith('/')) {
      unsafe.set(file, { fault: 'not-regular', why: `${file} is a repository of its own.` });
      candidates.push({ path: file.slice(0, -1), bytes: 0, ignored: ignored.has(file) });
      continue;
    }
    const at = sourceFile(source, file, profile);
    if ('fault' in at) {
      unsafe.set(file, at);
      candidates.push({ path: file, bytes: 0, ignored: ignored.has(file) });
      continue;
    }
    found.set(file, at.stats);
    candidates.push({ path: file, bytes: at.stats.size, ignored: ignored.has(file) });
  }
  let selection: ReturnType<typeof selectCopyFiles>;
  try {
    selection = selectCopyFiles(manifest.text, candidates);
  } catch (error) {
    if (!(error instanceof CopySelectionError)) throw error;
    throw selectionError(error);
  }
  for (const { path: file } of selection.files) {
    const bad = unsafe.get(file) ?? unsafe.get(`${file}/`);
    if (bad !== undefined) throw new CopyError(bad.fault, bad.why, file);
  }
  const files = selection.files.map(({ path: file }) => file);
  await refuseTracked(git, target, files);
  // Every copy's place checked before anything is written: a refusal leaves nothing behind.
  for (const file of files) destination(target, file, false);
  const made: { at: string; ino: number }[] = [];
  const folders: string[] = [];
  const copied: CopyRecord['files'] = [];
  try {
    for (const file of files) {
      const stats = found.get(file);
      if (stats === undefined) throw new CopyError('changed', `${file} changed.`, file);
      const bytes = readSource(source, file, stats, profile);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const { dir, at, made: newFolders } = destination(target, file, true);
      folders.push(...newFolders);
      const there = existing(at, file);
      if (there === undefined) {
        made.push(writeCopy(dir, at, bytes, (stats.mode & 0o111) === 0 ? 0o600 : 0o700));
      } else if (there !== sha256) {
        throw new CopyError('exists', `${file} is in the worktree already, changed.`, file);
      }
      copied.push({ path: file, bytes: bytes.length, sha256 });
    }
  } catch (error) {
    // Nothing of a copy refused part way stays: what it wrote is taken back.
    for (const { at, ino } of made.reverse()) {
      try {
        if (lstatSync(at).ino === ino) unlinkSync(at);
      } catch {
        // Gone already.
      }
    }
    for (const folder of folders.reverse()) {
      try {
        rmdirSync(folder);
      } catch {
        // Not empty, or gone: left as it is.
      }
    }
    if (error instanceof CopyError) throw error;
    throw new CopyError('io', `The local files couldn’t be copied: ${(error as Error).message}`);
  }
  return recordOf(manifest.blob, copied);
}

/** The manifest committed at `oid`: none if there is none; refused if it isn't a regular text file. */
async function readManifest(
  git: GitRunner,
  cwd: string,
  oid: string,
): Promise<{ blob: string; text: string } | undefined> {
  const { stdout } = await gitCall(git, {
    cwd,
    args: ['ls-tree', '-z', '-l', '--end-of-options', oid, '--', MANIFEST],
  });
  const entry = stdout.split('\0').find((line) => line.endsWith(`\t${MANIFEST}`));
  if (entry === undefined) return undefined;
  const fields = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)\t/.exec(entry);
  if (fields === null)
    throw new CopyError('manifest', `Git’s listing of ${MANIFEST} isn’t one it reads.`);
  const [, mode, type, blob, size] = fields;
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || blob === undefined) {
    throw new CopyError(
      'manifest',
      `${MANIFEST} at the base commit isn’t a regular file.`,
      MANIFEST,
    );
  }
  if (Number(size) > COPY_LIMITS.manifestBytes) {
    throw new CopyError(
      'manifest-bytes',
      `${MANIFEST} is over ${String(COPY_LIMITS.manifestBytes / 1024)} KiB.`,
      MANIFEST,
    );
  }
  const { stdout: text } = await gitCall(git, {
    cwd,
    args: ['cat-file', 'blob', blob],
    maxBytes: COPY_LIMITS.manifestBytes + 1,
  });
  if (Buffer.byteLength(text, 'utf8') > COPY_LIMITS.manifestBytes) {
    throw new CopyError('manifest-bytes', `${MANIFEST} is over its limit.`, MANIFEST);
  }
  if (text.includes('�') || text.includes('\0')) {
    throw new CopyError('manifest', `${MANIFEST} isn’t UTF-8 text.`, MANIFEST);
  }
  return { blob, text };
}

/**
 * What of the picked checkout's untracked files the manifest selects, as Git matches it (its own
 * ignore rules: `--exclude-from`, without the checkout's own), never past MAX_LISTED. Never in the
 * workspaces' own folder.
 */
async function selected(git: GitRunner, source: string, manifest: string): Promise<string[]> {
  const folder = mkdtempSync(path.join(tmpdir(), 'corrallm-include-'));
  try {
    const rules = path.join(folder, 'include');
    writeFileSync(rules, manifest, { mode: 0o600, flag: 'wx' });
    const { stdout } = await gitCall(git, {
      cwd: source,
      args: ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${rules}`],
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const listed = stdout.split('\0').filter((file) => file !== '' && !owned(file));
    if (listed.length > MAX_LISTED) {
      throw new CopyError(
        'listing',
        `${MANIFEST} selects more than ${String(MAX_LISTED)} files: name the local files it is for.`,
      );
    }
    return listed;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Which of `files` Git ignores in the picked checkout, by its own rules, asked by literal name. */
async function ignoredOf(
  git: GitRunner,
  source: string,
  files: readonly string[],
): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (const batch of batches(files)) {
    const { stdout } = await gitCall(git, {
      cwd: source,
      args: [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...batch.map((file) => `:(literal)${file.endsWith('/') ? file.slice(0, -1) : file}`),
      ],
      timeoutMs: LIST_TIMEOUT_MS,
    });
    for (const file of stdout.split('\0')) if (file !== '') ignored.add(file);
  }
  return ignored;
}

/** Refuses a copy of a file the workspace's checkout tracks: it is the base's, never replaced. */
async function refuseTracked(git: GitRunner, target: string, files: readonly string[]) {
  for (const batch of batches(files)) {
    const { stdout } = await gitCall(git, {
      cwd: target,
      // Refuse aliases too: a picked checkout may have untracked a different spelling from
      // the base, and a case-insensitive worktree would otherwise adopt its tracked file.
      args: ['ls-files', '-z', '--', ...batch.map((file) => `:(icase,literal)${file}`)],
    });
    const tracked = stdout.split('\0').find((file) => file !== '');
    if (tracked !== undefined) {
      throw new CopyError(
        'tracked',
        `The worktree tracks ${tracked}: it isn’t copied over.`,
        tracked,
      );
    }
  }
}

function batches(files: readonly string[]): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file, 'utf8') + 12;
    if (batch.length > 0 && bytes + size > MAX_ASKED_BYTES) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** Whether a name is in the workspaces' own folder of the checkout. */
function owned(file: string): boolean {
  const prefix = EXCLUDED.slice(1);
  return file === prefix.slice(0, -1) || file.startsWith(prefix) || file === '.corral/';
}

/** A name safe to join to a checkout: relative, POSIX, no `..`, `.git` or control character. */
function safeName(file: string): boolean {
  if (file === '' || CONTROL.test(file) || file.includes('\\') || path.posix.isAbsolute(file)) {
    return false;
  }
  return file
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** A selected file of the picked checkout, checked: real folders down to it, a regular file. */
function sourceFile(
  source: string,
  file: string,
  profile: string | undefined,
): { stats: Stats } | { fault: CopyFault; why: string } {
  checkRoot(source);
  if (!safeName(file))
    return { fault: 'unsafe-path', why: `${JSON.stringify(file)} isn’t a safe name.` };
  const parts = file.split('/');
  let at = source;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    const stats = lstatOrNone(at);
    if (stats === undefined) return { fault: 'changed', why: `${file} is gone.` };
    if (stats.isSymbolicLink()) return { fault: 'symlink', why: `${file} is beneath a symlink.` };
    if (!stats.isDirectory()) return { fault: 'not-regular', why: `${file} isn’t in a folder.` };
  }
  const full = path.join(source, ...parts);
  if (profile !== undefined && within(profile, full)) {
    return { fault: 'unsafe-path', why: `${file} is in corrallm’s own profile folder.` };
  }
  const stats = lstatOrNone(full);
  if (stats === undefined) return { fault: 'changed', why: `${file} is gone.` };
  if (stats.isSymbolicLink()) return { fault: 'symlink', why: `${file} is a symlink.` };
  if (!stats.isFile() || stats.nlink !== 1) {
    return { fault: 'not-regular', why: `${file} isn’t a regular file with just one link.` };
  }
  return { stats };
}

/** The file's bytes, read without following a link, from the very file listed. */
function readSource(
  source: string,
  file: string,
  listed: Stats,
  profile: string | undefined,
): Buffer {
  const again = sourceFile(source, file, profile);
  if ('fault' in again) throw new CopyError(again.fault, again.why, file);
  const at = path.join(source, ...file.split('/'));
  let fd: number;
  try {
    fd = openSync(at, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW);
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ELOOP'
      ? new CopyError('symlink', `${file} is a symlink.`, file)
      : new CopyError('changed', `${file} couldn’t be opened.`, file);
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== listed.ino ||
      opened.dev !== listed.dev ||
      opened.size !== listed.size
    ) {
      throw new CopyError('changed', `${file} changed while it was copied.`, file);
    }
    if (opened.size > COPY_LIMITS.fileBytes) {
      throw new CopyError('file-bytes', `${file} is over its limit.`, file);
    }
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    // One more byte than it had is a file still being written.
    if (read !== bytes.length || readSync(fd, Buffer.alloc(1), 0, 1, read) !== 0) {
      throw new CopyError('changed', `${file} changed while it was copied.`, file);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Where a copy goes in the workspace's checkout: every folder from it down a real folder (made,
 * private, if missing and `make`), never a symlink. Returns the folders it made.
 */
function destination(
  target: string,
  file: string,
  make: boolean,
): { dir: string; at: string; made: string[] } {
  checkRoot(target);
  if (!safeName(file))
    throw new CopyError('unsafe-path', `${JSON.stringify(file)} isn’t a safe name.`, file);
  const parts = file.split('/');
  const made: string[] = [];
  let dir = target;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const stats = lstatOrNone(dir);
    if (stats === undefined) {
      if (!make) continue;
      mkdirSync(dir, { mode: 0o700 });
      made.push(dir);
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new CopyError(
        'symlink',
        `${file} would be written through a symlink in the worktree.`,
        file,
      );
    }
    if (!stats.isDirectory()) {
      throw new CopyError('exists', `${file} would go where the worktree has a file.`, file);
    }
  }
  const at = path.join(dir, parts.at(-1) ?? '');
  const there = lstatOrNone(at);
  if (there?.isSymbolicLink() === true) {
    throw new CopyError('symlink', `${file} is a symlink in the worktree.`, file);
  }
  if (there !== undefined && !there.isFile()) {
    throw new CopyError('exists', `${file} is in the worktree already.`, file);
  }
  return { dir, at, made };
}

/** Verification predates Git's asynchronous listing: do not follow a root swapped since then. */
function checkRoot(root: string): void {
  const stats = lstatOrNone(root);
  if (stats?.isSymbolicLink() === true || (stats !== undefined && realpathSync(root) !== root)) {
    throw new CopyError('symlink', 'A checkout’s root now goes through a symlink.');
  }
  if (stats?.isDirectory() !== true) {
    throw new CopyError('changed', 'A checkout’s root is no longer there as a folder.');
  }
}

/** The hash of what is at a copy's place already: none if nothing is. */
function existing(at: string, file: string): string | undefined {
  const stats = lstatOrNone(at);
  if (stats === undefined) return undefined;
  if (!stats.isFile()) throw new CopyError('exists', `${file} is in the worktree already.`, file);
  if (stats.nlink !== 1 || (stats.mode & 0o077) !== 0) {
    throw new CopyError('exists', `${file} isn’t a private copy with just one link.`, file);
  }
  const fd = openSync(at, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      opened.ino !== stats.ino ||
      opened.dev !== stats.dev
    ) {
      throw new CopyError('changed', `${file} changed while its copy was checked.`, file);
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    for (let at = 0; ;) {
      const n = readSync(fd, chunk, 0, chunk.length, at);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
      at += n;
      if (at > COPY_LIMITS.fileBytes) break;
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** A copy written whole beside its place, then linked there: never over anything. */
function writeCopy(
  dir: string,
  at: string,
  bytes: Buffer,
  mode: number,
): { at: string; ino: number } {
  const partial = path.join(dir, `.corrallm-copy-${randomUUID()}`);
  const fd = openSync(
    partial,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    mode,
  );
  const inode = fstatSync(fd).ino;
  let closed = false;
  let linked = false;
  try {
    for (let written = 0; written < bytes.length;) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    // A link fails if anything is there: nothing is ever copied over.
    linkSync(partial, at);
    linked = true;
    rmSync(partial, { force: true });
    if (process.platform !== 'win32') {
      const folder = openSync(dir, 'r');
      try {
        fsyncSync(folder);
      } finally {
        closeSync(folder);
      }
    }
    return { at, ino: inode };
  } catch (error) {
    // The caller cannot record this file until we return. Take it back here if publication or
    // its directory flush failed; the same is true of a partial whose write/flush failed.
    if (linked && lstatOrNone(at)?.ino === inode) unlinkSync(at);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CopyError('exists', `${path.basename(at)} appeared in the worktree.`);
    }
    throw error;
  } finally {
    if (!closed) closeSync(fd);
    if (lstatOrNone(partial)?.ino === inode) unlinkSync(partial);
  }
}

function recordOf(manifest: string | null, files: CopyRecord['files']): CopyRecord {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bytes = sorted.reduce((sum, file) => sum + file.bytes, 0);
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest,
        files: sorted.map((file) => [file.path, file.bytes, file.sha256]),
      }),
    )
    .digest('hex');
  return { manifest, files: sorted, bytes, hash };
}

function selectionError(error: CopySelectionError): CopyError {
  const file = error.file;
  switch (error.code) {
    case 'manifest-bytes':
      return new CopyError('manifest-bytes', `${MANIFEST} is over its limit.`, MANIFEST);
    case 'file-count':
      return new CopyError(
        'file-count',
        `${MANIFEST} selects more than ${String(COPY_LIMITS.files)} files: none is copied.`,
      );
    case 'file-bytes':
      return new CopyError(
        'file-bytes',
        `${file ?? 'A file'} is over ${String(COPY_LIMITS.fileBytes / 1024 / 1024)} MiB: none is copied.`,
        file,
      );
    case 'total-bytes':
      return new CopyError(
        'total-bytes',
        `What ${MANIFEST} selects is over ${String(COPY_LIMITS.totalBytes / 1024 / 1024)} MiB in all: none is copied.`,
      );
    default:
      return new CopyError(
        'unsafe-path',
        `${JSON.stringify(file ?? '')} isn’t a name it copies.`,
        file,
      );
  }
}

async function gitCall(git: GitRunner, call: Parameters<GitRunner['run']>[0]) {
  try {
    return await git.run(call);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (error.fault === 'refused' || error.fault === 'hooks') throw error;
    throw new CopyError('listing', `Git couldn’t list the local files to copy: ${error.message}`);
  }
}

function lstatOrNone(at: string): Stats | undefined {
  try {
    return lstatSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CopyError('io', `${at} can’t be read.`);
  }
}

function within(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
