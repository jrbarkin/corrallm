import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/*
 * Finding the CLIs agents run (claude.ts, codex/codex.ts): the user's own install, with the
 * version, login and settings they already have; corrallm never ships or updates its own. An app
 * opened from the Finder or the Dock has a bare PATH, so the search goes by the agents'
 * environment (the login shell's: environment.ts), after the places the CLIs' installers use.
 */

/**
 * Where the executable `name` is: the first of `first` that can run (a path the user set, the
 * native installer's), else the first `name` on the agents' PATH (`env`). Undefined if none can run.
 */
export async function findExecutable(
  name: string,
  env: Readonly<Record<string, string>>,
  first: readonly string[] = [],
): Promise<string | undefined> {
  const candidates = [...first, ...searchPath(env).map((folder) => path.join(folder, name))];
  for (const candidate of candidates) {
    if (await canRun(candidate)) return candidate;
  }
  return undefined;
}

/** The folders of the agents' PATH (`env`), absolute ones only, in order. */
export function searchPath(env: Readonly<Record<string, string>>): string[] {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  return (value ?? '').split(path.delimiter).filter((folder) => path.isAbsolute(folder));
}

/** Whether `file` is a file that can be run (on Windows, any file: it has no execute bit). */
export async function canRun(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
