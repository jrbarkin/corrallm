import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';
const it = test.skipIf(process.platform === 'win32');
import { createCore } from './core';
import type { Core } from './core';
import { NO_DESKTOP } from './test-registry';
import type { TrustedPath } from './host';
import type { CanvasId } from '../../shared/canvas';
import { mintTrustedPath } from './host';
import { asHuman } from './gui';
import type { OutsideCaller } from './caller';
let root: string;
let core: Core;
let folder: string;
let into: string;
const pickFolder = vi.fn<() => Promise<TrustedPath | null>>();
const human = asHuman('host');
const stranger: OutsideCaller = {
  kind: 'outside',
  name: 'bot',
  token: 'fixture',
  access: 'write',
  merge: true,
  canvases: [],
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'og-')));
  const profile = path.join(root, 'profile');
  folder = path.join(root, 'project');
  into = path.join(root, 'private', 'project.token');
  await mkdir(profile, { mode: 0o700 });
  await mkdir(folder);
  await mkdir(path.dirname(into), { mode: 0o700 });
  pickFolder.mockReset();
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1' },
      distribution: 'local',
      check: true,
      sessions: { connectors: {}, environment: () => Promise.resolve({}), callers: () => true },
    },
    { ...NO_DESKTOP, pickFolder },
  );
});
afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});
it('shows a request only to the person and confines the resulting writer to its own canvas', async () => {
  const request = { version: 1 as const, op: 'connect' as const, folder, into, timeout: 60 };
  const answer = core.tokenRequest(request, { owner: 'app', url: 'http://127.0.0.1:47104/mcp' });
  let id = '';
  await vi.waitFor(async () => {
    const view = await core.call('settings.get', {}, human);
    if (!view.ok) throw new Error('No settings');
    id = view.value.orchestrators?.pending[0]?.id ?? '';
    expect(id).not.toBe('');
  });
  expect(core.presence().needs).toBe(1);
  const hidden = await core.call('settings.get', {}, stranger);
  expect(hidden.ok && 'orchestrators' in hidden.value).toBe(false);
  const worker = {
    kind: 'agent' as const,
    agent: 'worker',
    canvas: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId,
    generation: 1,
    session: 'fixture',
  };
  const agentView = await core.call('settings.get', {}, worker);
  expect(agentView.ok).toBe(false);
  expect(agentView.ok && 'orchestrators' in agentView.value).toBe(false);
  expect(
    await core.call(
      'settings.set',
      { orchestrator: { action: 'allow', id, withoutApprovals: true } },
      worker,
    ),
  ).toMatchObject({ ok: false });
  for (const action of ['allow', 'decline', 'revoke'] as const) {
    expect(
      await core.call(
        'settings.set',
        { orchestrator: { action, id, ...(action === 'allow' ? { withoutApprovals: true } : {}) } },
        stranger,
      ),
    ).toMatchObject({ ok: false });
  }
  expect(
    await core.call(
      'settings.set',
      { orchestrator: { action: 'allow', id, withoutApprovals: false } },
      human,
    ),
  ).toMatchObject({ ok: true });
  const accepted = await answer;
  expect(accepted).toMatchObject({ ok: true, op: 'connect' });
  if (!accepted.ok || accepted.op !== 'connect') throw new Error('No approval');
  const token = (await readFile(into, 'utf8')).trim();
  const caller = core.clientOf(token);
  if (caller === undefined) throw new Error('No caller');
  expect(caller).toMatchObject({ access: 'write', canvases: [accepted.canvas] });
  expect(await core.call('canvas.create', {}, caller)).toMatchObject({ ok: false });
  const canvases = await core.call('canvas.list', {}, caller);
  expect(canvases.ok && canvases.value.items).toMatchObject([
    { canvas: accepted.canvas, name: 'project', project: { path: folder } },
  ]);
  expect(
    await core.call('settings.set', { orchestrator: { action: 'revoke', id } }, human),
  ).toMatchObject({ ok: true });
  expect(core.clientOf(token)).toBeUndefined();
  const left = await core.call('canvas.list', {}, human);
  expect(left.ok && left.value.items.some((one) => one.canvas === accepted.canvas)).toBe(true);
});
it('refuses a request on a serve-only owner without raising a card', async () => {
  expect(
    await core.tokenRequest(
      { version: 1, op: 'connect', folder, into, timeout: 1 },
      { owner: 'serve', url: null },
    ),
  ).toMatchObject({
    ok: false,
    sentence: 'Open the corrallm app to approve this orchestrator request.',
  });
  const view = await core.call('settings.get', {}, human);
  expect(view.ok && view.value.orchestrators?.pending).toEqual([]);
});

it('ends access when the approved canvas chooses another project folder', async () => {
  const answer = core.tokenRequest(
    { version: 1, op: 'connect', folder, into, timeout: 60 },
    { owner: 'app', url: 'http://127.0.0.1:47104/mcp' },
  );
  let id = '';
  await vi.waitFor(async () => {
    const read = await core.call('settings.get', {}, human);
    if (!read.ok) throw new Error('No settings');
    id = read.value.orchestrators?.pending[0]?.id ?? '';
    expect(id).not.toBe('');
  });
  expect(
    await core.call(
      'settings.set',
      { orchestrator: { action: 'allow', id, withoutApprovals: false } },
      human,
    ),
  ).toMatchObject({ ok: true });
  const approved = await answer;
  if (!approved.ok || approved.op !== 'connect') throw new Error('No approval');
  const bearer = (await readFile(into, 'utf8')).trim();
  expect(core.clientOf(bearer)).toBeDefined();
  const other = path.join(root, 'other-project');
  await mkdir(other);
  pickFolder.mockResolvedValue(mintTrustedPath(other));
  expect(await core.call('project.choose', { canvas: approved.canvas }, asHuman(1))).toMatchObject({
    ok: true,
  });
  expect(core.clientOf(bearer)).toBeUndefined();
});
