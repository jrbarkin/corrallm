import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppServer, AppServerOptions, startAppServer } from './rpc';
import { apiEntry, entryIsCurrent, prepareApi } from './mcp';
import type { HttpApi } from './mcp';
const API: HttpApi = {
  kind: 'http',
  server: 'corrallm',
  url: 'http://127.0.0.1:47101/mcp',
  token: 'session-credential-canary',
  tools: [
    { name: 'probe_read', destructive: false },
    { name: 'probe_delete', destructive: true },
  ],
  off: ['corrallm-server', 'corrallm-server-dev'],
};
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'app-server/fixtures/mcp-entry.json'), 'utf8'),
) as { cases: Record<string, { config?: unknown }> };
const recorded = (name: string) => {
  const config = fixture.cases[name]?.config;
  return { config, origins: (config as { origins?: unknown }).origins };
};
const CONTEXT = {
  codex: '/never-run',
  cwd: '/project',
  env: { HOME: '/home', CORRALLM_AGENT_SESSION: '1' },
};

describe('session MCP config', () => {
  it('uses environment bearer and exact per-tool approval modes', () => {
    expect(apiEntry(API)).toEqual({
      url: API.url,
      enabled: true,
      disabled_tools: [],
      bearer_token_env_var: 'CORRALLM_SESSION_TOKEN',
      default_tools_approval_mode: 'prompt',
      tools: {
        probe_read: { approval_mode: 'approve' },
        probe_delete: { approval_mode: 'prompt' },
      },
    });
  });
  it('accepts the recorded whole entry from session flags', () => {
    expect(entryIsCurrent(recorded('clean'), apiEntry(API))).toBe(true);
  });
  it.each([
    'userPlain',
    'userDisabled',
    'userHardened',
    'userHelper',
    'userEnvAuth',
    'project',
    'userInlineBearer',
  ])('keeps the API off unless %s is wholly the session entry', (name) => {
    expect(entryIsCurrent(recorded(name), apiEntry(API))).toBe(false);
  });
  it('requires every planned value and every valued leaf’s session origin', () => {
    const good = recorded('clean');
    for (const key of [
      'url',
      'tools',
      'bearer_token_env_var',
      'enabled',
      'default_tools_approval_mode',
    ]) {
      const copy = structuredClone(good) as {
        config: { mcp_servers: { corrallm: Record<string, unknown> } };
      };
      copy.config.mcp_servers.corrallm = Object.fromEntries(
        Object.entries(copy.config.mcp_servers.corrallm).filter(([one]) => one !== key),
      );
      expect(entryIsCurrent(copy, apiEntry(API)), key).toBe(false);
    }
    const bad = structuredClone(good) as { origins: Record<string, unknown> };
    delete bad.origins['corrallm.url'];
    expect(entryIsCurrent(bad, apiEntry(API))).toBe(false);
  });
  it('preserves other shell settings and disables only outside names the config holds', async () => {
    const calls: AppServerOptions[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn((options: AppServerOptions) => {
      calls.push(options);
      return Promise.resolve({
        close,
        request: vi.fn(() =>
          Promise.resolve(
            calls.length === 1
              ? {
                  config: { mcp_servers: { 'corrallm-server': { url: 'http://127.0.0.1:1/mcp' } } },
                }
              : {
                  ...recorded('clean'),
                  config: {
                    ...(recorded('clean').config as object),
                    mcp_servers: {
                      corrallm: apiEntry(API),
                      'corrallm-server': { enabled: false },
                    },
                    shell_environment_policy: {
                      set: { CORRALLM_SESSION_TOKEN: '' },
                      exclude: ['AWS_*'],
                      include_only: ['PATH'],
                      inherit: 'core',
                    },
                  },
                  origins: {
                    ...(recorded('clean').origins as object),
                    'corrallm-server.enabled': 'sessionFlags',
                    'shell_environment_policy.set.CORRALLM_SESSION_TOKEN': 'sessionFlags',
                  },
                },
          ),
        ),
      } as unknown as AppServer);
    }) as unknown as typeof startAppServer;
    const ready = await prepareApi(CONTEXT, API, { start });
    expect(ready.available).toBe(true);
    expect(ready.args).toContain('shell_environment_policy.set.CORRALLM_SESSION_TOKEN=""');
    expect(ready.args).toContain('mcp_servers.corrallm-server.enabled=false');
    expect(ready.args).not.toContain('mcp_servers.corrallm-server-dev.enabled=false');
    expect(ready.args.some((arg) => arg.startsWith('shell_environment_policy.exclude='))).toBe(
      false,
    );
    expect(JSON.stringify(ready.args)).not.toContain(API.token);
    expect(ready.env.CORRALLM_SESSION_TOKEN).toBe(API.token);
    expect(calls.every((one) => one.env.CORRALLM_SESSION_TOKEN === undefined)).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('starts without a credential when effective config cannot be verified', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn(() =>
      Promise.resolve({
        close,
        request: vi.fn().mockRejectedValue(new Error(API.token)),
      } as unknown as AppServer),
    ) as unknown as typeof startAppServer;
    const ready = await prepareApi(CONTEXT, API, { start });
    expect(ready.available).toBe(false);
    expect(ready.env.CORRALLM_SESSION_TOKEN).toBeUndefined();
    expect(JSON.stringify(ready)).not.toContain(API.token);
    expect(close).toHaveBeenCalledOnce();
  });
});

it('keeps the native entry in its default local environment', () => {
  const read = recorded('clean') as {
    config: { mcp_servers: { corrallm: Record<string, unknown> } };
    origins: Record<string, unknown>;
  };
  expect(entryIsCurrent(read, apiEntry(API))).toBe(true);
  const changed = structuredClone(read);
  changed.config.mcp_servers.corrallm.environment_id = 'another-environment';
  expect(entryIsCurrent(changed, apiEntry(API))).toBe(false);
  const sourced = structuredClone(read);
  sourced.origins['corrallm.environment_id'] = 'user';
  expect(entryIsCurrent(sourced, apiEntry(API))).toBe(false);
});

it('requires each configured outside registration to be disabled by session flags', async () => {
  let nth = 0;
  const start = (() =>
    Promise.resolve({
      close: () => Promise.resolve(),
      request: () =>
        Promise.resolve(
          ++nth === 1
            ? { config: { mcp_servers: { 'corrallm-server': { enabled: true } } } }
            : {
                ...recorded('clean'),
                config: {
                  ...(recorded('clean').config as object),
                  mcp_servers: { corrallm: apiEntry(API), 'corrallm-server': { enabled: true } },
                  shell_environment_policy: { set: { CORRALLM_SESSION_TOKEN: '' } },
                },
                origins: {
                  ...(recorded('clean').origins as object),
                  'corrallm-server.enabled': 'user',
                  'shell_environment_policy.set.CORRALLM_SESSION_TOKEN': 'sessionFlags',
                },
              },
        ),
    } as unknown as AppServer)) as typeof startAppServer;
  expect((await prepareApi(CONTEXT, API, { start })).available).toBe(false);
});
