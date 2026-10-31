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
import { groupIsGone, hasLiveGroupMembers } from './process-groups';
import type { LiveGroupMembers } from './process-groups';
import { inspectProcess, isProcessStart, sameStart } from './process-identity';
import type { ProcessStart } from './process-identity';

interface ChildRecord {
  pid: number;
  /** The process's OS start identity, rather than when it was noticed. */
  started: ProcessStart;
}

/** The OS seam: tests never need permission to inspect or signal another process. */
export interface ChildSystem {
  platform: NodeJS.Platform;
  inspect: (pid: number) => { started: ProcessStart; group: number } | undefined;
  alive: (group: number) => boolean;
  signal: (group: number, signal: NodeJS.Signals | number) => void;
  /** A denied group is gone only when a complete membership read finds no live member. */
  hasLiveMembers?: LiveGroupMembers;
  wait: (ms: number) => Promise<void>;
  /** Blocks the thread: a new CLI is recorded inside its spawner's synchronous call. */
  pause: (ms: number) => void;
  now: () => number;
}

const GRACE_MS = 3000;
const KILL_WAIT_MS = 250;
/**
 * Linux's forkpty returns before its child calls setsid, so a new pty can still be in the core's
 * group. Under CPU contention that lasts milliseconds, and over 100 ms has been measured.
 */
const OWN_GROUP_MS = 1000;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
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
  hasLiveMembers: hasLiveGroupMembers,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pause: (ms) => {
    Atomics.wait(PAUSE, 0, 0, ms);
  },
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
  /** Never replace a registry whose unread records have not been preserved. */
  #registryBlocked = false;

  constructor(profile: string, system: ChildSystem = SYSTEM) {
    this.#file = path.join(profile, 'sessions', 'pids.json');
    this.#system = system;
  }

  beforeSpawn(): void {
    if (this.#closed) throw new Error('corrallm’s core is closing: it starts no more CLIs.');
    if (this.#registryBlocked) {
      throw new Error(`The unread CLI process record ${this.#file} could not be preserved.`);
    }
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
        this.#registryBlocked = true;
        const rejected = path.join(path.dirname(this.#file), `pids.rejected-${randomUUID()}.json`);
        try {
          renameSync(this.#file, rejected);
          this.#syncDirectory();
          this.#registryBlocked = false;
        } catch (failure) {
          console.warn(
            `Could not preserve CLI process record ${this.#file}; refusing new CLIs:`,
            failure,
          );
        }
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
    if (!this.#signal(record.pid, signal)) return;
    if (await this.#gone(record.pid, GRACE_MS)) return;
    const after = this.#system.inspect(record.pid);
    // A new process may now have the leader's pid. It is never ours to signal.
    if (after !== undefined && !same(after, record)) return;
    if (!this.#signal(record.pid, 'SIGKILL')) return;
    if (await this.#gone(record.pid, KILL_WAIT_MS)) return;
    const last = this.#system.inspect(record.pid);
    if (last === undefined || same(last, record)) {
      throw new Error(`Process group ${String(record.pid)} did not stop.`);
    }
  }

  #signal(group: number, signal: NodeJS.Signals | number): boolean {
    try {
      this.#system.signal(group, signal);
      return true;
    } catch (error) {
      if (groupIsGone(error, group, this.#system.hasLiveMembers)) return false;
      throw error;
    }
  }

  #alive(group: number): boolean {
    try {
      return this.#system.alive(group);
    } catch (error) {
      if (groupIsGone(error, group, this.#system.hasLiveMembers)) return false;
      throw error;
    }
  }

  /** The grace is a limit, not a delay once the whole group has already exited. */
  async #gone(group: number, ms: number): Promise<boolean> {
    for (let left = ms; ;) {
      if (!this.#alive(group)) return true;
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
          : this.#identify(pid);
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

  /**
   * A new POSIX child's identity, once it has left the core's process group (for at most
   * OWN_GROUP_MS). One that exits or whose pid another process takes meanwhile is gone.
   */
  #identify(pid: number): ReturnType<ChildSystem['inspect']> {
    const found = this.#system.inspect(pid);
    if (found === undefined || found.group === pid || pid <= 1 || pid === process.pid) return found;
    const core = this.#system.inspect(process.pid)?.group;
    const until = this.#system.now() + OWN_GROUP_MS;
    let latest = found;
    while (latest.group === core && this.#system.now() < until) {
      this.#system.pause(1);
      const next = this.#system.inspect(pid);
      if (next === undefined || !sameStart(next.started, found.started)) return undefined;
      latest = next;
    }
    return latest;
  }

  #write(): void {
    if (this.#registryBlocked) {
      throw new Error(`The unread CLI process record ${this.#file} could not be preserved.`);
    }
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
      this.#syncDirectory();
    } finally {
      rmSync(partial, { force: true });
    }
  }

  #syncDirectory(): void {
    if (this.#system.platform === 'win32') return;
    const folder = openSync(path.dirname(this.#file), 'r');
    try {
      fsyncSync(folder);
    } finally {
      closeSync(folder);
    }
  }
}

function same(found: ReturnType<ChildSystem['inspect']>, record: ChildRecord): boolean {
  return (
    found !== undefined && sameStart(found.started, record.started) && found.group === record.pid
  );
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
  return (file.children as unknown[]).map((child) => {
    if (typeof child !== 'object' || child === null) {
      throw new Error('The CLI process record has an invalid identity.');
    }
    const { pid, started } = child as Record<string, unknown>;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      !isProcessStart(started)
    ) {
      throw new Error('The CLI process record has an invalid identity.');
    }
    return { pid, started };
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
