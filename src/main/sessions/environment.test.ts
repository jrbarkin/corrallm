import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentEnvironment, loginShellEnvironment, parseEnvironment } from './environment';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-env-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in for the user's shell: its "profile" prints a greeting and exports a variable. */
async function fakeShell(profile: string): Promise<string> {
  const shell = path.join(dir, 'shell');
  // Called as `shell -ilc <command>`: runs the profile, then the command.
  await writeFile(shell, `#!/bin/sh\n${profile}\nshift\nexec /bin/sh -c "$1"\n`);
  await chmod(shell, 0o755);
  return shell;
}

describe('parseEnvironment', () => {
  it('reads the variables between the markers, whatever the shell printed around them', () => {
    const output = 'Welcome back!\n__CORRALLM_ENV__A=1\0B=x=y\0C=two\nlines\0__CORRALLM_ENV__bye';
    expect(parseEnvironment(output)).toEqual({ A: '1', B: 'x=y', C: 'two\nlines' });
    expect(parseEnvironment('no markers')).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('loginShellEnvironment', () => {
  it('is the environment the user’s login shell sets up', async () => {
    const shell = await fakeShell('echo "Welcome!"\nexport FROM_PROFILE=yes');
    const env = await loginShellEnvironment({
      env: { SHELL: shell, PATH: '/usr/bin:/bin', HOME: dir },
    });
    expect(env.FROM_PROFILE).toBe('yes');
    expect(env.HOME).toBe(dir);
  });

  it('preserves supplied login and fake configuration through the POSIX login shell', async () => {
    const supplied = {
      SHELL: '/bin/sh',
      HOME: dir,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ANTHROPIC_API_KEY: 'fake-api-key',
      CLAUDE_CONFIG_DIR: dir,
      FAKE_CODEX_DEVELOPER_INSTRUCTIONS: 'Native project guidance',
    };
    const read = await loginShellEnvironment({ env: supplied, platform: 'linux' });
    for (const name of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
      'FAKE_CODEX_DEVELOPER_INSTRUCTIONS',
    ]) {
      expect(read[name], name).toBe(supplied[name as keyof typeof supplied]);
    }
  });

  it('falls back to the app’s own environment if the shell fails or takes too long', async () => {
    const base = { SHELL: await fakeShell('exit 3'), PATH: '/usr/bin:/bin' };
    expect(await loginShellEnvironment({ env: base })).toEqual(base);
    const slow = { ...base, SHELL: await fakeShell('sleep 5') };
    expect(await loginShellEnvironment({ env: slow, timeoutMs: 100 })).toEqual(slow);
  });
});

describe('loginShellEnvironment on Windows', () => {
  it('is the app’s own environment: there is no login shell to ask', async () => {
    const env = { Path: 'C:\\Windows', SHELL: '/nonexistent' };
    expect(await loginShellEnvironment({ env, platform: 'win32' })).toEqual(env);
  });
});

describe('agentEnvironment', () => {
  it('leaves out what the app was started from: a Claude Code session, a terminal, Electron', () => {
    const env = agentEnvironment({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: '42',
      ITERM_SESSION_ID: 'w0t0p0',
      TERM_PROGRAM: 'iTerm.app',
      TERM_SESSION_ID: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
      CORRALLM_HIDE_WINDOW: '1',
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
  });
});
