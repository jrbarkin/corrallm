import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { serveTokenSocket } from '../core/token-socket';
import type { TokenRequest, TokenSocket } from '../core/token-socket';
import { keepCanvases } from '../core/store/test-store';
import type { TokenCommand } from './args';
import { byFileLines, tokenCommand } from './token';
import type { TokenIO } from './token';

/*
 * What `corrallm token` says and refuses (Build Plan B30), called directly with nothing owning the
 * profile (it answers under core.lock itself), the login shell's environment given, and fake
 * executables standing for the installed CLIs: where each registration goes, a headers helper's
 * command resolving, and no token made inside a corrallm agent.
 */

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
let dir: string;
let profile: string;
let file: string;
let said: string;
let owner: TokenSocket;
/** Every request the fake owner of the profile's token socket was asked. */
let asked: TokenRequest[];
const URL = 'http://127.0.0.1:4100/mcp';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ct-'));
  profile = path.join(dir, 'profile');
  await mkdir(profile, { mode: 0o700 });
  const project = path.join(dir, 'project');
  await mkdir(project);
  file = path.join(dir, 'm1.corral');
  await writeFile(
    file,
    JSON.stringify({ format: 'corrallm', version: 2, id: CANVAS, nodes: [], links: [] }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  said = '';
  asked = [];
  owner = await serveTokenSocket({
    profile,
    answer: (request) => {
      asked.push(request);
      return Promise.resolve(
        request.op === 'revoke'
          ? { ok: true, owner: 'serve', op: 'revoke', name: request.name }
          : {
              ok: true,
              owner: 'serve',
              op: request.op,
              token: 'A'.repeat(43),
              name: request.name,
              access: 'write',
              expires: Date.now() + 3600_000,
              canvases: [{ id: CANVAS as CanvasId, file }],
              url: URL,
            },
      );
    },
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await owner.close();
  await rm(dir, { recursive: true, force: true });
});

/** An executable file at `where`. */
async function executable(where: string): Promise<string> {
  await mkdir(path.dirname(where), { recursive: true });
  await writeFile(where, '#!/bin/sh\n');
  await chmod(where, 0o755);
  return realpath(where);
}

function io(env: Record<string, string>, extra: Partial<TokenIO> = {}): TokenIO {
  return {
    env: { ...env, HOME: dir },
    cwd: dir,
    stderr: {
      isTTY: true,
      write: (chunk: string | Uint8Array) => {
        said += chunk.toString();
        return true;
      },
    },
    stdout: { write: () => undefined },
    ...extra,
  };
}

function command(over: { into?: string } = {}): TokenCommand {
  return {
    command: 'token',
    action: 'new',
    name: 'bot',
    hours: 1,
    access: 'write',
    canvases: [file],
    profile,
    ...over,
  };
}

/** The environment of a login shell with these fake CLIs installed and this PATH. */
async function login(searchPath: string): Promise<Record<string, string>> {
  const paths = JSON.stringify({
    codex: await executable(path.join(dir, 'tools', 'codex')),
    'claude-code': await executable(path.join(dir, 'tools', 'claude')),
  });
  // Finding a CLI reads this process's own CORRALLM_AGENT_PATHS, so the fakes are given there too:
  // a machine with no real CLIs installed (CI) finds them the same.
  vi.stubEnv('CORRALLM_AGENT_PATHS', paths);
  return { PATH: searchPath, CORRALLM_AGENT_PATHS: paths };
}

describe.skipIf(process.platform === 'win32')('corrallm token in a corrallm agent', () => {
  it.each<[string, () => TokenCommand]>([
    ['new', () => command()],
    ['renew', () => ({ command: 'token', action: 'renew', name: 'bot', hours: 1, profile })],
    ['revoke', () => ({ command: 'token', action: 'revoke', name: 'bot', profile })],
  ])('refuses %s: one sentence, nothing made', async (_action, make) => {
    const code = await tokenCommand(make(), io({ CORRALLM_AGENT_SESSION: '1' }));
    expect(code).toBe(1);
    expect(said).toBe(
      'corrallm token: it doesn’t run inside a corrallm agent: make tokens yourself, in your own terminal.\n',
    );
    expect(asked).toEqual([]);
    expect(existsSync(path.join(profile, 'tokens.json'))).toBe(false);
  });

  it('makes a token as before without the marker', async () => {
    const code = await tokenCommand(command(), io({}, { loginEnv: await login(dir) }));
    expect(said).toMatch(/a new token for "bot"/);
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
  });
});

describe.skipIf(process.platform === 'win32')('what corrallm token says to register', () => {
  it('puts Codex in the orchestrator’s folder as text by the token’s file, never as a command, and says no client must start again', async () => {
    const into = path.join(dir, 'orchestrator.token');
    const code = await tokenCommand(command({ into }), io({}, { loginEnv: await login(dir) }));
    expect(code).toBe(0);
    expect(said).not.toMatch(/codex mcp add/);
    expect(said).toContain(
      'Codex: in your orchestrator’s folder, add this to .codex/config.toml (corrallm doesn’t write it):',
    );
    expect(said).toContain('[mcp_servers.corrallm-server]');
    expect(said).toContain(`http_headers_helper = "corrallm token header --from \\"${into}\\""`);
    expect(said).not.toContain('bearer_token_env_var');
    // Both helpers run again after a renewal (Codex's recorded in B30 E1): nothing must start again.
    expect(said).toContain('claude mcp add-json corrallm-server');
    expect(said).not.toContain('must start again');
    expect(said).toContain('a renewal into the same file then needs no restart');
  });

  it('says a by-file client must start again, and claims no restart-free renewal, unless every one renews', () => {
    const renews = { name: 'R', text: 'r', in: '.r/config.toml', renews: true };
    const stays = { name: 'X', text: 'x', in: '.x/config.toml', renews: false };
    const all = byFileLines([renews]).join('\n');
    expect(all).toContain('needs no restart');
    expect(all).not.toContain('must start again');
    const some = byFileLines([renews, stays]).join('\n');
    expect(some).toContain('X must start again after a renewal');
    expect(some).not.toContain('needs no restart');
    expect(some).not.toContain('R must start again');
    expect(byFileLines([stays]).join('\n')).not.toContain('needs no restart');
  });

  it('tells you to install the command when no corrallm is on the login PATH', async () => {
    await tokenCommand(
      command({ into: path.join(dir, 't') }),
      io({}, { loginEnv: await login(dir) }),
    );
    expect(said).toContain(
      'Your PATH has no corrallm command, so this helper can’t run: install it from a packaged corrallm’s Settings first.',
    );
  });

  it('names another program on the PATH that would run as the helper', async () => {
    const launcher = await executable(path.join(dir, 'app', 'bin', 'corrallm'));
    const other = await executable(path.join(dir, 'other', 'corrallm'));
    await tokenCommand(
      command({ into: path.join(dir, 't') }),
      io({}, { loginEnv: await login(path.dirname(other)), launcher }),
    );
    expect(said).toContain(`\`corrallm\` on your PATH is another program (`);
    expect(said).toContain('so this helper would run that');
  });

  it('says nothing more when this command’s own link is first on the PATH', async () => {
    const launcher = await executable(path.join(dir, 'app', 'bin', 'corrallm'));
    await mkdir(path.join(dir, 'bin'));
    await symlink(launcher, path.join(dir, 'bin', 'corrallm'));
    await tokenCommand(
      command({ into: path.join(dir, 't') }),
      io({}, { loginEnv: await login(path.join(dir, 'bin')), launcher }),
    );
    expect(said).toContain('claude mcp add-json');
    expect(said).not.toContain('this helper');
  });
});
