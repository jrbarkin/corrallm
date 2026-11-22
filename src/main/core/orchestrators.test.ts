import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';
const it = test.skipIf(process.platform === 'win32');
import type { CanvasId } from '../../shared/canvas';
import { TokenStore } from './tokens';
import { Orchestrators } from './orchestrators';

let root: string;
let service: Orchestrators;
let tokens: TokenStore;
let folder: string;
let into: string;
const canvas = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;
const trusted = vi.fn(() => Promise.resolve(canvas));
const changed = vi.fn();
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'orchestrator-')));
  folder = path.join(root, 'project');
  into = path.join(root, 'private', 'project.token');
  await mkdir(folder);
  await mkdir(path.dirname(into), { mode: 0o700 });
  tokens = new TokenStore(path.join(root, 'tokens.json'));
  await tokens.load();
  trusted.mockClear();
  changed.mockClear();
  service = new Orchestrators({
    file: path.join(root, 'orchestrators.json'),
    tokens,
    trusted,
    changed,
    home: root,
  });
  await service.load();
});
afterEach(async () => {
  await service.close();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
async function pending() {
  const answer = service.request({ folder, into, timeout: 60 });
  await vi.waitFor(() => {
    expect(service.view().pending).toHaveLength(1);
  });
  const request = service.view().pending[0];
  if (request === undefined) throw new Error('No request');
  return { answer, request };
}
it('waits for a human answer, keeps only hashes and grants exactly its canvas', async () => {
  const { answer, request } = await pending();
  expect(trusted).not.toHaveBeenCalled();
  await service.answer(request.id, 'allow', false);
  expect(await answer).toMatchObject({ ok: true, canvas, into });
  expect(trusted).toHaveBeenCalledWith(expect.any(String), folder, undefined);
  const token = (await readFile(into, 'utf8')).trim();
  expect((await stat(into)).mode & 0o777).toBe(0o600);
  expect(tokens.clientOf(token)).toMatchObject({ access: 'write', canvases: [canvas] });
  expect(JSON.stringify(service.view())).not.toContain(token);
  expect(await readFile(path.join(root, 'orchestrators.json'), 'utf8')).not.toContain(token);
  expect(await readFile(path.join(root, 'tokens.json'), 'utf8')).not.toContain(token);
});
it('rechecks the approved directory identity before trusting it', async () => {
  const { answer, request } = await pending();
  await rename(folder, `${folder}-old`);
  await mkdir(folder);
  await expect(service.answer(request.id, 'allow', false)).rejects.toThrow();
  expect(await answer).toMatchObject({ ok: false });
  expect(trusted).not.toHaveBeenCalled();
});
it('refuses a link substituted for the directory shown on the card', async () => {
  const { answer, request } = await pending();
  await rename(folder, `${folder}-old`);
  await symlink(`${folder}-old`, folder);
  await expect(service.answer(request.id, 'allow', false)).rejects.toThrow();
  expect(await answer).toMatchObject({ ok: false });
  expect(trusted).not.toHaveBeenCalled();
});
it('refuses home, root, system directories and credentials inside the granted folder', async () => {
  for (const target of [root, '/', '/usr', path.join(root, 'missing')]) {
    expect(await service.request({ folder: target, into, timeout: 60 })).toMatchObject({
      ok: false,
    });
  }
  expect(
    await service.request({ folder, into: path.join(folder, 'token'), timeout: 60 }),
  ).toMatchObject({ ok: false });
  await symlink(folder, path.join(root, 'alias'));
  expect(
    await service.request({ folder, into: path.join(root, 'alias', 'token'), timeout: 60 }),
  ).toMatchObject({ ok: false });
  expect(service.view().pending).toHaveLength(0);
});
it('shares identical pending requests and bounds different requests', async () => {
  const { answer, request } = await pending();
  const same = service.request({ folder, into, timeout: 60 });
  await vi.waitFor(() => {
    expect(changed).toHaveBeenCalledOnce();
  });
  await service.answer(request.id, 'decline', false);
  expect(await answer).toMatchObject({ ok: false });
  expect(await same).toMatchObject({ ok: false });
  const waiting: Promise<unknown>[] = [];
  for (let n = 0; n < 8; n++) {
    const next = path.join(root, `project-${String(n)}`);
    await mkdir(next);
    waiting.push(
      service.request({
        folder: next,
        into: path.join(root, 'private', `${String(n)}.token`),
        timeout: 60,
      }),
    );
    await vi.waitFor(() => {
      expect(service.view().pending).toHaveLength(n + 1);
    });
  }
  expect(await service.request({ folder, into, timeout: 60 })).toMatchObject({ ok: false });
  await service.close();
  await Promise.all(waiting);
});
it('rotates a live grant and immediately refuses it after revocation, without deleting its canvas', async () => {
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', true);
  await answer;
  const first = (await readFile(into, 'utf8')).trim();
  await service.renew();
  const second = (await readFile(into, 'utf8')).trim();
  expect(second).not.toBe(first);
  expect(tokens.clientOf(first)).toBeUndefined();
  expect(tokens.clientOf(second)).toBeDefined();
  const grant = service.view().approved[0];
  if (grant === undefined) throw new Error('No grant');
  await service.revoke(grant.id);
  expect(tokens.clientOf(second)).toBeUndefined();
  await service.renew();
  expect((await readFile(into, 'utf8')).trim()).toBe(second);
  expect(service.view().approved).toHaveLength(0);
  expect(trusted).toHaveBeenCalledOnce();
});

it('reuses a live approval and its canvas without asking a second time', async () => {
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', false);
  await answer;
  expect(await service.request({ folder, into, timeout: 60 })).toMatchObject({ ok: true, canvas });
  expect(service.view().pending).toEqual([]);
  expect(trusted).toHaveBeenCalledOnce();
});
it('keeps a pre-existing file intact and raises no request for it', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(into, 'my private notes', { mode: 0o600 });
  expect(await service.request({ folder, into, timeout: 60 })).toMatchObject({ ok: false });
  expect(service.view().pending).toEqual([]);
  expect(await readFile(into, 'utf8')).toBe('my private notes');
});
it('ends a request when its socket closes, and refuses its later answer', async () => {
  const controller = new AbortController();
  const answer = service.request({ folder, into, timeout: 60 }, controller.signal);
  await vi.waitFor(() => {
    expect(service.view().pending).toHaveLength(1);
  });
  const id = service.view().pending[0]?.id ?? '';
  controller.abort();
  expect(await answer).toMatchObject({ ok: false });
  await expect(service.answer(id, 'allow', false)).rejects.toThrow();
  expect(trusted).not.toHaveBeenCalled();
});

it('recovers a rotation interrupted before its file was replaced', async () => {
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', false);
  await answer;
  const first = (await readFile(into, 'utf8')).trim();
  const caller = tokens.clientOf(first);
  if (caller === undefined) throw new Error('No grant credential');
  await tokens.renew(caller.name); // The owner stopped before installing this new value.
  await service.renew(false);
  const current = (await readFile(into, 'utf8')).trim();
  expect(current).not.toBe(first);
  expect(tokens.clientOf(current)).toBeDefined();
});

it('recovers a rotation whose file landed before its file hash was kept', async () => {
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', false);
  await answer;
  const first = (await readFile(into, 'utf8')).trim();
  const caller = tokens.clientOf(first);
  if (caller === undefined) throw new Error('No credential');
  const replacement = await tokens.renew(caller.name);
  if (replacement === undefined) throw new Error('No replacement');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(into, `${replacement}\n`);
  await service.renew(false);
  await service.renew();
  expect(tokens.clientOf((await readFile(into, 'utf8')).trim())).toBeDefined();
});

it('keeps an approval inactive until its credential is durable', async () => {
  const original = tokens.create.bind(tokens);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let bearer = '';
  vi.spyOn(tokens, 'create').mockImplementation(async (input) => {
    bearer = await original(input);
    await gate;
    return bearer;
  });
  const { answer, request } = await pending();
  const allowing = service.answer(request.id, 'allow', false);
  try {
    await vi.waitFor(() => {
      expect(bearer).not.toBe('');
    });
    const caller = tokens.clientOf(bearer);
    if (caller === undefined) throw new Error('No staged bearer');
    expect(service.canvas(caller.name)).toBeUndefined();
    expect(service.view().approved).toEqual([]);
  } finally {
    release();
  }
  await allowing;
  await answer;
  expect(service.view().approved).toHaveLength(1);
});
it('restores an approved folder and stops its credential durably on revocation', async () => {
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', false);
  await answer;
  await service.close();
  service = new Orchestrators({
    file: path.join(root, 'orchestrators.json'),
    tokens,
    trusted,
    changed,
    home: root,
  });
  await service.load();
  const restored = service.view().approved[0];
  if (restored === undefined) throw new Error('No restored grant');
  expect(restored).toMatchObject({ folder, canvas, withoutApprovals: false });
  await service.revoke(restored.id);
  const bearer = (await readFile(into, 'utf8')).trim();
  expect(tokens.clientOf(bearer)).toBeUndefined();
  expect(JSON.parse(await readFile(path.join(root, 'orchestrators.json'), 'utf8'))).toMatchObject({
    grants: [{ revoked: expect.any(Number) as unknown }],
  });
});

it('keeps renewing other approvals when one credential file becomes unavailable', async () => {
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', false);
  await answer;
  const first = (await readFile(into, 'utf8')).trim();
  const secondFolder = path.join(root, 'second');
  const secondFile = path.join(root, 'private', 'second.token');
  await mkdir(secondFolder);
  const second = service.request({ folder: secondFolder, into: secondFile, timeout: 60 });
  await vi.waitFor(() => {
    expect(service.view().pending).toHaveLength(1);
  });
  const next = service.view().pending[0];
  if (next === undefined) throw new Error('No second request');
  await service.answer(next.id, 'allow', false);
  await second;
  const before = (await readFile(secondFile, 'utf8')).trim();
  const { chmod } = await import('node:fs/promises');
  await chmod(into, 0o644);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await service.renew();
    expect(tokens.clientOf(first)).toBeUndefined();
    const after = (await readFile(secondFile, 'utf8')).trim();
    expect(after).not.toBe(before);
    expect(tokens.clientOf(after)).toBeDefined();
  } finally {
    error.mockRestore();
  }
});

it('retains bounded revoked history while allowing the next human approval', async () => {
  await service.close();
  const { randomUUID } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(root, 'orchestrators.json'),
    JSON.stringify({
      version: 1,
      grants: Array.from({ length: 256 }, (_, n) => ({
        id: randomUUID(),
        canvas,
        folder: path.join(root, `old-${String(n)}`),
        into,
        created: n,
        lastUsed: n,
        revoked: n,
        withoutApprovals: false,
        identity: 'old',
      })),
    }),
    { mode: 0o600 },
  );
  service = new Orchestrators({
    file: path.join(root, 'orchestrators.json'),
    tokens,
    trusted,
    changed,
    home: root,
  });
  await service.load();
  const { answer, request } = await pending();
  await service.answer(request.id, 'allow', false);
  expect(await answer).toMatchObject({ ok: true });
  const disk = JSON.parse(await readFile(path.join(root, 'orchestrators.json'), 'utf8')) as {
    grants: unknown[];
  };
  expect(disk.grants).toHaveLength(256);
  expect(service.view().approved).toHaveLength(1);
});
