import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { withProcesses } from '../sessions/process';
import type { ProcessOwner } from '../sessions/process';

interface ChildRecord {
  pid: number;
  /** The process's actual start time, as ps reports it, rather than when it was noticed. */
  started: number;
}

/** The OS seam: tests never need permission to inspect or signal another process. */
export interface ChildSystem {
  platform: NodeJS.Platform;
  inspect: (pid: number) => { started: number; group: number } | undefined;
  alive: (group: number) => boolean;
  signal: (group: number, signal: NodeJS.Signals | number) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const GRACE_MS = 3000;
const KILL_WAIT_MS = 250;
const SYSTEM: ChildSystem = {
  platform: process.platform,
  inspect: inspectProcess,
  alive: (group) => {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      if (isCode(error, 'ESRCH')) return false;
      throw error;
    }
  },
  signal: (group, signal) => {
    process.kill(-group, signal);
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/*
 * The CLIs a core owns (B8 Design §6, Core Server §7.5). Each is a private process group and is
 * recorded before its spawner returns, in sessions/pids.json. A restarted core verifies each
 * leader's actual start time and group before ending it; pid reuse and unknown identities never
 * authorize a signal. Registry changes are synchronous, atomic and forced to disk: the SDK's
 * spawn hook is synchronous too, so no promise may leave a new CLI running unrecorded.
 */
export class Children implements ProcessOwner {
  readonly #file: string;
  readonly #system: ChildSystem;
  readonly #children = new Map<number, ChildRecord>();
  readonly #stopping = new Map<number, Promise<void>>();
  /** Each child this core started that still runs, and how to end it directly (Windows). */
  readonly #kills = new Map<number, (signal: NodeJS.Signals | number) => void>();
  /** Once the core closes, it starts no CLI: none may outlive it. */
  #closed = false;

  constructor(profile: string, system: ChildSystem = SYSTEM) {
    this.#file = path.join(profile, 'sessions', 'pids.json');
    this.#system = system;
  }

  beforeSpawn(): void {
    if (this.#closed) throw new Error('corrallm’s core is closing: it starts no more CLIs.');
  }

  run<T>(work: () => T): T {
    return withProcesses(this, work);
  }

  /** Before conversations resume. Cleanup failures keep their records for the next start. */
  async recover(): Promise<void> {
    let stale: ChildRecord[];
    try {
      stale = records(readFileSync(this.#file, 'utf8'));
    } catch (error) {
      if (!isCode(error, 'ENOENT')) {
        console.warn(`Could not read CLI process record ${this.#file}:`, error);
        return;
      }
      stale = [];
    }
    for (const record of stale) {
      try {
        await this.#stop(record);
      } catch (error) {
        if (!isCode(error, 'ESRCH')) {
          this.#children.set(record.pid, record);
          console.warn(
            `Could not stop stale CLI ${String(record.pid)}; keeping its record to retry at the next start:`,
            error,
          );
          continue;
        }
      }
      this.#children.delete(record.pid);
    }
    try {
      this.#write();
    } catch (error) {
      console.warn(`Could not update CLI process record ${this.#file}:`, error);
    }
  }

  async #stop(
    record: ChildRecord,
    signal: NodeJS.Signals | number = 'SIGTERM',
    owned = false,
  ): Promise<void> {
    // Windows has no POSIX process groups; stale-group cleanup is deferred there.
    if (this.#system.platform === 'win32' || record.pid === process.pid) return;
    const found = this.#system.inspect(record.pid);
    if (found === undefined ? !owned : !same(found, record)) return;
    this.#system.signal(record.pid, signal);
    if (await this.#gone(record.pid, GRACE_MS)) return;
    const after = this.#system.inspect(record.pid);
    // A new process may now have the leader's pid. It is never ours to signal.
    if (after !== undefined && !same(after, record)) return;
    this.#system.signal(record.pid, 'SIGKILL');
    if (await this.#gone(record.pid, KILL_WAIT_MS)) return;
    const last = this.#system.inspect(record.pid);
    if (last === undefined || same(last, record)) {
      throw new Error(`Process group ${String(record.pid)} did not stop.`);
    }
  }

  /** The grace is a limit, not a delay once the whole group has already exited. */
  async #gone(group: number, ms: number): Promise<boolean> {
    for (let left = ms; ;) {
      if (!this.#system.alive(group)) return true;
      if (left === 0) return false;
      const step = Math.min(left, 50);
      await this.#system.wait(step);
      left -= step;
    }
  }

  /** A bounded helper failed: end its group while retaining its identity through the grace. */
  stop(child: Parameters<ProcessOwner['node']>[0], signal: NodeJS.Signals | number): Promise<void> {
    if (this.#system.platform === 'win32') {
      child.kill(signal);
      return Promise.resolve();
    }
    const record = child.pid === undefined ? undefined : this.#children.get(child.pid);
    if (!record) return Promise.resolve();
    return this.#ending(record, signal);
  }

  #ending(record: ChildRecord, signal: NodeJS.Signals | number): Promise<void> {
    const existing = this.#stopping.get(record.pid);
    if (existing) return existing;
    const stopped = Promise.withResolvers<undefined>();
    this.#stopping.set(record.pid, stopped.promise);
    void this.#end(record, signal).then(() => {
      stopped.resolve(undefined);
    }, stopped.reject);
    return stopped.promise;
  }

  /** Finish any group cleanup already begun before the host exits. */
  async flush(): Promise<void> {
    while (this.#stopping.size > 0) await Promise.all(this.#stopping.values());
  }

  /**
   * As the core closes, after its sessions have: ends every CLI still running (a helper a read
   * in flight started, such as a settings read's app server or login shell) as a timed-out
   * helper is ended, and refuses any started from now on, so that none outlives the core.
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#system.platform === 'win32') {
      for (const [pid, kill] of this.#kills) {
        kill('SIGTERM');
        this.#kills.delete(pid);
      }
    } else {
      for (const record of this.#children.values())
        if (this.#kills.has(record.pid)) void this.#ending(record, 'SIGTERM');
    }
    await this.flush();
  }

  async #end(record: ChildRecord, signal: NodeJS.Signals | number): Promise<void> {
    try {
      await this.#stop(record, signal, true);
      if (this.#children.get(record.pid) === record) this.#children.delete(record.pid);
    } catch (error) {
      if (isCode(error, 'ESRCH')) this.#children.delete(record.pid);
      else
        console.warn(
          `Could not stop CLI ${String(record.pid)}; keeping its record to retry at the next start:`,
          error,
        );
    } finally {
      this.#stopping.delete(record.pid);
      try {
        this.#write();
      } catch (error) {
        console.warn(`Could not update CLI process record ${this.#file}:`, error);
      }
    }
  }

  node(child: Parameters<ProcessOwner['node']>[0], until?: 'close'): void {
    if (child.pid === undefined) return; // A failed spawn emits 'error', but has no process.
    this.#record(
      child.pid,
      (exit) => {
        child.once(until ?? 'exit', exit);
      },
      (signal) => {
        child.kill(signal);
      },
    );
  }

  pty(child: Parameters<ProcessOwner['pty']>[0]): void {
    this.#record(
      child.pid,
      (exit) => {
        child.onExit(exit);
      },
      (signal) => {
        child.kill(typeof signal === 'number' ? undefined : signal);
      },
    );
  }

  #record(
    pid: number,
    onExit: (listener: () => void) => void,
    kill: (signal: NodeJS.Signals | number) => void,
  ): void {
    const stop = () => {
      kill('SIGKILL');
    };
    const state = { ended: false };
    let record: ChildRecord | undefined;
    onExit(() => {
      state.ended = true;
      if (this.#kills.get(pid) === kill) this.#kills.delete(pid);
      if (record === undefined || this.#children.get(pid) !== record) return;
      if (this.#stopping.has(pid)) return;
      this.#children.delete(pid);
      try {
        this.#write();
      } catch (error) {
        console.error('Could not forget an exited CLI:', error);
      }
    });
    try {
      const found =
        this.#system.platform === 'win32'
          ? { started: this.#system.now(), group: pid }
          : this.#system.inspect(pid);
      if (state.ended || found === undefined) {
        this.beforeSpawn();
        return; // It exited before its identity could be read.
      }
      if (pid <= 1 || pid === process.pid || found.group !== pid) {
        throw new Error('The CLI did not start in its own process group.');
      }
      record = { pid, started: found.started };
      this.#children.set(pid, record);
      this.#kills.set(pid, kill);
      this.#write();
    } catch (error) {
      this.#children.delete(pid);
      this.#kills.delete(pid);
      stop();
      throw error;
    }
    if (this.#closed) {
      // A child already created as closing began still belongs to us. Record its verified
      // identity first, then retain it through the same group cleanup as every owned CLI.
      if (this.#system.platform === 'win32') kill('SIGTERM');
      else void this.#ending(record, 'SIGTERM');
      this.beforeSpawn();
    }
  }

  #write(): void {
    const directory = path.dirname(this.#file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const partial = `${this.#file}.${randomUUID()}.partial`;
    try {
      const handle = openSync(partial, 'wx', 0o600);
      try {
        writeFileSync(
          handle,
          `${JSON.stringify({ version: 1, children: [...this.#children.values()] })}\n`,
        );
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(partial, this.#file);
      if (this.#system.platform !== 'win32') {
        const folder = openSync(directory, 'r');
        try {
          fsyncSync(folder);
        } finally {
          closeSync(folder);
        }
      }
    } finally {
      rmSync(partial, { force: true });
    }
  }
}

function same(found: ReturnType<ChildSystem['inspect']>, record: ChildRecord): boolean {
  return found?.started === record.started && found.group === record.pid;
}

/** ps supplies the same start-time identity as core.lock, plus the private group to verify. */
function inspectProcess(pid: number): ReturnType<ChildSystem['inspect']> {
  let text: string;
  try {
    text = execFileSync('ps', ['-o', 'lstart=', '-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    // A missing pid is ps's empty exit 1. A denied inspection never authorizes a signal.
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    if (failed.status === 1 && failed.stdout?.trim() === '' && failed.stderr?.trim() === '')
      return undefined;
    throw error;
  }
  const fields = /^(.+?)\s+(\d+)$/.exec(text);
  const started = Date.parse(fields?.[1] ?? '');
  const group = Number(fields?.[2]);
  if (!Number.isFinite(started) || !Number.isSafeInteger(group) || group <= 0) {
    throw new Error(`Could not identify process ${String(pid)}.`);
  }
  return { started, group };
}

function records(text: string): ChildRecord[] {
  const file: unknown = JSON.parse(text);
  if (
    typeof file !== 'object' ||
    file === null ||
    !('version' in file) ||
    file.version !== 1 ||
    !('children' in file) ||
    !Array.isArray(file.children)
  ) {
    throw new Error('The CLI process record could not be read.');
  }
  return (file.children as unknown[]).flatMap((child) => {
    if (typeof child !== 'object' || child === null) return [];
    const { pid, started } = child as Record<string, unknown>;
    return typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      typeof started === 'number' &&
      Number.isFinite(started) &&
      started >= 0
      ? [{ pid, started }]
      : [];
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
