import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { opsFor } from '../../shared/api/registry';
import { PARTIES, SURFACE } from '../../shared/api/surface';
import { answerUnowned, createCore } from './core';
import type { Core } from './core';
import { lockProfile, ProfileLocked } from './lock';
import { keepCanvases } from './store/test-store';
import { NO_DESKTOP } from './test-registry';
import type { TokenAnswer, TokenRequest } from './token-socket';

/*
 * What `corrallm token new|renew|revoke` asks (Build Plan B30), as the profile's owner answers it:
 * the app's core or `corrallm serve`, composed (`Core.tokenRequest`), or, with no owner, the
 * profile's own stores under core.lock (`answerUnowned`), as `serve --new-token` writes them. A
 * token reaches only canvases whose files canvas memory keeps, with their folders, and works (or
 * stops working) at once.
 */

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let dir: string;
let profile: string;
let file: string;
let core: Core | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-token-requests-'));
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
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(dir, { recursive: true, force: true });
});

function newToken(
  canvases = [file],
  access: Extract<TokenRequest, { op: 'new' }>['access'] = 'read',
): TokenRequest {
  return { version: 1, op: 'new', name: 'bot', hours: 2, access, canvases };
}

async function start(): Promise<Core> {
  core = await createCore(
    { profile, app: { name: 'corrallm', version: '1' }, check: true, distribution: 'local' },
    NO_DESKTOP,
  );
  return core;
}

function tokenOf(answer: TokenAnswer): string {
  if (!answer.ok || answer.op === 'revoke') throw new Error(`No token: ${JSON.stringify(answer)}`);
  return answer.token;
}

describe('a token request the core that owns the profile answers', () => {
  it('makes a token for the canvases its files hold, working at once, keeping only its hash', async () => {
    const owner = await start();
    const url = 'http://127.0.0.1:47000/mcp';
    const answer = await owner.tokenRequest(newToken([file, file]), { owner: 'serve', url });
    expect(answer).toMatchObject({
      ok: true,
      owner: 'serve',
      op: 'new',
      name: 'bot',
      access: 'read',
      canvases: [{ id: CANVAS, file }],
      url,
    });
    const token = tokenOf(answer);
    expect(owner.clientOf(token)).toMatchObject({
      name: 'bot',
      access: 'read',
      canvases: [CANVAS],
    });
    const kept = await readFile(path.join(profile, 'tokens.json'), 'utf8');
    expect(kept).not.toContain(token);
    expect(kept).toContain(sha256(token));
  });

  it('refuses a file corrallm doesn’t keep that canvas in, making nothing', async () => {
    const owner = await start();
    const copy = path.join(dir, 'copy.corral');
    await copyFile(file, copy);
    const answer = await owner.tokenRequest(newToken([file, copy]), { owner: 'app', url: null });
    expect(answer).toEqual({
      ok: false,
      sentence: expect.stringContaining(
        'copy.corral is a copy of a canvas corrallm keeps',
      ) as string,
    });
    expect(existsSync(path.join(profile, 'tokens.json'))).toBe(false);
  });

  it('makes and renews a token that writes but can’t merge (--no-merge), keeping that access', async () => {
    const owner = await start();
    const host = { owner: 'serve', url: null } as const;
    const made = await owner.tokenRequest(newToken([file], 'write-no-merge'), host);
    expect(made).toMatchObject({ ok: true, op: 'new', access: 'write-no-merge' });
    expect(owner.clientOf(tokenOf(made))).toMatchObject({ access: 'write', merge: false });
    const renewal = await owner.tokenRequest(
      { version: 1, op: 'renew', name: 'bot', hours: 3 },
      host,
    );
    expect(renewal).toMatchObject({ ok: true, op: 'renew', access: 'write-no-merge' });
    expect(owner.clientOf(tokenOf(renewal))).toMatchObject({ access: 'write', merge: false });
  });

  it('renews and revokes a token by name at once, the old value refused from then on', async () => {
    const owner = await start();
    const host = { owner: 'app', url: null } as const;
    const old = tokenOf(await owner.tokenRequest(newToken(), host));
    const renewal = await owner.tokenRequest(
      { version: 1, op: 'renew', name: 'bot', hours: 12 },
      host,
    );
    expect(renewal).toMatchObject({ ok: true, owner: 'app', op: 'renew', access: 'read' });
    const renewed = tokenOf(renewal);
    expect(owner.clientOf(old)).toBeUndefined();
    expect(owner.tokens.stale(old)).toBe(true);
    expect(owner.clientOf(renewed)).toMatchObject({ canvases: [CANVAS] });

    expect(await owner.tokenRequest({ version: 1, op: 'revoke', name: 'bot' }, host)).toEqual({
      ok: true,
      owner: 'app',
      op: 'revoke',
      name: 'bot',
    });
    expect(owner.clientOf(renewed)).toBeUndefined();
    for (const op of ['renew', 'revoke'] as const) {
      const again = await owner.tokenRequest(
        op === 'renew'
          ? { version: 1, op, name: 'bot', hours: 1 }
          : { version: 1, op, name: 'bot' },
        host,
      );
      expect(again).toEqual({
        ok: false,
        sentence: expect.stringContaining('No live token is named “bot”') as string,
      });
    }
  });
});

