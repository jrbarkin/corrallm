import { stat, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Filesystem observations only: no command is run and no token is read. */
interface HelperLocationDeps {
  realpath: (file: string) => Promise<string>;
  stat: (
    file: string,
  ) => Promise<Pick<Stats, 'uid' | 'mode' | 'dev' | 'ino' | 'isFile' | 'isDirectory'>>;
  uid: number | undefined;
  temporary: readonly string[];
}

/** The profile owner checks code locations before making a token for a file-based helper. */
export async function helperLocationRefusal(
  files: readonly string[],
  projects: readonly string[],
  deps: HelperLocationDeps = {
    realpath,
    stat,
    uid: process.getuid?.(),
    temporary: [tmpdir(), '/tmp', '/var/tmp'],
  },
): Promise<string | undefined> {
  const roots = await Promise.all(
    projects.map(async (root) => [
      path.resolve(root),
      await deps.realpath(root).catch(() => path.resolve(root)),
    ]),
  );
  const temporary = await Promise.all(
    deps.temporary
      .filter((root) => path.isAbsolute(root))
      .map(async (root) => deps.realpath(root).catch(() => root)),
  );
  const identities = async (paths: readonly string[]) => {
    const found = new Set<string>();
    for (const root of paths) {
      try {
        found.add(identity(await deps.stat(root)));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
    }
    return found;
  };
  const projectIds = await identities(roots.flat());
  const temporaryIds = await identities(temporary);
  const projectProblem =
    'A credential helper cannot run from a canvas project folder or the corrallm profile. Move the build outside those folders and try again.';
  const temporaryProblem =
    'A credential helper cannot run from a temporary folder. Move Node and the corrallm build to a protected permanent folder and try again.';
  for (const file of files) {
    const canonical = await deps.realpath(file);
    if (roots.flat().some((root) => inside(root, file) || inside(root, canonical)))
      return projectProblem;
    if (temporary.some((root) => inside(root, canonical))) return temporaryProblem;
    for (let at = canonical; ; at = path.dirname(at)) {
      const entry = await deps.stat(at);
      // Directory identity covers case and normalization aliases on the host filesystem too.
      if (projectIds.has(identity(entry))) return projectProblem;
      if (temporaryIds.has(identity(entry))) return temporaryProblem;
      if (
        (at === canonical ? !entry.isFile() : !entry.isDirectory()) ||
        (entry.uid !== deps.uid && entry.uid !== 0) ||
        (entry.mode & 0o022) !== 0
      )
        return 'A credential helper needs code and parent folders owned by you or root, with no write access for other users.';
      if (path.dirname(at) === at) break;
    }
  }
  return undefined;
}

function identity(entry: Pick<Stats, 'dev' | 'ino'>): string {
  return `${String(entry.dev)}:${String(entry.ino)}`;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}
