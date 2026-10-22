import { fork, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { ADAPTERS } from '../sessions/adapters';
import { spawnPty } from '../sessions/terminal/pty';
import { Screen } from '../sessions/terminal/screen';
import type { ProgramStatus } from '../sessions/terminal/status';
import { JOURNAL_SIZE_LIMIT } from './store/checkpointer';
import { APPLICATION_ID, openStore } from './store/open';
import { connect } from './store/sqlite';
import type { Store } from './store/store';

/*
 * The native self-test (CORRALLM_NATIVE_SELFTEST=1; see docs/architecture/native-modules.md), diagnostic only: that what
 * the core needs loads and runs as bundled (CommonJS; packaged, fused), wherever it runs: the app's
 * main process (native-selftest.ts), its core process (entry.ts) and the CLI bundle under plain
 * Node (cli/main.ts). No real agent CLI, no login. Electron-free: what differs between those hosts
 * (whether the app is packaged) is passed in. Each check resolves with what it saw, or rejects
 * saying what failed.
 */

/** How long the whole self-test may take before its host gives up on it (exit 3). */
export const SELFTEST_TIMEOUT_MS = 60_000;

export interface Check {
  name: string;
  run: () => Promise<string>;
}

/** A check's outcome: what it saw, or why it failed. */
export interface CheckResult {
  name: string;
  ok: boolean;
  said: string;
}

/**
 * The checks, in order. `packaged`: the host is the packaged app, whose RunAsNode fuse makes
 * `child_process.fork` throw (an unpackaged Electron and plain Node fork as usual).
 */
export function selfTestChecks({ packaged }: { packaged: boolean }): Check[] {
  return [
    { name: 'node-pty', run: checkPty },
    { name: 'terminal screen', run: checkTerminalScreen },
    ...ADAPTERS.flatMap((adapter) => adapter.selfTests ?? []),
    { name: 'node:sqlite', run: () => checkSqlite() },
    { name: 'loopback HTTP', run: checkLoopbackHttp },
    { name: 'spawn', run: checkSpawn },
    ...(packaged ? [{ name: 'child_process.fork', run: () => checkForkRefused() }] : []),
  ];
}

/** Runs every check in turn, even after one fails, so a log shows every failure at once. */
export async function runChecks(checks: readonly Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, run } of checks) {
    try {
      results.push({ name, ok: true, said: await run() });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, said: `${name} failed: ${why}` });
    }
  }
  return results;
}

/** The process's memory, in whole megabytes, as the self-test reports it. */
export function memoryText(): string {
  const { rss, heapUsed } = process.memoryUsage();
  const mb = (bytes: number) => `${String(Math.round(bytes / 2 ** 20))} MB`;
  return `rss ${mb(rss)}, heap ${mb(heapUsed)}`;
}

function shell(script: string): [file: string, args: string[]] {
  return process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', script]]
    : ['/bin/sh', ['-c', script]];
}

function definedEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Runs a shell that exits at once in a pseudo-terminal, as Terminal sessions run (pty.ts). */
async function checkPty(): Promise<string> {
  const [file, args] = shell('exit 0');
  const child = await spawnPty(file, args, {
    cwd: homedir(),
    env: definedEnv(),
    cols: 80,
    rows: 24,
  });
  const code = await new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => {
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`the shell exited with ${String(code)}`);
  return `node-pty ok (pid ${String(child.pid)}, exit ${String(code)})`;
}

/**
 * A copy of a terminal's screen (@xterm/headless, with its addons), as main keeps one: it answers
 * the Program Status probe, reads a status report, and takes a snapshot.
 */
export async function checkTerminalScreen(): Promise<string> {
  const replies: string[] = [];
  const reports: ProgramStatus[] = [];
  const screen = new Screen({
    cols: 40,
    rows: 5,
    reply: (data) => replies.push(data),
    status: (report) => reports.push(report),
    answersQueries: () => true,
  });
  try {
    screen.write('\x1b]7501;?\x07\x1b]7501;state=working:app=agent\x07✻ self-test\r\n');
    const snapshot = await screen.snapshot();
    if (replies.length === 0 || reports[0]?.state !== 'working') {
      throw new Error('the screen did not answer or read Program Status');
    }
    if (!snapshot.data.includes('self-test')) throw new Error('the snapshot lost the screen');
    return `@xterm/headless ok (${String(snapshot.cols)}×${String(snapshot.rows)})`;
  } finally {
    screen.dispose();
  }
}

/**
 * The core's database (store/), opened in a temporary profile as the core opens it, through Node's
 * SQLite: each of its pragmas as set, a write through its lane (its log flushed on Node's thread
 * pool) read back by another connection, a checkpoint on its checkpointer's worker thread, which
 * begins the log anew there (its header's salts change), a snapshot of it (SQLite's backup,
 * Node's one call on its thread pool) read back, and its file, log and index the user's alone
 * (not on Windows, whose files have no such modes).
 */
