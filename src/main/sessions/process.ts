import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile as execProcess, spawn as spawnProcess } from 'node:child_process';
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
  SpawnOptions,
} from 'node:child_process';

/** A core's owner of the processes started while its work runs. No profile is global. */
export interface ProcessOwner {
  /** Refuses new OS spawns once the owner starts closing. */
  beforeSpawn(): void;
  stop(
    child: Parameters<ProcessOwner['node']>[0],
    signal: NodeJS.Signals | number,
  ): void | Promise<void>;
  node(
    child: {
      readonly pid?: number | undefined;
      once(event: 'exit' | 'close', listener: () => void): unknown;
      kill(signal?: NodeJS.Signals | number): unknown;
    },
    until?: 'close',
  ): void;
  pty(child: {
    readonly pid: number;
    onExit(listener: () => void): unknown;
    kill(signal?: string): unknown;
  }): void;
}

const owner = new AsyncLocalStorage<ProcessOwner>();

/** Keeps ownership through the core's asynchronous work, including an SDK's custom spawn. */
export function withProcesses<T>(processes: ProcessOwner, run: () => T): T {
  return owner.run(processes, run);
}

/** A launch's children, still owned by the core, that can be stopped before it returns a session. */
export class ProcessScope implements ProcessOwner {
  readonly #parent = owner.getStore();
  readonly #children = new Set<Parameters<ProcessOwner['node']>[0]>();
  #closed = false;

  run<T>(work: () => T): T {
    return withProcesses(this, work);
  }

  beforeSpawn(): void {
    if (this.#closed) throw new Error('This session is no longer starting.');
    this.#parent?.beforeSpawn();
  }

  node(child: Parameters<ProcessOwner['node']>[0], until?: 'close'): void {
    this.#parent?.node(child, until);
    if (child.pid === undefined) return;
    this.#children.add(child);
    child.once(until ?? 'exit', () => {
      this.#children.delete(child);
    });
  }

  pty(child: Parameters<ProcessOwner['pty']>[0]): void {
    this.#parent?.pty(child);
    const process = {
      pid: child.pid,
      once: (_event: 'exit' | 'close', listener: () => void) => child.onExit(listener),
      kill: (signal?: NodeJS.Signals | number) =>
        child.kill(typeof signal === 'number' ? undefined : signal),
    };
    this.#children.add(process);
    child.onExit(() => {
      this.#children.delete(process);
    });
  }

  async stop(
    child: Parameters<ProcessOwner['node']>[0],
    signal: NodeJS.Signals | number,
  ): Promise<void> {
    await this.#parent?.stop(child, signal);
  }

  /** Refuses late spawns and ends only this launch's groups through the core's identity checks. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#children].map((child) => this.stop(child, 'SIGTERM')));
  }
}

/** The spawn overloads are Node's; the owner records a successful spawn before it is returned. */
export const spawn = ((
  command: string,
  args: readonly string[] | SpawnOptions = [],
  options: SpawnOptions = {},
): ChildProcess => {
  const processes = owner.getStore();
  processes?.beforeSpawn();
  const argv = Array.isArray(args) ? (args as readonly string[]) : [];
  const settings = Array.isArray(args) ? options : (args as SpawnOptions);
  const child = spawnProcess(
    command,
    argv,
    processes ? { ...settings, detached: process.platform !== 'win32' } : settings,
  );
  processes?.node(child);
  return child;
}) as typeof spawnProcess;

/**
 * spawn, for a command that must never run unowned (a worktree's setup): refused without an owner,
 * and owned until its output closes too, since its leader can exit before descendants let go of it.
 */
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const processes = owner.getStore();
  if (!processes) throw new Error(`${command} isn’t run: no process owner would record it.`);
  processes.beforeSpawn();
  const child = spawnProcess(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
  processes.node(child, 'close');
  return child;
}

/** The UTF-8 execFile helpers used by the core, with the same ownership as streamed CLIs. */
export function execFile(
  command: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, 'encoding'> & {
    encoding?: BufferEncoding;
    /** A capped read answers only once the owned group has stopped. */
    waitForStop?: boolean;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const processes = owner.getStore();
  const { waitForStop = false, ...nativeOptions } = options;
  if (!processes) return execProcess(command, args, nativeOptions, callback);
  processes.beforeSpawn();
  // Node's execFile does not forward detached to spawn. Collect its bounded UTF-8 result here.
  const {
    timeout = 0,
    maxBuffer = 1024 * 1024,
    encoding = 'utf8',
    killSignal = 'SIGTERM',
    ...spawnOptions
  } = nativeOptions;
  const child = spawnProcess(command, args, {
    ...spawnOptions,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Its leader can exit before descendants let go of stdout: keep owning the helper until close.
  processes.node(child, 'close');
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let failed: ExecFileException | null = null;
  let finished = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error: ExecFileException | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    callback(
      error,
      Buffer.concat(output).toString(encoding),
      Buffer.concat(errors).toString(encoding),
    );
  };
  const stop = (error: ExecFileException) => {
    if (finished || stopping) return;
    stopping = true;
    failed = error;
    clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
    const cleanupFailed = (reason: unknown) => {
      if (waitForStop) {
        finish(
          new Error(
            `Could not stop a CLI helper: ${reason instanceof Error ? reason.message : String(reason)}`,
          ),
        );
      } else console.error('Could not stop a CLI helper:', reason);
    };
    try {
      const stopped = processes.stop(child, killSignal);
      if (waitForStop)
        void Promise.resolve(stopped).then(() => {
          finish(error);
        }, cleanupFailed);
      else {
        void Promise.resolve(stopped).catch(cleanupFailed);
        finish(error);
      }
    } catch (reason) {
      cleanupFailed(reason);
      if (!waitForStop) finish(error);
    }
  };
  if (timeout > 0)
    timer = setTimeout(() => {
      stop(Object.assign(new Error(`${command} timed out.`), { killed: true }));
    }, timeout);
  // Each stream keeps its first maxBuffer bytes; past them the child's group is ended, saying
  // which stream it was (as Node's own execFile says it), with what each kept.
  const collect = (into: Buffer[], stream: 'stdout' | 'stderr') => {
    let size = 0;
    return (chunk: Buffer) => {
      if (finished || stopping) return;
      const room = Math.max(0, maxBuffer - size);
      size += chunk.length;
      if (room > 0) into.push(chunk.subarray(0, room));
      if (size > maxBuffer && failed === null) {
        stop(
          Object.assign(new Error(`${command}: ${stream} maxBuffer length exceeded.`), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            killed: true,
            stream,
          }),
        );
      }
    };
  };
  child.stdout.on('data', collect(output, 'stdout'));
  child.stderr.on('data', collect(errors, 'stderr'));
  child.once('error', (error) => {
    if (!stopping) finish(error);
  });
  child.once('close', (code, signal) => {
    if (stopping) return;
    if (failed === null && (code !== 0 || signal !== null)) {
      failed = Object.assign(new Error(`${command} exited with ${String(code ?? signal)}.`), {
        ...(code === null ? {} : { code }),
        ...(signal === null ? {} : { signal }),
      });
    }
    finish(failed);
  });
  return child;
}

/** node-pty's forkpty creates the POSIX session and process group itself. */
export function recordPty(child: Parameters<ProcessOwner['pty']>[0]): void {
  owner.getStore()?.pty(child);
}

/** Check after loading node-pty, immediately before its synchronous native spawn. */
export function beforeSpawn(): void {
  owner.getStore()?.beforeSpawn();
}
