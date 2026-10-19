import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { Inbox } from '../sessions/sdk/inbox';
import { spawnPty } from '../sessions/terminal/pty';
import { Screen } from '../sessions/terminal/screen';
import type { ProgramStatus } from '../sessions/terminal/status';
import fakeClaude from './selftest-claude.mjs?raw';
import { openStore } from './store/open';
import { connect } from './store/sqlite';
import type { Store } from './store/store';

/*
 * The native self-test (CORRALLM_NATIVE_SELFTEST=1; see CLAUDE.md), diagnostic only: that what
 * the core needs loads and runs as bundled (CommonJS; packaged, fused), wherever it runs: the app's
 * main process (native-selftest.ts), its core process (entry.ts) and the CLI bundle under plain
 * Node (cli/index.ts). No real `claude`, no login. Electron-free: what differs between those hosts
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
    { name: 'Agent SDK', run: () => checkAgentSdk() },
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
 * Claude Code's status probe, reads a status report, and takes a snapshot.
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
    screen.write('\x1b]7501;?\x07\x1b]7501;state=working:app=claude-code\x07✻ self-test\r\n');
    const snapshot = await screen.snapshot();
    if (replies.length === 0 || reports[0]?.state !== 'working') {
      throw new Error('the screen did not answer or read Claude Code’s status');
    }
    if (!snapshot.data.includes('self-test')) throw new Error('the snapshot lost the screen');
    return `@xterm/headless ok (${String(snapshot.cols)}×${String(snapshot.rows)})`;
  } finally {
    screen.dispose();
  }
}

/**
 * The Agent SDK as bundled (its own file found through `import.meta.url`, as vite.main.config.mts
 * defines it) starts a query as the Agent SDK connection does (streaming input, the CLI's path
 * given) against a tiny fake `claude` (selftest-claude.mjs, written to a temporary folder and run
 * with `node`, as the SDK runs a .mjs), and hears one turn's result.
 */
export async function checkAgentSdk(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-selftest-'));
  const claude = path.join(dir, 'claude.mjs');
  await writeFile(claude, fakeClaude);
  const inbox = new Inbox<SDKUserMessage>();
  const run = query({
    prompt: inbox,
    options: {
      pathToClaudeCodeExecutable: claude,
      cwd: dir,
      env: definedEnv(env),
      settingSources: [],
    },
  });
  try {
    await run.initializationResult();
    inbox.push({
      type: 'user',
      message: { role: 'user', content: 'Say ok.' },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
    for await (const message of run) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') throw new Error(`the query failed (${message.subtype})`);
      return `Agent SDK ok (the fake claude said “${message.result}”)`;
    }
    throw new Error('the query ended without a result');
  } finally {
    inbox.end();
    run.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The core's database (store/), opened in a temporary profile as the core opens it, through Node's
 * SQLite: its pragmas as set, a write through its lane read back by another connection, and its
 * file, log and index the user's alone (not on Windows, whose files have no such modes).
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

async function checkStore(store: Store): Promise<string> {
  const pragma = (name: string): unknown => store.prepare(`PRAGMA ${name}`).get()?.[name];
  const version = store.prepare('SELECT sqlite_version() AS version').get()?.version;
  if (typeof version !== 'string') throw new Error('SQLite did not report its version');
  const seen = [`SQLite ${version}`];
  if (pragma('journal_mode') !== 'wal') throw new Error('it keeps no write-ahead log');
  seen.push('WAL');
  if (pragma('synchronous') !== 2) throw new Error('synchronous is not FULL');
  seen.push('synchronous FULL');
  if (process.platform === 'darwin') {
    if (pragma('fullfsync') !== 1) throw new Error('fullfsync is off');
    seen.push('fullfsync');
  }
  await store.write(() => {
    store.exec('CREATE TABLE selftest (value TEXT NOT NULL) STRICT');
    store.prepare('INSERT INTO selftest (value) VALUES (?)').run('written');
  });
  const reader = connect(store.file, { readOnly: true });
  try {
    if (reader.prepare('SELECT value FROM selftest').get()?.value !== 'written') {
      throw new Error('another connection did not read back what the lane wrote');
    }
  } finally {
    reader.close();
  }
  seen.push('a write through the lane read back');
  if (process.platform !== 'win32') {
    for (const suffix of ['', '-wal', '-shm']) {
      const mode = (await stat(`${store.file}${suffix}`)).mode & 0o777;
      if (mode !== 0o600) throw new Error(`core.db${suffix} is ${mode.toString(8)}, not 600`);
    }
    seen.push('core.db, -wal and -shm 0600');
  }
  return seen.join(', ');
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
 * `child_process.fork` throws, as the RunAsNode fuse makes it (CLAUDE.md, Security rules): a
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
