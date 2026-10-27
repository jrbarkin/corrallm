import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  statusLineContext,
  statusLineProgress,
  statusLineSettings,
  statusLineUsage,
  userStatusLine,
} from './statusline';
import type { StatusLine } from './statusline';

const NOW = Date.UTC(2026, 9, 12, 12, 0);

describe('status line context', () => {
  it('reads current request tokens, including caches and output, rather than session totals', () => {
    expect(statusLineContext({ context_window: { context_window_size: 1_000_000, total_input_tokens: 900_000, used_percentage: 95,
      current_usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 } } })).toEqual({ used: 14, window: 1_000_000, compactAt: 967_000 });
  });
  it('uses the reported percentage only when no current request tokens are supplied', () => {
    expect(statusLineContext({ context_window: { context_window_size: 1_000_000, used_percentage: 94.7 } })).toEqual({ used: 947_000, window: 1_000_000, compactAt: 967_000 });
  });
  it.each([{}, { context_window_size: 0 }, { context_window_size: 200_000, used_percentage: 101 }, { context_window_size: 200_000, used_percentage: 8, current_usage: { input_tokens: -1 } }])('leaves absent or malformed context unknown (%j)', (context_window) => {
    expect(statusLineContext({ context_window })).toBeNull();
  });
});

/** Claude Code's status line input, as it was seen (2.1.296), with its usage limits. */
const INPUT = {
  session_id: '11f0f14a-0000-4000-8000-000000000000',
  cwd: '/work/app',
  model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
  cost: { total_cost_usd: 0.01 },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: NOW / 1000 + 3600 },
    seven_day: { used_percentage: 17.5, resets_at: NOW / 1000 + 3 * 86_400 },
  },
};

describe('statusLineUsage', () => {
  it('reads the share of each window used, and when it resets', () => {
    expect(statusLineUsage(INPUT, NOW)).toEqual({
      fiveHour: { usedPercent: 42, resetsAt: NOW + 3600_000 },
      weekly: { usedPercent: 17.5, resetsAt: NOW + 3 * 86_400_000 },
    });
  });

  it('reads a window without a reset time, and keeps shares from 0 to 100', () => {
    expect(
      statusLineUsage(
        {
          rate_limits: { five_hour: { used_percentage: 104 }, seven_day: { used_percentage: -2 } },
        },
        NOW,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 100, resetsAt: null },
      weekly: { usedPercent: 0, resetsAt: null },
    });
  });

  it.each([
    [{}],
    [{ rate_limits: null }],
    [{ rate_limits: { five_hour: { used_percentage: '42' } } }],
    [{ rate_limits: { five_hour: { used_percentage: Number.NaN } } }],
    [{ rate_limits: { opus: { used_percentage: 3 } } }],
  ])('reads nothing from %j', (input) => {
    expect(statusLineUsage(input, NOW)).toBeUndefined();
  });

  it('drops a reset time that is not a time', () => {
    expect(
      statusLineUsage(
        { rate_limits: { five_hour: { used_percentage: 5, resets_at: 'soon' } } },
        NOW,
      ),
    ).toEqual({ fiveHour: { usedPercent: 5, resetsAt: null } });
    expect(
      statusLineUsage(
        { rate_limits: { five_hour: { used_percentage: 5, resets_at: NOW / 1000 + 90 * 86_400 } } },
        NOW,
      ),
    ).toEqual({ fiveHour: { usedPercent: 5, resetsAt: null } });
  });
});

