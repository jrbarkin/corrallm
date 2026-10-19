import { spawn } from './sessions/process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';

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
/** Yield between short batches, including when preparing a list or returning many matches. */
const CHUNK_SIZE = 512;
/** Folders a walk skips: dependencies, builds, and version control. */
const SKIPPED = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.vite']);

export interface ProjectFilesDeps {
  /** The environment git runs in (the agents', which has the user's PATH). */
  environment: () => Promise<Readonly<Record<string, string>>>;
  now?: () => number;
}

export class ProjectFiles {
  readonly #deps: ProjectFilesDeps;
  readonly #lists = new Map<string, { at: number; files: Promise<FileList> }>();

  constructor(deps: ProjectFilesDeps) {
    this.#deps = deps;
  }

  /** The files and folders of `folder` that match `query` best, at most `limit`, relative to it. */
  async find(folder: string, query: string, limit: number): Promise<string[]> {
    return (await this.#list(folder)).find(query, limit);
  }

  #list(folder: string): Promise<FileList> {
    const now = (this.#deps.now ?? Date.now)();
    const kept = this.#lists.get(folder);
    if (kept && now - kept.at < KEEP_MS) return kept.files;
    const files = this.#deps
      .environment()
      .then((env) => gitFiles(folder, env))
      .catch(() => walk(folder))
      .then(withFolders)
      .then((paths) => FileList.create(paths));
    this.#lists.set(folder, { at: now, files });
    files.catch(() => this.#lists.delete(folder));
    return files;
  }
}

interface PreparedPath {
  file: string;
  lower: string;
  name: string;
  depth: number;
}

interface Match {
  file: string;
  score: number;
}

/** A folder's query-independent path data, kept with its file list. */
export class FileList {
  readonly #paths: readonly PreparedPath[];

  private constructor(paths: readonly PreparedPath[]) {
    this.#paths = paths;
  }

  static async create(paths: readonly string[]): Promise<FileList> {
    const prepared: PreparedPath[] = [];
    for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
      for (const file of paths.slice(i, i + CHUNK_SIZE)) {
        const lower = file.toLowerCase();
        prepared.push({
          file,
          lower,
          name: path.posix.basename(lower.replace(/\/$/, '')),
          depth: lower.split('/').length,
        });
      }
      if (i + CHUNK_SIZE < paths.length) await setImmediate();
    }
    return new FileList(prepared);
  }

  /**
   * Files and folders that match `query` (its characters in order), best first, at most `limit`
   * (a whole number: the composer asks for `MAX_FILE_MATCHES`).
   */
  async find(query: string, limit: number): Promise<string[]> {
    const wanted = query.toLowerCase().replace(/\\/g, '/');
    const units = wanted.split('');
    const letters = units.every((char) => char < '\ud800' || char > '\udfff') ? units : undefined;
    // The worst retained match is at the root: reject the rest without allocating or sorting.
    const best: Match[] = [];
    for (let i = 0; i < this.#paths.length; i += CHUNK_SIZE) {
      for (const file of this.#paths.slice(i, i + CHUNK_SIZE)) {
        const score = matchScore(file, wanted, letters);
        if (score === undefined) continue;
        const worst = best[0];
        if (best.length < limit) {
          const match = { file: file.file, score };
          best.push(match);
          let at = best.length - 1;
          while (at > 0) {
            const parent = Math.floor((at - 1) / 2);
            const above = best[parent];
            if (!above || compareMatches(match, above) <= 0) break;
            best[at] = above;
            at = parent;
          }
          best[at] = match;
        } else if (worst && (score - worst.score || compareFiles(file.file, worst.file)) < 0) {
          worst.file = file.file;
          worst.score = score;
          siftDown(best);
        }
      }
      if (i + CHUNK_SIZE < this.#paths.length) await setImmediate();
    }
    return best.sort(compareMatches).map(({ file }) => file);
  }
}

/**
 * How well `file` matches (lower is better), or undefined if it does not: a name starting with
 * the query, then a name containing it, a path containing it, then its characters in order.
 */
function matchScore(
  file: PreparedPath,
  query: string,
  letters: readonly string[] | undefined,
): number | undefined {
  if (query === '') return file.depth;
  if (file.name.startsWith(query)) return 0;
  if (file.name.includes(query)) return 1;
  if (file.lower.includes(query)) return 2;
  if (letters) {
    let from = 0;
    for (const char of letters) {
      const at = file.lower.indexOf(char, from);
      if (at < 0) return undefined;
      from = at + 1;
    }
    return 3;
  }
  // The original iteration skips surrogate pairs when matching individual query code units.
  let at = 0;
  for (const char of file.lower) {
    if (char === query[at]) at += 1;
    if (at === query.length) return 3;
  }
  return undefined;
}

function compareFiles(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function compareMatches(a: Match, b: Match): number {
  return a.score - b.score || compareFiles(a.file, b.file);
}

function siftDown(heap: Match[]): void {
  const match = heap[0];
  if (!match) return;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    let below = heap[child];
    const right = heap[child + 1];
    if (!below) break;
    if (right && compareMatches(right, below) > 0) {
      child += 1;
      below = right;
    }
    if (compareMatches(match, below) >= 0) break;
    heap[at] = below;
    at = child;
  }
  heap[at] = match;
}

/** The files, and every folder they are in, ending in "/". */
async function withFolders(files: string[]): Promise<string[]> {
  const folders = new Set<string>();
  for (let at = 0; at < files.length; at += CHUNK_SIZE) {
    for (const file of files.slice(at, at + CHUNK_SIZE)) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i += 1) folders.add(`${parts.slice(0, i).join('/')}/`);
    }
    if (at + CHUNK_SIZE < files.length) await setImmediate();
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