export async function checkSqlite(folder = tmpdir()): Promise<string> {
  try {
    const profile = await mkdtemp(path.join(folder, 'corrallm-selftest-store-'));
    try {
      const { store, said } = await openStore(profile);
      if (store === undefined) throw new Error(said.join(' '));
      try {
        return await checkStore(store);
      } finally {
        await store.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`The core’s database check failed: ${why}`, { cause: error });
  }
}

/** Each pragma openStore sets, as it reads back (Core Database §5). */
function storePragmas(): Record<string, unknown> {
  return {
    journal_mode: 'wal',
    // NORMAL: the store flushes the log itself, after each commit, off the loop
    synchronous: 1,
    ...(process.platform === 'darwin' ? { fullfsync: 1, checkpoint_fullfsync: 1 } : {}),
    foreign_keys: 1,
    trusted_schema: 0,
    // INCREMENTAL
    auto_vacuum: 2,
    journal_size_limit: JOURNAL_SIZE_LIMIT,
    wal_autocheckpoint: 0,
    application_id: APPLICATION_ID,
  };
}

/** Checks the core's database, opened: rejects naming the first thing that isn't as it must be. */
export async function checkStore(store: Store): Promise<string> {
  const pragma = (name: string): unknown => store.prepare(`PRAGMA ${name}`).get()?.[name];
  const version = store.prepare('SELECT sqlite_version() AS version').get()?.version;
  if (typeof version !== 'string') throw new Error('SQLite did not report its version');
  for (const [name, value] of Object.entries(storePragmas())) {
    const read = pragma(name);
    if (read !== value) throw new Error(`${name} is ${String(read)}, not ${String(value)}`);
  }
  const seen = [`SQLite ${version}`, 'WAL', 'synchronous NORMAL'];
  if (process.platform === 'darwin') seen.push('fullfsync');
  seen.push('its other pragmas as set');
  await store.write(() => {
    store.exec('CREATE TABLE selftest (value TEXT NOT NULL) STRICT');
    store.prepare('INSERT INTO selftest (value) VALUES (?)').run('written');
  });
  readBack(store.file, 'core.db, read by another connection,');
  seen.push('a write through the lane flushed and read back');
  const header = async () => (await readFile(`${store.file}-wal`)).subarray(12, 24).toString('hex');
  const before = await header();
  await store.checkpoint();
  if ((await header()) === before) throw new Error('its checkpointer didn’t begin its log anew');
  seen.push('a checkpoint off the loop, its log begun anew there');
  readBack(await store.snapshot(), 'its snapshot');
  seen.push('a snapshot read back');
  if (process.platform !== 'win32') {
    for (const suffix of ['', '-wal', '-shm']) {
      const mode = (await stat(`${store.file}${suffix}`)).mode & 0o777;
      if (mode !== 0o600) throw new Error(`core.db${suffix} is ${mode.toString(8)}, not 600`);
    }
    seen.push('core.db, -wal and -shm 0600');
  }
  return seen.join(', ');
}

/**
 * Reads the database in `file` (`what`, in what it says) through a connection of its own that
 * only reads: it must be sound, corrallm's, and hold what the check wrote.
 */
function readBack(file: string, what: string): void {
  const reader = connect(file, { readOnly: true });
  try {
    if (reader.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
      throw new Error(`${what} isn’t sound`);
    }
    if (reader.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) {
      throw new Error(`${what} isn’t corrallm’s`);
    }
    if (reader.prepare('SELECT value FROM selftest').get()?.value !== 'written') {
      throw new Error(`${what} doesn’t hold what the lane wrote`);
    }
  } finally {
    reader.close();
  }
}

/** Serves HTTP on 127.0.0.1 and calls it, as agents call the hook and MCP servers. */
export async function checkLoopbackHttp(): Promise<string> {
  const server = createServer((_request, response) => {
    response.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    const body = await response.text();
    if (body !== 'ok') throw new Error(`the server answered “${body}”`);
    return `loopback HTTP ok (127.0.0.1:${String(port)})`;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Spawns a shell and reads what it printed, as sessions spawn the CLIs. */
export async function checkSpawn(): Promise<string> {
  const [file, args] = shell('echo ok');
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0 || output.trim() !== 'ok') {
    throw new Error(`the shell exited with ${String(code)}, saying “${output.trim()}”`);
  }
  return `spawn ok (pid ${String(child.pid)}, exit ${String(code)})`;
}

/**
 * `child_process.fork` throws, as the RunAsNode fuse makes it (docs/architecture/security.md, Fuses): a
 * packaged app can't run its own executable as Node. If a process starts, it is killed at once.
 */
export function checkForkRefused(forkWith: typeof fork = fork): Promise<string> {
  try {
    const child = forkWith(path.join(tmpdir(), 'corrallm-selftest-nothing.js'), [], {
      stdio: 'ignore',
    });
    child.kill();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return Promise.resolve(`child_process.fork refused (${why})`);
  }
  return Promise.reject(
    new Error('child_process.fork started a process: the RunAsNode fuse is off?'),
  );
}
