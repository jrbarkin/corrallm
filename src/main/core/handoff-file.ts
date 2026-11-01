import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { MAX_HANDOFF_BYTES } from '../../shared/api/limits';
import type { CanvasId } from '../../shared/canvas';
import { HandoffFileSchema } from '../../shared/model/fallback';
import type { WorkingDirectory } from './workspaces/resolver';

/*
 * The Markdown copy of an agent's handoff (B11a Design §12 C10): once a handoff is accepted, where
 * the agent's handoff settings name a file, corrallm writes exactly its text there, in the agent's
 * current working directory as the directory resolver verifies it at each write (its worktree's
 * checkout, `verifiedCheckout`; or the picked project folder an agent works in there). Nothing
 * else writes a handoff to disk: no renderer path, shell, or write-file operation.
 *
 * - The path (settings, X1's HandoffFileSchema): 1–200 bytes of `/`-separated segments of
 *   letters, digits, `.`, `_`, space and `-`, none `.` or `..`, none starting with `-`, none
 *   `.git`, ending in `.md`. Its folder must exist (none is made), and no segment may be a symlink:
 *   each is `lstat`ed, the file too, which must be a regular file where it exists.
 * - It replaces only a missing file, or one whose bytes hash to this agent's own last copy at that
 *   path (`last`): never your edit, nor another agent's file in a shared tree. That is refused.
 * - It writes a temporary file in the same folder, opened `O_CREAT | O_EXCL | O_NOFOLLOW`, then
 *   checks again that the folder is still the one checked (its real path) and the file still what
 *   it was: a missing file is linked into place, which fails if one appeared meanwhile, and its own
 *   copy is renamed over. The temporary file never stays.
 * - A failure is said (the agent's transcript, by the handoff service), never retried.
 */

/** The file system calls the export makes: node:fs/promises', which tests replace to race it. */
export type ExportFs = Pick<
  typeof fsp,
  'lstat' | 'open' | 'readFile' | 'realpath' | 'link' | 'rename' | 'unlink'
>;

export interface ExportDeps {
  /** The agent's working directory, verified now (DirectoryResolver.workingDirectory). */
  directory(canvas: CanvasId, agent: string): Promise<WorkingDirectory>;
  fs?: ExportFs;
}

/**
 * The export of one accepted handoff: `text` to `path` in the agent's working directory, `last` its
 * own last copy (where, and its bytes' SHA-256); the hash of what it wrote, or why it didn't.
 */
export type HandoffExporter = (request: {
  canvas: CanvasId;
  agent: string;
  path: string;
  text: string;
  last: { path: string; sha256: string } | undefined;
}) => Promise<
  | { ok: true; sha256: string }
  /** `refused` by its rules (the path, a symlink, a file not its own); `failed` otherwise. */
  | { ok: false; why: 'refused' | 'failed'; sentence: string }
>;

/** Why a copy isn't written: a sentence the transcript's notice ends with. */
class Refused extends Error {}

/** Windows has no O_NOFOLLOW: there, `lstat` alone says a path is no symlink. */
const NOFOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;

/** The handoff exporter (HandoffDeps.exporter), over the agent's verified working directory. */
export function exportHandoff(deps: ExportDeps): HandoffExporter {
  const fs = deps.fs ?? fsp;

  /**
   * What is at `file` now: nothing (undefined), or a regular file's bytes' hash (one no bigger than
   * a handoff).
   */
  const state = async (file: string, shown: string): Promise<string | undefined> => {
    let found;
    try {
      found = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (found.isSymbolicLink()) throw new Refused(`${shown} is a symlink.`);
    if (!found.isFile()) throw new Refused(`${shown} isn’t a file.`);
    // None of corrallm's copies is bigger than a handoff: a bigger file is someone else's.
    if (found.size > MAX_HANDOFF_BYTES)
      throw new Refused(`${shown} holds a file this agent didn’t write there.`);
    const handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW);
    try {
      return createHash('sha256')
        .update(await handle.readFile())
        .digest('hex');
    } finally {
      await handle.close();
    }
  };

  return async ({ canvas, agent, path: file, text, last }) => {
    let temp: string | undefined;
    try {
      if (!HandoffFileSchema.safeParse(file).success)
        throw new Refused('its path isn’t a relative Markdown path corrallm writes.');
      const directory = await deps.directory(canvas, agent);
      if (directory.state !== 'ready')
        throw new Refused(`its workspace isn’t ready: ${directory.sentence}`);
      const root = await fs.realpath(directory.cwd);
      const segments = file.split('/');
      const name = segments.at(-1) ?? file;
      const folders = segments.slice(0, -1);
      // Each folder of its path: there, a folder, never a symlink.
      let folder = root;
      for (const [index, segment] of folders.entries()) {
        folder = path.join(folder, segment);
        const shown = folders.slice(0, index + 1).join('/');
        let found;
        try {
          found = await fs.lstat(folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Refused(`its folder ${shown} doesn’t exist.`);
          throw error;
        }
        if (found.isSymbolicLink()) throw new Refused(`${shown} is a symlink.`);
        if (!found.isDirectory()) throw new Refused(`${shown} isn’t a folder.`);
      }
      const target = path.join(folder, name);
      const before = await state(target, file);
      const own = last?.path === file ? last.sha256 : undefined;
      if (before !== undefined && before !== own)
        throw new Refused(
          `${file} holds a file this agent didn’t write there: corrallm never replaces your edit or another agent’s file.`,
        );
      const bytes = Buffer.from(text, 'utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // Beside it, created afresh, never through a symlink.
      temp = path.join(folder, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
      const handle = await fs.open(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
        0o644,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The folder is still the one checked: no folder of its path became a symlink meanwhile.
      if ((await fs.realpath(folder)) !== path.join(root, ...folders))
        throw new Refused(`its folder ${folders.join('/')} changed as it was written.`);
      if (before === undefined) {
        try {
          // A link fails where a file appeared meanwhile: never replacing it.
          await fs.link(temp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new Refused(`a file appeared at ${file} as it was written.`);
          throw error;
        }
      } else {
        if ((await state(target, file)) !== before)
          throw new Refused(`${file} changed as it was written.`);
        await fs.rename(temp, target);
        temp = undefined;
      }
      return { ok: true, sha256 };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, why: 'refused', sentence: error.message };
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, why: 'failed', sentence: `it couldn’t be written (${why}).` };
    } finally {
      if (temp !== undefined) await fs.unlink(temp).catch(() => undefined);
    }
  };
}
