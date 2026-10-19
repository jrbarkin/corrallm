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

/** The spawn overloads are Node's; the owner records a successful spawn before it is returned. */
export const spawn = ((
  command: string,
  args: readonly string[] | SpawnOptions = [],
  options: SpawnOptions = {},
): ChildProcess => {
  const processes = owner.getStore();
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

/** The UTF-8 execFile helpers used by the core, with the same ownership as streamed CLIs. */
export function execFile(
  command: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, 'encoding'> & { encoding?: BufferEncoding },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const processes = owner.getStore();
  if (!processes) return execProcess(command, args, options, callback);
  // Node's execFile does not forward detached to spawn. Collect its bounded UTF-8 result here.
  const {
    timeout = 0,
    maxBuffer = 1024 * 1024,
    encoding = 'utf8',
    killSignal = 'SIGTERM',
    ...spawnOptions
  } = options;
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
    if (finished) return;
    child.stdout.destroy();
    child.stderr.destroy();
    void Promise.resolve(processes.stop(child, killSignal)).catch((error: unknown) => {
      console.error('Could not stop a CLI helper:', error);
    });
    finish(error);
  };
  if (timeout > 0)
    timer = setTimeout(() => {
      stop(Object.assign(new Error(`${command} timed out.`), { killed: true }));
    }, timeout);
  const collect = (into: Buffer[]) => {
    let size = 0;
    return (chunk: Buffer) => {
      if (finished) return;
      const room = Math.max(0, maxBuffer - size);
      size += chunk.length;
      if (room > 0) into.push(chunk.subarray(0, room));
      if (size > maxBuffer && failed === null) {
        stop(
          Object.assign(new Error(`${command} output exceeded maxBuffer.`), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            killed: true,
          }),
        );
      }
    };
  };
  child.stdout.on('data', collect(output));
  child.stderr.on('data', collect(errors));
  child.once('error', finish);
  child.once('close', (code, signal) => {
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
