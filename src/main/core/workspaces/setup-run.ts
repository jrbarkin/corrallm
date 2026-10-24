import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { spawnOwned } from '../../sessions/process';
import type { ProcessOwner } from '../../sessions/process';
import type { TrustedPath } from '../host';
import { O_NOFOLLOW } from './copy';

/*
 * A worktree's setup command, running (B9a Design §4, Execution, output and cancellation): the one
 * file of the workspaces besides the Git runner that starts a process (git.test.ts pins both). It
 * runs only what the setup service hands it, after your approval is on disk: an argument list of the
 * fixed table's (no shell), or the one command you set under the fixed POSIX shell, `/bin/sh -c`,
 * with no other command wrapped around it. It runs in the workspace's verified checkout, with the
 * agents' environment and no input, as a child the core owns (core/children.ts: recorded before it
 * runs, in a process group of its own, until its output closes too), so Stop, a timeout and the
 * core closing end its whole group, and a crash's leftover group is ended as the next core starts.
 *
 * What it prints is untrusted text a dependency tool may have put a secret in: it goes only to a
 * private log (0600, made anew, never through a symlink), at most MAX_LOG_HEAD bytes from its start
 * and then its last MAX_LOG_TAIL, with a line saying how much was left out, and to the bounded tail
 * your setup card shows, escaped. It is never sent to a token or an agent.
 */

/** What of its output a log keeps: the start, and the end. */
export const MAX_LOG_HEAD = 1024 * 1024;
export const MAX_LOG_TAIL = 64 * 1024;
/** How long its descendants may hold its output open once its leader exited. */
const LINGER_MS = 2000;

/** Why the core ended it, if it did. */
export type EndedBy = 'stop' | 'shutdown' | 'timeout';

export interface SetupExit {
  /** Its exit code, if it exited; none if a signal ended it or it never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why it couldn't start, if it couldn't. */
  error?: string;
  endedBy?: EndedBy;
}

export interface SetupLaunch {
  /** An absolute executable, and its arguments: the fixed table's, or `/bin/sh -c <command>`. */
  executable: string;
  args: readonly string[];
  /** The workspace's checkout, verified at this use. */
  cwd: TrustedPath;
  env: Readonly<Record<string, string>>;
  /** The log file, made anew: never one already there. */
  log: string;
  timeoutMs: number;
}

/** The core's process owner, as a setup command needs it. */
export type SetupProcesses = Pick<ProcessOwner, 'stop'> & { run<T>(work: () => T): T };

export class SetupProcess {
  /** Resolves once it is over and its log is on disk. */
  readonly exited: Promise<SetupExit>;
  readonly #processes: SetupProcesses;
  readonly #log: FileHandle;
  readonly #ended = Promise.withResolvers<SetupExit>();
  #child: ChildProcess | undefined;
  #endedBy: EndedBy | undefined;
  #finished = false;
  #tail = '';
  #headBytes = 0;
  #dropped = 0;
  #writes: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #linger: ReturnType<typeof setTimeout> | undefined;
  #stopping: Promise<void> | undefined;

  private constructor(processes: SetupProcesses, log: FileHandle) {
    this.#processes = processes;
    this.#log = log;
    this.exited = this.#ended.promise;
  }

  /**
   * Its log made, then it started as a child of `processes`, the core's owner. Rejects, having
   * started nothing and kept no log, if either can't be (the core closing refuses every spawn).
   */
  static async start(processes: SetupProcesses, launch: SetupLaunch): Promise<SetupProcess> {
    const log = await open(
      launch.log,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    const running = new SetupProcess(processes, log);
    try {
      running.#spawn(launch);
    } catch (error) {
      await log.close();
      await rm(launch.log, { force: true });
      throw error;
    }
    return running;
  }

  #spawn(launch: SetupLaunch): void {
    const child = this.#processes.run(() =>
      spawnOwned(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: { ...launch.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    this.#child = child;
    let exit: Pick<SetupExit, 'code' | 'signal'> | undefined;
    let failed: string | undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.#output(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#output(chunk);
    });
    child.once('error', (error) => {
      failed = error.message;
      // A spawn that failed has no process to exit: it is over.
      if (child.pid === undefined) this.#finish({ code: null, signal: null, error: failed });
    });
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      // A descendant still holding its output gets a moment, then its group is ended.
      this.#linger = setTimeout(() => {
        void this.#end().finally(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
      }, LINGER_MS);
    });
    child.once('close', (code, signal) => {
      this.#finish({
        ...(exit ?? { code, signal }),
        ...(failed === undefined ? {} : { error: failed }),
      });
    });
    this.#timer = setTimeout(() => {
      void this.stop('timeout');
    }, launch.timeoutMs);
  }

  /** The last of what it printed, as it printed it: untrusted text, for the setup card to escape. */
  tail(): string {
    return this.#tail;
  }

  /** Ends its whole process group (TERM, then KILL after a grace), then resolves as it exited. */
  async stop(why: EndedBy): Promise<SetupExit> {
    // Over already, its output closed: nothing of it is left to end.
    if (this.#finished) return this.exited;
    this.#endedBy ??= why;
    await this.#end();
    return this.exited;
  }

  #end(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return Promise.resolve();
    this.#stopping ??= Promise.resolve(this.#processes.stop(child, 'SIGTERM')).catch(
      (error: unknown) => {
        console.error('Could not end a setup command’s processes:', error);
      },
    );
    return this.#stopping;
  }

  #output(chunk: Buffer): void {
    this.#tail = (this.#tail + chunk.toString('utf8')).slice(-MAX_LOG_TAIL);
    const room = MAX_LOG_HEAD - this.#headBytes;
    const kept = room > 0 ? chunk.subarray(0, room) : chunk.subarray(0, 0);
    this.#headBytes += kept.length;
    this.#dropped += chunk.length - kept.length;
    if (kept.length > 0) this.#write(kept);
  }

  #write(bytes: Buffer | string): void {
    this.#writes = this.#writes.then(async () => {
      try {
        await (typeof bytes === 'string' ? this.#log.write(bytes) : this.#log.write(bytes));
      } catch (error) {
        console.error('Could not write a setup command’s log:', error);
      }
    });
  }

  #finish(exit: SetupExit): void {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#linger);
    if (this.#dropped > 0) {
      // What was left out, said, then its end: never the whole of an unbounded output.
      this.#write(
        `\n[corrallm: ${String(this.#dropped)} bytes of its output not kept here; its last ${String(MAX_LOG_TAIL / 1024)} KiB follow]\n`,
      );
      this.#write(this.#tail);
    }
    const ended: SetupExit = {
      ...exit,
      ...(this.#endedBy === undefined ? {} : { endedBy: this.#endedBy }),
    };
    void this.#writes
      .then(async () => {
        await this.#log.sync().catch(() => undefined);
        await this.#log.close();
      })
      .catch((error: unknown) => {
        console.error('Could not close a setup command’s log:', error);
      })
      .finally(() => {
        this.#ended.resolve(ended);
      });
  }
}
