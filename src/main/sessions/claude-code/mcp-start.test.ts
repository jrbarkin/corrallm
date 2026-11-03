import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionApi } from '../connector';
import { ClaudeCode } from './claude-code';

const TOKEN = 'session-credential-canary';
const API: Extract<SessionApi, { kind: 'http' }> = {
  kind: 'http',
  server: 'corrallm',
  url: 'http://127.0.0.1:47101/mcp',
  token: TOKEN,
  tools: [
    { name: 'probe_read', destructive: false },
    { name: 'probe_delete', destructive: true },
  ],
  off: ['corrallm-server', 'corrallm-server-dev'],
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-entry-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const hooks = {
  url: 'http://127.0.0.1:2/hook',
  statusUrl: 'http://127.0.0.1:2/status',
  token: 'hook-canary',
  release: () => Promise.resolve(),
};
function cli() {
  return new ClaudeCode({
    cwd: dir,
    home: dir,
    env: { HOME: dir },
    managed: path.join(dir, 'managed'),
    api: API,
  });
}

describe('Terminal session MCP entry', () => {
  it('keeps its bearer only in its private file and grants exact non-destructive names', async () => {
    const one = cli();
    await one.prepare(dir, hooks);
    const file = path.join(dir, 'mcp.json');
    expect(JSON.parse(await readFile(file, 'utf8')) as unknown).toEqual({
      mcpServers: {
        corrallm: { type: 'http', url: API.url, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(settings).toMatchObject({
      permissions: { allow: ['mcp__corrallm__probe_read'] },
      deniedMcpServers: API.off.map((serverName) => ({ serverName })),
    });
    // No allowlist of its own where yours has none: one naming corrallm alone would block your
    // other servers in this session (the recordings' entry, `settings`, has none).
    expect(settings).not.toHaveProperty('allowedMcpServers');
    expect(JSON.stringify(settings)).not.toContain(TOKEN);
    const args = one.args({ dir, cwd: dir, id: null, resume: false, model: null, mode: null });
    expect(args).toContain(`--mcp-config=${file}`);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
  });
  it.each([
    ['your user settings', (config: string) => path.join(config, 'settings.json')],
    ['the project’s shared settings', () => path.join(dir, '.claude', 'settings.json')],
    ['the project’s local settings', () => path.join(dir, '.claude', 'settings.local.json')],
  ])(
    'names corrallm in an MCP allowlist only where %s already hold one, which it joins (A5)',
    async (_where, file) => {
      const config = path.join(dir, 'config');
      const where = file(config);
      await mkdir(path.dirname(where), { recursive: true });
      await writeFile(where, JSON.stringify({ allowedMcpServers: [{ serverName: 'github' }] }));
      const one = new ClaudeCode({
        cwd: dir,
        home: dir,
        env: { HOME: dir, CLAUDE_CONFIG_DIR: config },
        managed: path.join(dir, 'managed'),
        api: API,
      });
      await one.prepare(dir, hooks);
      const settings = JSON.parse(
        await readFile(path.join(dir, 'settings.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(settings.allowedMcpServers).toEqual([{ serverName: 'corrallm' }]);
      expect(one.api()).toEqual({ available: true });
    },
  );
  it.each(['managed-mcp.json', 'managed-settings.json', 'managed-settings.d/one.json'])(
    'starts without an entry when %s is deployed',
    async (name) => {
      const file = path.join(dir, 'managed', name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{}');
      const one = cli();
      await one.prepare(dir, hooks);
      expect(
        one
          .args({ dir, cwd: dir, id: null, resume: false, model: null, mode: null })
          .some((arg) => arg.startsWith('--mcp-config')),
      ).toBe(false);
      expect(one.api()).toMatchObject({
        available: false,
        reason: expect.stringContaining('managed') as string,
      });
      await expect(readFile(path.join(dir, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

it('retries only a documented sideload refusal once, with the entry and grants removed', async () => {
  const one = cli();
  await one.prepare(dir, hooks);
  expect(await one.retryWithoutApi('Unrelated startup error')).toBe(false);
  expect(
    await one.retryWithoutApi(
      'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
    ),
  ).toBe(true);
  expect(await one.retryWithoutApi('disableSideloadFlags')).toBe(false);
  expect(one.api()).toMatchObject({ available: false });
  const settings = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(settings.permissions).toBeUndefined();
  expect(settings.allowedMcpServers).toBeUndefined();
  expect(settings.deniedMcpServers).toEqual(API.off.map((serverName) => ({ serverName })));
  await expect(readFile(path.join(dir, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
