import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { TestLifetime } from './test-lifetime';
import type { TestLifetimeOwner } from './test-lifetime';

export type TestChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ChildSystem {
  spawn: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => TestChild;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  groups: boolean;
}

const SYSTEM: ChildSystem = {
  spawn: (command, args, env) =>
    spawn(command, args, {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  },
  groups: process.platform !== 'win32',
};

interface Kept {
  child: TestChild;
  exited: Promise<number | null>;
  closed: Promise<void>;
  isClosed: boolean;
  code: number | null;
  error?: Error;
  /** The server in a script(1) pty is a separate session, not the wrapper's group. */
  target?: number;
  stopping?: Promise<number | null>;
}

/** Test children belong to teardown from spawn, even if no startup promise ever resolves. */
export class TestChildren {
  readonly #system: ChildSystem;
  readonly #children = new Map<TestChild, Kept>();
  #lifetime: TestLifetimeOwner | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;

  constructor(system = SYSTEM, lifetime?: TestLifetimeOwner) {
    this.#system = system;
    this.#lifetime = lifetime;
  }

  spawn(command: string, args: readonly string[], env = process.env): TestChild {
    if (this.#closing) throw new Error('A test cannot spawn a child after teardown began.');
    if (this.#system === SYSTEM) this.#lifetime ??= new TestLifetime();
    const prepared = this.#lifetime?.prepare(command, args, env) ?? { args, env };
    const child = this.#system.spawn(command, prepared.args, prepared.env);
    let exited!: (code: number | null) => void;
    let closed!: () => void;
    const kept: Kept = {
      child,
      exited: new Promise((resolve) => {
        exited = resolve;
      }),
      closed: new Promise((resolve) => {
        closed = resolve;
      }),
      isClosed: false,
      code: null,
    };
    this.#children.set(child, kept);
    child.once('exit', (code) => {
      kept.code = code;
      exited(code);
    });
    child.once('error', (error) => {
      kept.error = error;
      exited(null);
    });
    child.once('close', (code) => {
      kept.code = code;
      kept.isClosed = true;
      exited(code);
      closed();
    });
    // Node registers itself in its preload, before CLI startup; the parent records wrappers.
    if (child.pid !== undefined && command !== process.execPath) this.#lifetime?.track(child.pid);
    return child;
  }

  /** script's pty has a separate session: learn its pid before the CLI opens any profile. */
  terminal(
    command: readonly string[],
    env: NodeJS.ProcessEnv,
  ): {
    child: TestChild;
    printed: () => string;
    exited: Promise<number | null>;
  } {
    if (this.#system === SYSTEM) this.#lifetime ??= new TestLifetime();
    const [executable, ...args] = command;
    if (executable === undefined) throw new Error('A test terminal needs a command.');
    const prepared = this.#lifetime?.prepare(executable, args, env) ?? { args, env };
    const launch = [
      '/bin/sh',
      '-c',
      `printf 'corrallm-test-pid:%s\\n' "$$" && exec "$@"`,
      'corrallm-test',
      executable,
      ...prepared.args,
    ];
    const quote = (part: string) => `'${part.replaceAll("'", `'\\''`)}'`;
    const scriptArgs =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', ...launch]
        : ['-qec', `exec ${launch.map(quote).join(' ')}`, '/dev/null'];
    const child = this.spawn('script', scriptArgs, prepared.env);
    let printed = '';
    let known = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      printed += chunk;
      const pid = /corrallm-test-pid:(\d+)\r?\n/.exec(printed)?.[1];
      if (!known && pid !== undefined) {
        known = true;
        this.target(child, Number(pid));
      }
    });
    const kept = this.#kept(child);
    return {
      child,
      printed: () => printed.replace(/corrallm-test-pid:\d+\r?\n/, '').replaceAll('\r\n', '\n'),
      exited: kept.closed.then(() => kept.code),
    };
  }

  exited(child: TestChild): Promise<number | null> {
    return this.#kept(child).exited;
  }

  /** Remember the pty's server too, even if its script wrapper exits before teardown. */
  target(child: TestChild, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid test child pid.');
    const kept = this.#kept(child);
    kept.target = pid;
    if (this.#closing && this.#system.alive(pid)) this.#signal(pid, 'SIGTERM');
  }

  stop(child: TestChild): Promise<number | null> {
    const kept = this.#kept(child);
    return (kept.stopping ??= this.#stop(kept));
  }

  close(): Promise<void> {
    this.#closing = true;
    return (this.#closed ??= this.#close());
  }

  async #close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#children.keys()].map((child) => this.stop(child)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    // Always release the guardian's lease, even if primary teardown failed. It also owns
    // native CLI groups and terminal servers whose pid header never reached this worker.
    try {
      await this.#lifetime?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Some test children did not exit; their folders were kept.',
      );
  }

  /** execFile-style capture, owned before any await and including output after exit. */
  async run(
    command: string,
    args: readonly string[],
    env = process.env,
  ): Promise<{ stdout: string; stderr: string }> {
    const child = this.spawn(command, args, env);
    const kept = this.#kept(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    await kept.closed;
    if (kept.error || kept.code !== 0) {
      throw Object.assign(kept.error ?? new Error(`Test command ${command} did not succeed.`), {
        code: child.signalCode ?? kept.code,
        stdout,
        stderr,
      });
    }
    return { stdout, stderr };
  }

  #kept(child: TestChild): Kept {
    const kept = this.#children.get(child);
    if (!kept) throw new Error('The test does not own that child.');
    return kept;
  }

  #pids(kept: Kept): number[] {
    return [
      ...new Set([kept.child.pid, kept.target].filter((pid): pid is number => pid !== undefined)),
    ];
  }

  #gone(kept: Kept): boolean {
    return (
      kept.isClosed &&
      this.#pids(kept).every(
        (pid) => !this.#system.alive(pid) && (!this.#system.groups || !this.#system.alive(-pid)),
      )
    );
  }

  #signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.#system.signal(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  async #wait(kept: Kept, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.#gone(kept)) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, left)));
    }
    return true;
  }

  async #stop(kept: Kept): Promise<number | null> {
    const pid = kept.target ?? kept.child.pid;
    if (pid !== undefined && this.#system.alive(pid)) this.#signal(pid, 'SIGTERM');
    if (!(await this.#wait(kept, 5000))) {
      for (const pid of this.#pids(kept)) {
        if (this.#system.groups && this.#system.alive(-pid)) this.#signal(-pid, 'SIGKILL');
        // Also covers a terminal server whose shell made a different group, and Windows.
        if (this.#system.alive(pid)) this.#signal(pid, 'SIGKILL');
      }
      if (!(await this.#wait(kept, 2000)))
        throw new Error(`Test child ${String(pid)} did not exit; its folder was kept.`);
    }
    return kept.code;
  }
}