describe('statusLineProgress', () => {
  /** As 2.1.310 gives it: its clock, limits, vim mode and the like beside its work. */
  const input = {
    ...INPUT,
    cost: {
      total_cost_usd: 0.01234,
      total_duration_ms: 45_000,
      total_api_duration_ms: 2300,
      total_lines_added: 156,
      total_lines_removed: 23,
    },
    context_window: {
      total_input_tokens: 15_234,
      total_output_tokens: 4521,
      context_window_size: 200_000,
      used_percentage: 8,
    },
    vim: { mode: 'INSERT' },
  };

  it('is the same for a timed refresh: its clock, limits and the rest left out', () => {
    expect(
      statusLineProgress({
        ...input,
        cost: { ...input.cost, total_duration_ms: 46_000 },
        rate_limits: { five_hour: { used_percentage: 43, resets_at: NOW / 1000 + 3599 } },
        vim: { mode: 'NORMAL' },
      }),
    ).toBe(statusLineProgress(input));
  });

  it.each([
    ['cost', 'total_cost_usd', 0.02],
    ['cost', 'total_api_duration_ms', 2400],
    ['cost', 'total_lines_added', 157],
    ['cost', 'total_lines_removed', 24],
    ['context_window', 'total_input_tokens', 16_000],
    ['context_window', 'total_output_tokens', 4600],
  ] as const)('moves with its work (%s.%s)', (group, key, value) => {
    const progress = statusLineProgress({ ...input, [group]: { ...input[group], [key]: value } });
    expect(progress).toBeDefined();
    expect(progress).not.toBe(statusLineProgress(input));
  });

  it.each([[{}], [{ cost: { total_duration_ms: 1000 } }], [{ cost: { total_cost_usd: '0.1' } }]])(
    'says nothing of %j',
    (fields) => {
      expect(statusLineProgress(fields)).toBeUndefined();
    },
  );
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm statusline '));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function settingsFile(file: string, settings: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
}

describe('userStatusLine', () => {
  const line = (command: string, more: object = {}) => ({
    statusLine: { type: 'command', command, ...more },
  });

  it('finds the user’s own, as Claude Code does: local, then project, then user settings', async () => {
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'app');
    const env = { HOME: home };
    expect(await userStatusLine(env, cwd)).toBeUndefined();

    await settingsFile(
      path.join(home, '.claude', 'settings.json'),
      line('user-line', { padding: 2 }),
    );
    expect(await userStatusLine(env, cwd)).toEqual({
      type: 'command',
      command: 'user-line',
      padding: 2,
    });
    await settingsFile(path.join(cwd, '.claude', 'settings.json'), line('project-line'));
    expect((await userStatusLine(env, cwd))?.command).toBe('project-line');
    await settingsFile(path.join(cwd, '.claude', 'settings.local.json'), line('local-line'));
    expect((await userStatusLine(env, cwd))?.command).toBe('local-line');
  });

  it('reads the user settings from CLAUDE_CONFIG_DIR when it is set', async () => {
    const config = path.join(dir, 'config');
    await settingsFile(path.join(config, 'settings.json'), line('configured'));
    expect(
      (await userStatusLine({ HOME: path.join(dir, 'home'), CLAUDE_CONFIG_DIR: config }, dir))
        ?.command,
    ).toBe('configured');
  });

  it('passes over files it cannot read, and status lines that are not commands', async () => {
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'app');
    await settingsFile(path.join(home, '.claude', 'settings.json'), line('user-line'));
    await settingsFile(path.join(cwd, '.claude', 'settings.json'), '{ not json');
    await settingsFile(path.join(cwd, '.claude', 'settings.local.json'), {
      statusLine: { type: 'command', command: 42 },
    });
    expect((await userStatusLine({ HOME: home }, cwd))?.command).toBe('user-line');
  });

  it('keeps how it is shown (padding, refresh, the vim indicator), and nothing else', async () => {
    await settingsFile(
      path.join(dir, '.claude', 'settings.json'),
      line('mine', { padding: 1, refreshInterval: 5, hideVimModeIndicator: true, args: ['x'] }),
    );
    expect(await userStatusLine({ HOME: path.join(dir, 'nobody') }, dir)).toEqual({
      type: 'command',
      command: 'mine',
      padding: 1,
      refreshInterval: 5,
      hideVimModeIndicator: true,
    });
  });
});

