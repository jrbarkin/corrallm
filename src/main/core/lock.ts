import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/*
 * One owner per profile (Core Server §7.6): <profile>/core.lock, opened O_EXCL, holds the pid and
 * start time of the process that owns the profile: the app (its main takes it, until B8 moves it
 * into the core process) or `corrallm serve`. Chromium's single-instance lock keeps two apps off
 * one profile, but `serve` is plain Node: without this, the two could write one profile's stores
 * (canvases.json, the run journal, tokens.json) at once. A lock whose process is gone, or whose pid
 * another process has since been given (it started after the lock's did), is taken over, and so is
 * one left half written long enough ago: by one process at a time, holding core.lock.taking (opened
 * O_EXCL too) while it checks that the lock is still the one left behind, removes it and takes the
 * profile, so that of several taking one over at once, only one has it.
 */

export type LockOwner = 'app' | 'serve';

/** Who holds a profile: what core.lock says. */
export interface LockHolder {
  owner: LockOwner;
  pid: number;
  /** When its process started, in epoch ms. */
  started: number;
}

/** A profile this process holds, until it lets it go. */
export interface ProfileLock {
  /**
   * Lets the profile go, if this process still holds it. Synchronous: it runs as a process
   * exits.
   */
  release(): void;
}

const LOCK_FILE = 'core.lock';
/** How long a lock that can't be read may be being written, before it counts as left behind. */
const WRITING_MS = 10 * 1000;
/** How far apart two start times of one process may be: `ps` tells them to the second. */
const SAME_START_MS = 2 * 1000;
const OWNERS: Readonly<Record<LockOwner, string>> = {
  app: 'The corrallm app',
  serve: 'corrallm serve',
};

/** Another process holds the profile: which, if its lock says. */
export class ProfileLocked extends Error {
  readonly holder: LockHolder | undefined;

  constructor(holder: LockHolder | undefined) {
    super(
      holder === undefined
        ? 'Another process is opening this profile.'
        : `${OWNERS[holder.owner]} (process ${String(holder.pid)}) is using this profile.`,
    );
    this.name = 'ProfileLocked';
    this.holder = holder;
  }
}

/**
 * Takes `profile` for this process, as `owner`. Rejects with ProfileLocked while another live
 * process holds it, saying which.
 */
export async function lockProfile(profile: string, owner: LockOwner): Promise<ProfileLock> {
  const file = path.join(profile, LOCK_FILE);
  const mine: LockHolder = { owner, pid: process.pid, started: processStart() };
  const taking = `${file}.taking`;
  // Once to take it, and again after a lock left behind was removed, or went meanwhile.
  for (let tries = 0; tries < 3; tries++) {
    if (await create(file, mine)) return held(file, mine);
    const found = await lockIn(file);
    if (found === 'gone') continue;
    if (!(await leftBehind(file, found))) throw new ProfileLocked(found.holder);
    if (!(await create(taking, mine))) {
      const other = await lockIn(taking);
      if (other !== 'gone' && !(await leftBehind(taking, other))) {
        throw new ProfileLocked(undefined);
      }
      // A process taking the lock over ended before it was done: its claim goes, and this one
      // tries again.
      await rm(taking, { force: true });
      continue;
    }
    try {
      // Still the lock it found left behind: no other process took the profile meanwhile.
      const now = await lockIn(file);
      if (now !== 'gone' && now.text === found.text) await rm(file, { force: true });
    } finally {
      await rm(taking, { force: true });
    }
  }
  const found = await lockIn(file);
  throw new ProfileLocked(found === 'gone' ? undefined : found.holder);
}

/** Creates `file` holding `holder`, forced to disk: false if it is there already. */
async function create(file: string, holder: LockHolder): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(holder));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Whether a lock is left behind: its process is gone, or it can't be read and was last written
 * long enough ago that no one is writing it.
 */
async function leftBehind(file: string, { holder }: { holder?: LockHolder }): Promise<boolean> {
  return holder === undefined ? !(await beingWritten(file)) : !stillRuns(holder);
}

/** The lock this process holds in `file`, as `mine`. */
function held(file: string, mine: LockHolder): ProfileLock {
  return {
    release: () => {
      try {
        const text = readFileSync(file, 'utf8');
        if (sameHolder(read(text), mine)) rmSync(file, { force: true });
      } catch {
        // Gone already, or unreadable: not this process's to remove.
      }
    },
  };
}

/**
 * A lock file's text, and who it says holds the profile (none if it can't be read); 'gone' if it
 * isn't there.
 */
async function lockIn(file: string): Promise<{ text: string; holder?: LockHolder } | 'gone'> {
  try {
    const text = await readFile(file, 'utf8');
    const holder = read(text);
    return holder === undefined ? { text } : { text, holder };
  } catch (error) {
    if (isCode(error, 'ENOENT')) return 'gone';
    throw error;
  }
}

/** Whether a lock that can't be read may still be being written. */
async function beingWritten(file: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(file)).mtimeMs < WRITING_MS;
  } catch {
    return false;
  }
}

/** A lock file's text: who holds the profile, or undefined if it isn't a lock. */
function read(text: string): LockHolder | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { owner, pid, started } = value as Record<string, unknown>;
  if (owner !== 'app' && owner !== 'serve') return undefined;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isFinite(started)) {
    return undefined;
  }
  return { owner, pid: pid as number, started: started as number };
}

function sameHolder(a: LockHolder | undefined, b: LockHolder): boolean {
  return a?.owner === b.owner && a.pid === b.pid && a.started === b.started;
}

/** When this process started, in epoch ms, as a lock (or api.json) keeps it. */
export function processStart(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Whether the process a lock (or api.json) names still runs: its pid is alive, and wasn't given to
 * another process since (one that started after it did).
 */
export function stillRuns({ pid, started }: { pid: number; started: number }): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: it runs, as someone else.
    if (!isCode(error, 'EPERM')) return false;
  }
  const actual = startOf(pid);
  return actual === undefined || actual <= started + SAME_START_MS;
}

/** When process `pid` started, as `ps` tells it (to the second); undefined where it can't. */
function startOf(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const at = Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
