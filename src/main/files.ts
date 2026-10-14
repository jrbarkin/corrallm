import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { SAFE_GIT_OPTIONS } from './git';

/*
 * The files of a project folder, for the composer's @-mentions (as Claude Code completes
 * "@src/ma" to "@src/main/"): the files git knows of (tracked, and untracked but not ignored),
 * or, outside a git repository, the folder's files found by walking it. Folders are offered too,
 * ending in "/". The renderer sends only what it searches for: main knows the folder.
 */

/** How long a folder's file list is kept before it is listed again. */
const KEEP_MS = 10_000;
/** The most files listed from a folder, and how deep a walk goes. */
const MAX_FILES = 50_000;
const MAX_DEPTH = 12;
/** How long git may take to list them. */
const GIT_MS = 5000;
/** Folders a walk skips: dependencies, builds, and version control. */
const SKIPPED = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.vite']);

export interface ProjectFilesDeps {
  /** The environment git runs in (the agents', which has the user's PATH). */
  environment: () => Promise<Readonly<Record<string, string>>>;
  now?: () => number;
}

export class ProjectFiles {
  readonly #deps: ProjectFilesDeps;
  readonly #lists = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(deps: ProjectFilesDeps) {
    this.#deps = deps;
  }

  /** The files and folders of `folder` that match `query` best, at most `limit`, relative to it. */
  async find(folder: string, query: string, limit: number): Promise<string[]> {
    return rank(await this.#list(folder), query, limit);
  }

  #list(folder: string): Promise<string[]> {
    const now = (this.#deps.now ?? Date.now)();
    const kept = this.#lists.get(folder);
    if (kept && now - kept.at < KEEP_MS) return kept.files;
    const files = this.#deps
      .environment()
      .then((env) => gitFiles(folder, env))
      .catch(() => walk(folder))
      .then(withFolders);
    this.#lists.set(folder, { at: now, files });
    files.catch(() => this.#lists.delete(folder));
    return files;
  }
}

/** Files and folders that match `query` (its characters in order), best first. */
export function rank(paths: readonly string[], query: string, limit: number): string[] {
  const wanted = query.toLowerCase().replace(/\\/g, '/');
  const scored = paths.flatMap((file) => {
    const score = matchScore(file.toLowerCase(), wanted);
    return score === undefined ? [] : [{ file, score }];
  });
  scored.sort(
    (a, b) => a.score - b.score || a.file.length - b.file.length || compare(a.file, b.file),
  );
  return scored.slice(0, limit).map(({ file }) => file);
}

/**
 * How well `file` matches (lower is better), or undefined if it does not: a name starting with
 * the query, then a name containing it, a path containing it, then its characters in order.
 */
function matchScore(file: string, query: string): number | undefined {
  if (query === '') return file.split('/').length;
  const name = path.posix.basename(file.replace(/\/$/, ''));
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (file.includes(query)) return 2;
  let at = 0;
  for (const char of file) {
    if (char === query[at]) at += 1;
    if (at === query.length) return 3;
  }
  return undefined;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The files, and every folder they are in, ending in "/". */
function withFolders(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) folders.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...folders, ...files];
}

/** The files git knows of in `folder`: tracked, and untracked but not ignored. */
function gitFiles(folder: string, env: Readonly<Record<string, string>>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const git = spawn(
      'git',
      [...SAFE_GIT_OPTIONS, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: folder,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      git.kill();
      reject(new Error('git took too long'));
    }, GIT_MS);
    git.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024 * 1024) chunks.push(chunk);
    });
    git.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    git.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git exited with ${String(code)}`));
        return;
      }
      const files = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
      resolve([...new Set(files)].slice(0, MAX_FILES));
    });
  });
}

/** The files under `folder` (relative, with "/"), skipping dependencies and version control. */
async function walk(folder: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(path.join(folder, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const inside = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await visit(inside, depth + 1);
      } else if (entry.isFile()) {
        files.push(inside);
      }
    }
  };
  await visit('', 0);
  return files;
}