/** A server standing in for main's hook server: what was posted, with its headers. */
async function listen(): Promise<{
  url: string;
  posts: { url: string | undefined; headers: IncomingHttpHeaders; body: string }[];
  close: () => Promise<void>;
}> {
  const posts: { url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      posts.push({ url: request.url, headers: request.headers, body });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/status`,
    posts,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Runs a status line command as Claude Code does (`/bin/sh -c`, the input then a line break on
 * stdin, in the project folder): what it printed, and its exit code.
 */
function run(
  line: StatusLine,
  input: string,
  cwd: string,
): Promise<{ stdout: string; code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(line.command, [], { shell: true, cwd, env: { ...process.env } });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, code, ms: Date.now() - started });
    });
    child.stdin.end(`${input}\n`);
  });
}

describe.skipIf(process.platform === 'win32')('the status line corrallm gives Claude Code', () => {
  const TOKEN = 'a'.repeat(48);
  let server: Awaited<ReturnType<typeof listen>>;
  let home: string;
  let cwd: string;
  let session: string;
  beforeEach(async () => {
    server = await listen();
    home = path.join(dir, 'home');
    cwd = path.join(dir, "it's app");
    session = path.join(dir, 'session');
    await mkdir(cwd, { recursive: true });
    await mkdir(session);
  });
  afterEach(async () => {
    await server.close();
  });

  const settings = (url = server.url) =>
    statusLineSettings({ dir: session, url, token: TOKEN, env: { HOME: home }, cwd });

  it('reports the input to corrallm, with the session’s token, and shows the user’s own line', async () => {
    // The user's status line echoes what it was given, to show it gets the same input.
    await settingsFile(path.join(cwd, '.claude', 'settings.local.json'), {
      statusLine: {
        type: 'command',
        command: 'printf "mine: "; cat; echo "(in $PWD)"',
        padding: 1,
      },
    });
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    expect(statusLine.padding).toBe(1);
    const input = JSON.stringify(INPUT);
    const { stdout, code } = await run(statusLine, input, cwd);
    expect(code).toBe(0);
    expect(stdout).toBe(`mine: ${input}\n(in ${realpathSync(cwd)})\n`);
    await vi.waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    const [post] = server.posts;
    expect(post?.url).toBe('/status');
    expect(post?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(post?.body ?? '')).toEqual(INPUT);
  });

  it('passes the user’s status line’s exit code on', async () => {
    await settingsFile(path.join(cwd, '.claude', 'settings.json'), {
      statusLine: { type: 'command', command: 'echo broken; exit 3' },
    });
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    expect(await run(statusLine, JSON.stringify(INPUT), cwd)).toMatchObject({
      stdout: 'broken\n',
      code: 3,
    });
  });

  it('prints nothing when the user has no status line of their own', async () => {
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    expect(await run(statusLine, JSON.stringify(INPUT), cwd)).toMatchObject({
      stdout: '',
      code: 0,
    });
    await vi.waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
  });

  it('posts context alone even when the input says nothing of usage limits', async () => {
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    const input = { context_window: { context_window_size: 1_000_000, used_percentage: 94.7 } };
    await run(statusLine, JSON.stringify(input), cwd);
    await vi.waitFor(() => { expect(server.posts).toHaveLength(1); });
    expect(JSON.parse(server.posts[0]?.body ?? '')).toEqual(input);
  });

  it('posts nothing when the input says nothing of context or usage limits', async () => {
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    await run(statusLine, JSON.stringify({ ...INPUT, rate_limits: undefined }), cwd);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.posts).toEqual([]);
  });

  it('still shows the user’s line, at once, when corrallm cannot be reached', async () => {
    await settingsFile(path.join(home, '.claude', 'settings.json'), {
      statusLine: { type: 'command', command: 'echo mine' },
    });
    await server.close();
    const { statusLine } = await settings(server.url);
    if (!statusLine) throw new Error('no status line');
    const { stdout, code, ms } = await run(statusLine, JSON.stringify(INPUT), cwd);
    expect({ stdout, code }).toEqual({ stdout: 'mine\n', code: 0 });
    expect(ms).toBeLessThan(1500);
    server = await listen();
  });

  it('runs nothing the input says, whatever it holds', async () => {
    await settingsFile(path.join(cwd, '.claude', 'settings.json'), {
      statusLine: { type: 'command', command: "echo 'it''s mine'" },
    });
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    const evil = path.join(dir, 'pwned');
    const input = JSON.stringify({
      ...INPUT,
      cwd: `$(touch '${evil}') \`touch '${evil}'\` "; touch '${evil}'; '`,
    });
    expect((await run(statusLine, input, cwd)).stdout).toBe('its mine\n');
    await vi.waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    // Exactly as Claude Code gave it, its line break included.
    expect(server.posts[0]?.body).toBe(`${input}\n`);
    expect(existsSync(evil)).toBe(false);
  });

  it('keeps the token off the command line, in a file only the user can read', async () => {
    const { statusLine } = await settings();
    if (!statusLine) throw new Error('no status line');
    expect(statusLine.command).not.toContain(TOKEN);
    const script = await readFile(path.join(session, 'statusline.sh'), 'utf8');
    expect(script).not.toContain(TOKEN);
    const header = path.join(session, 'statusline-header');
    expect(await readFile(header, 'utf8')).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expect((await stat(header)).mode & 0o077).toBe(0);
  });
});

describe('statusLineSettings on Windows', () => {
  it('adds no status line: the user’s own shows as it is, and no reading comes', async () => {
    await settingsFile(path.join(dir, '.claude', 'settings.json'), {
      statusLine: { type: 'command', command: 'echo mine' },
    });
    expect(
      await statusLineSettings({
        dir,
        url: 'http://127.0.0.1:1/status',
        token: 'x',
        env: {},
        cwd: dir,
        platform: 'win32',
      }),
    ).toEqual({});
    expect(existsSync(path.join(dir, 'statusline.sh'))).toBe(false);
  });
});