describe('a token request with no owner', () => {
  it('refuses an unsafe profile before taking its lock or changing its token store', async () => {
    await chmod(profile, 0o777);
    await expect(answerUnowned(profile, newToken())).rejects.toThrow(/folder/);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    expect(existsSync(path.join(profile, 'tokens.json'))).toBe(false);
  });

  it('is answered under core.lock, which it lets go, as serve --new-token writes tokens', async () => {
    const answer = await answerUnowned(profile, newToken());
    expect(answer).toMatchObject({ ok: true, owner: 'none', op: 'new', url: null });
    const token = tokenOf(answer);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    // The owner that starts next serves it.
    const owner = await start();
    expect(owner.clientOf(token)).toMatchObject({ name: 'bot' });
  });

  it('makes and renews a --no-merge token as one, which the owner that starts next serves as one', async () => {
    const made = await answerUnowned(profile, newToken([file], 'write-no-merge'));
    expect(made).toMatchObject({ ok: true, owner: 'none', access: 'write-no-merge' });
    const renewal = await answerUnowned(profile, {
      version: 1,
      op: 'renew',
      name: 'bot',
      hours: 2,
    });
    expect(renewal).toMatchObject({ ok: true, op: 'renew', access: 'write-no-merge' });
    const owner = await start();
    expect(owner.clientOf(tokenOf(renewal))).toMatchObject({ access: 'write', merge: false });
  });

  it('names the URL the profile’s server keeps, where serve will listen', async () => {
    await writeFile(
      path.join(profile, 'settings.json'),
      JSON.stringify({ version: 2, consents: {}, api: { port: 47123 } }),
    );
    expect(await answerUnowned(profile, newToken())).toMatchObject({
      url: 'http://127.0.0.1:47123/mcp',
    });
  });

  it('renews and revokes by name, and refuses a canvas corrallm doesn’t keep', async () => {
    const old = tokenOf(await answerUnowned(profile, newToken()));
    const renewed = tokenOf(
      await answerUnowned(profile, { version: 1, op: 'renew', name: 'bot', hours: 3 }),
    );
    expect(await answerUnowned(profile, { version: 1, op: 'revoke', name: 'other' })).toMatchObject(
      { ok: false },
    );
    const owner = await start();
    expect(owner.clientOf(old)).toBeUndefined();
    expect(owner.clientOf(renewed)).toMatchObject({ name: 'bot' });
    await owner.close();
    core = undefined;

    expect(await answerUnowned(profile, { version: 1, op: 'revoke', name: 'bot' })).toMatchObject({
      ok: true,
      op: 'revoke',
    });
    expect(await answerUnowned(profile, newToken([path.join(dir, 'none.corral')]))).toMatchObject({
      ok: false,
      sentence: expect.stringContaining('none.corral') as string,
    });
  });

  it('refuses, with who holds it, while another process owns the profile', async () => {
    const held = await lockProfile(profile, 'serve');
    try {
      await expect(answerUnowned(profile, newToken())).rejects.toBeInstanceOf(ProfileLocked);
    } finally {
      held.release();
    }
  });

  it('makes no profile that isn’t there', async () => {
    const none = path.join(dir, 'no-profile');
    expect(await answerUnowned(none, newToken())).toEqual({
      ok: false,
      sentence: expect.stringContaining(none) as string,
    });
    expect(existsSync(none)).toBe(false);
  });
});

describe('the token socket, never MCP', () => {
  it('is the only way to make, renew or revoke a token: no operation a token can call does', async () => {
    const tokenParties = PARTIES.filter((party) => party !== 'you');
    for (const party of tokenParties) {
      expect(opsFor(SURFACE, party).filter((name) => /^tokens?\b/i.test(name))).toEqual([]);
    }
    // Nor does the composed core take a request for one from a token: it has no such operation.
    const owner = await start();
    expect(Object.keys(owner.ops).filter((name) => /token/i.test(name))).toEqual([]);
  });
});
