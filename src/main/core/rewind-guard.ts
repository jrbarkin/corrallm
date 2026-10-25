import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

/*
 * R5's stale guard (B11 Design §7, §16.6): a token's code-restoring rewind applies nothing until
 * you Allow it, and Allow applies it only to what you were shown. The proposal keeps what the
 * restore was of (the adapter, the native conversation, the message, the connection and the
 * workspace generation the session runs at) and every file the rewind's preview said it changes,
 * each by its size, modification time and SHA-256, at most MAX_GUARDED_FILES of them (more is too
 * many to propose). Allow reads all of it again under the workspace mutation gate: any difference
 * (the files changed since, the session another, the preview another) settles it stale, so a restore
 * never overwrites work you haven't seen. The files are only read, to hash them, never shown.
 */

/** The most files a proposal of a code restore may guard: more is too many to propose. */
export const MAX_GUARDED_FILES = 200;
/** The most of a file hashed: its size and modification time cover the rest. */
export const MAX_HASHED_BYTES = 64 * 1024 * 1024;

/** A file as the guard keeps it: by its preview path; null fields for one that isn't there. */
export interface GuardedFile {
  path: string;
  size: number | null;
  mtimeMs: number | null;
  sha256: string | null;
}

/** What a code restore was of, as proposed (B11 §16.6). */
export interface RewindGuard {
  adapter: string;
  /** The agent's native conversation then (none: it had none remembered). */
  conversation: string | null;
  message: string;
  connection: string;
  /** The active binding generation its session ran at (none: no session). */
  workspaceGeneration: number | null;
  files: GuardedFile[];
}

const Text = z.string().max(4096);
/** How a guard reads back from a proposal: strictly, or not at all. */
export const RewindGuardSchema = z.strictObject({
  adapter: z.string().max(64),
  conversation: z.string().max(128).nullable(),
  message: z.string().max(512),
  connection: z.string().max(64),
  workspaceGeneration: z.number().int().min(0).nullable(),
  files: z
    .array(
      z.strictObject({
        path: Text,
        size: z.number().int().min(0).nullable(),
        mtimeMs: z.number().min(0).nullable(),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      }),
    )
    .max(MAX_GUARDED_FILES),
});

/** Whether two guards are of the same thing, file for file. */
export function sameGuard(a: RewindGuard, b: RewindGuard): boolean {
  return isDeepStrictEqual(a, b);
}

/**
 * Each of a preview's files (`files`, as it names them: relative to the session's folder `cwd`, `~`
 * for `home`, or absolute) as it is now: its size, modification time and SHA-256 (of its first
 * MAX_HASHED_BYTES; a symbolic link's of its target's name, never followed), or nulls for one that
 * isn't there. Throws for more than MAX_GUARDED_FILES.
 */
export async function guardedFiles(
  cwd: string,
  home: string,
  files: readonly string[],
): Promise<GuardedFile[]> {
  if (files.length > MAX_GUARDED_FILES) {
    throw new RangeError(
      `It would change ${String(files.length)} files, more than the ${String(MAX_GUARDED_FILES)} a restore can be proposed for.`,
    );
  }
  return Promise.all(files.map((file) => guarded(file, located(file, cwd, home))));
}

/** Where a preview's path is on disk. */
function located(file: string, cwd: string, home: string): string {
  if (file === '~') return home;
  if (file.startsWith(`~${path.sep}`) || file.startsWith('~/'))
    return path.join(home, file.slice(2));
  return path.resolve(cwd, file);
}

async function guarded(file: string, at: string): Promise<GuardedFile> {
  const missing = { path: file, size: null, mtimeMs: null, sha256: null };
  let info;
  try {
    info = await lstat(at);
  } catch {
    return missing;
  }
  const kept = { path: file, size: info.size, mtimeMs: info.mtimeMs };
  if (info.isSymbolicLink()) {
    const target = await readlink(at).catch(() => undefined);
    return { ...kept, sha256: target === undefined ? null : sha256(Buffer.from(target)) };
  }
  if (!info.isFile()) return { ...kept, sha256: null };
  // Never through a link put there since, and never blocking on what isn't a regular file.
  // Windows has neither flag (Node leaves them out there).
  const { O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants as Partial<typeof constants>;
  const flags = constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
  const handle = await open(at, flags).catch(() => undefined);
  if (handle === undefined) return { ...kept, sha256: null };
  try {
    const now = await handle.stat();
    if (!now.isFile()) return { ...kept, sha256: null };
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let read = 0;
    while (read < MAX_HASHED_BYTES) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, MAX_HASHED_BYTES - read),
        read,
      );
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      read += bytesRead;
    }
    return { path: file, size: now.size, mtimeMs: now.mtimeMs, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
