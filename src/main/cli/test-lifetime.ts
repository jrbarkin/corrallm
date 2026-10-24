import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Socket } from 'node:net';

import type { ChildSystem } from '../core/children';
import { inspectProcess } from '../core/process-identity';
import {
  recordedTestGroups,
  stopTestGroups,
  testGroup,
  TEST_GROUP_SYSTEM,
} from './test-process-groups';

const ENTRY = path.resolve('node_modules/.cache/test-lifetime/entry.mjs');
const ended = (directory: string) =>
  !existsSync(directory) || existsSync(path.join(directory, 'closed'));

/** Called by the Node preload before it imports any CLI code, also inside script(1)'s pty. */
export function recordTestProcess(
  directory: string,
  pid: number,
  profile?: string,
  inspect: ChildSystem['inspect'] = inspectProcess,
): void {
  if (ended(directory)) throw new Error('The test owner ended; refusing to start its CLI.');
  const found = inspect(pid);
  if (found?.group !== pid) throw new Error('The test child has no private process identity.');
  const record = { pid, started: found.started, ...(profile === undefined ? {} : { profile }) };
  const partial = path.join(directory, `${String(pid)}.partial`);
  writeFileSync(partial, JSON.stringify(record), { mode: 0o600 });
  renameSync(partial, path.join(directory, `${String(pid)}.json`));
  // The guardian may have closed between the first check and publication. No CLI loads then.
  if (ended(directory)) throw new Error('The test owner ended; refusing to start its CLI.');
}

/** The pipe is an OS lease: EOF/close happens even when Vitest's worker receives SIGKILL. */
export async function watchTestLifetime(
  directory: string,
  owner: Readable,
  system = TEST_GROUP_SYSTEM,
): Promise<void> {
  await new Promise<void>((resolve) => {
    owner.once('end', resolve);
    owner.once('close', resolve);
    owner.once('error', resolve);
    owner.resume();
    writeFileSync(path.join(directory, 'ready'), '', { mode: 0o600 });
  });
  writeFileSync(path.join(directory, 'closed'), '', { mode: 0o600 });
  const records = readdirSync(directory)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) =>
      testGroup(JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as unknown),
    );
  await stopTestGroups(records, system);
  // serve can start native CLIs in separate private groups. Its exit must precede this read.
  const profiles = [
    ...new Set(records.flatMap((record) => (record.profile === undefined ? [] : [record.profile]))),
  ];
  const native = await Promise.all(
    profiles.map((profile) => recordedTestGroups(path.join(profile, 'sessions/pids.json'))),
  );
  await stopTestGroups(native.flat(), system);
}

/** Wait for the independent guardian before any guarded Node process can run application code. */
export async function registerTestCli(directory: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!existsSync(path.join(directory, 'ready'))) {
    if (ended(directory)) throw new Error('The test owner ended; refusing to start its CLI.');
    if (performance.now() >= deadline) throw new Error('The test CLI guardian did not start.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const index = process.argv.indexOf('--profile');
  const profile = index < 0 ? undefined : process.argv[index + 1];
  recordTestProcess(directory, process.pid, profile);
}

export interface TestLifetimeOwner {
  prepare: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => { args: readonly string[]; env: NodeJS.ProcessEnv };
  track: (pid: number) => void;
  close: () => Promise<void>;
}

/** One detached guardian per test scope, with no access to other tests' folders or pids. */
export class TestLifetime implements TestLifetimeOwner {
  readonly #directory: string;
  readonly #guardian;
  readonly #exit: Promise<void>;
  #closing: Promise<void> | undefined;

  constructor() {
    if (!existsSync(ENTRY))
      throw new Error('Build the test CLI guardian with the main Vitest global setup first.');
    const cache = path.resolve('node_modules/.cache/probes/test-lifetimes');
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    this.#directory = mkdtempSync(path.join(cache, 'scope-'));
    this.#guardian = spawn(process.execPath, [ENTRY, 'watch', this.#directory], {
      detached: true,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    this.#exit = new Promise<void>((resolve, reject) => {
      this.#guardian.once('error', reject);
      this.#guardian.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Test CLI guardian exited ${String(code ?? signal)}; records kept at ${this.#directory}.`,
            ),
          );
      });
    });
    // A dead guardian must be observed, but cannot produce an unhandled rejection mid-test.
    void this.#exit.catch(() => undefined);
    this.#guardian.stdin.on('error', () => {
      // The guardian's exit/error promise reports a lost pipe with the scope's location.
    });
    this.#guardian.unref();
    (this.#guardian.stdin as Socket).unref();
  }

  prepare(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
    return {
      args: command === process.execPath ? ['--import', ENTRY, ...args] : args,
      env: { ...env, CORRALLM_TEST_SCOPE: this.#directory },
    };
  }

  track(pid: number): void {
    if (existsSync(path.join(this.#directory, `${String(pid)}.json`))) return;
    const found = inspectProcess(pid);
    if (found !== undefined) recordTestProcess(this.#directory, pid, undefined, () => found);
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    writeFileSync(path.join(this.#directory, 'closed'), '', { mode: 0o600 });
    this.#guardian.stdin.end();
    await this.#exit;
    rmSync(this.#directory, { recursive: true, force: true });
  }
}
