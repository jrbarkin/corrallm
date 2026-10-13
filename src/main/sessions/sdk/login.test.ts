import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authStatus, onSubscription } from './login';
import type { AuthStatus } from './login';

/*
 * What `claude auth status --json` reported (Claude Code 2.1.296, its email and organization taken
 * out) for each way of logging in, and what corrallm makes of it.
 */
const CLAUDE_AI: AuthStatus = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
};
const API_KEY: AuthStatus = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' };
const HELPER: AuthStatus = {
  loggedIn: true,
  authMethod: 'api_key_helper',
  apiProvider: 'firstParty',
};
const SETUP_TOKEN: AuthStatus = {
  loggedIn: true,
  authMethod: 'oauth_token',
  apiProvider: 'firstParty',
};
const BEDROCK: AuthStatus = { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' };
const VERTEX: AuthStatus = { loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' };
const LOGGED_OUT: AuthStatus = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };

describe('onSubscription', () => {
  it.each([
    ['a claude.ai login', CLAUDE_AI, {}],
    ['a token from claude setup-token', SETUP_TOKEN, { CLAUDE_CODE_OAUTH_TOKEN: 'set' }],
    [
      'a plan, whatever the method is called',
      { ...API_KEY, authMethod: 'subscription', subscriptionType: 'pro' },
      {},
    ],
  ])('is true for %s', (_name, status, env) => {
    expect(onSubscription(status, env)).toBe(true);
  });

  it.each([
    ['an API key', API_KEY, {}],
    ['an apiKeyHelper', HELPER, {}],
    ['Bedrock', BEDROCK, {}],
    ['Vertex', VERTEX, {}],
    ['a gateway', { ...CLAUDE_AI, apiProvider: 'gateway' }, {}],
    // The CLI sends the token, though it reports the stored login with a custom base URL.
    ['ANTHROPIC_AUTH_TOKEN', CLAUDE_AI, { ANTHROPIC_AUTH_TOKEN: 'set' }],
    ['no login at all (the CLI says so itself)', LOGGED_OUT, {}],
  ])('is false for %s', (_name, status, env) => {
    expect(onSubscription(status, env)).toBe(false);
  });
});

describe('authStatus', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corrallm-login-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake `claude` (run with node) whose body is `code`; returns its path. */
  const fake = async (code: string) => {
    const file = path.join(dir, 'claude.mjs');
    await writeFile(file, code);
    return file;
  };
  const env = () => ({ PATH: process.env.PATH ?? '', WHO: 'agents' });

  it('asks the CLI, in the project folder with the agents’ environment', async () => {
    const claude = await fake(
      `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), who: process.env.WHO }));`,
    );
    const status = (await authStatus(claude, { cwd: dir, env: env() })) as Record<string, unknown>;
    expect(status).toEqual({
      args: ['auth', 'status', '--json'],
      cwd: expect.stringContaining(path.basename(dir)) as unknown,
      who: 'agents',
    });
  });

  it('reads the status a logged-out CLI reports with its exit code', async () => {
    const claude = await fake(
      `process.stdout.write(${JSON.stringify(JSON.stringify(LOGGED_OUT))}); process.exit(1);`,
    );
    expect(await authStatus(claude, { cwd: dir, env: env() })).toEqual(LOGGED_OUT);
  });

  it('rejects, saying why, when the CLI does not answer in JSON', async () => {
    const claude = await fake(`console.error('error: unknown command auth'); process.exit(1);`);
    await expect(authStatus(claude, { cwd: dir, env: env() })).rejects.toThrow(
      'error: unknown command auth',
    );
  });

  it('rejects when the CLI takes too long', async () => {
    const claude = await fake(`setTimeout(() => {}, 60_000);`);
    await expect(authStatus(claude, { cwd: dir, env: env(), timeoutMs: 300 })).rejects.toThrow(
      /too long/,
    );
  });
});
