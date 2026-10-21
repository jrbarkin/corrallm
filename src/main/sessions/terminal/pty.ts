import { beforeSpawn, recordPty } from '../process';

/*
 * The pseudo-terminal a Terminal session's CLI runs in. node-pty is a native module: it is loaded
 * only when a session starts (unit tests pass a fake `SpawnPty` and never load it).
 */

/** A process running in a pseudo-terminal: what corrallm needs of node-pty's IPty. */
export interface Pty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ends the process: SIGHUP by default; Windows takes no signal. */
  kill(signal?: string): void;
  /** Stops reading what the process prints (it blocks once its buffer is full), until `resume`. */
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
}

export interface PtyOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
}

export type SpawnPty = (file: string, args: readonly string[], options: PtyOptions) => Promise<Pty>;

/** Runs `file` in a pseudo-terminal with node-pty, as an xterm-256color terminal. */
export const spawnPty: SpawnPty = async (file, args, { cwd, env, cols, rows }) => {
  const pty = await import('node-pty');
  beforeSpawn();
  const child = pty.spawn(file, [...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...env },
    // The RunAsNode fuse breaks node-pty's default Windows kill path (it forks a helper); the
    // bundled ConPTY DLL's does not.
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
  });
  recordPty(child);
  return child;
};
