import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasId } from '../../shared/canvas';
import { EXAMPLES } from '../../shared/examples';
import { templateInfo } from '../../shared/templates';
import { CATALOG } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import { asHuman } from './gui';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { liveRunOf, expectRestorable } from './engine/run/test-restore';
import { legacyDirectories } from './workspaces/test-directories';

const CANVAS = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
const S1 = 'Waiting has no agent chosen yet. Choose one in its settings to run this work.';
let profile: string;
let core: Core;
let fake: FakeConnector;
const queue = [{ id: 'step', action: 'future-action' }];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-unchosen-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 3,
      id: CANVAS,
      nodes: [
        { id: 'a', kind: 'agent', label: 'Waiting', position: { x: 0, y: 0 }, queue },
        {
          id: 'b',
          kind: 'agent',
          label: 'Known',
          position: { x: 300, y: 0 },
          connection: 'claude-code.sdk',
        },
        { id: 'f', kind: 'group', label: 'Frame', position: { x: 600, y: 0 } },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  fake = new FakeConnector({ mode: 'manual' });
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: 'test' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        connectors: { 'claude-code.sdk': fake, 'claude-code.terminal': fake },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  const opened = await core.engines.open(CANVAS);
  liveRunOf(opened.run, opened.catalog, Date.now);
  opened.run.update(core.engines.canvas(CANVAS)?.document.nodes ?? []);
});
afterEach(expectRestorable);
afterEach(async () => {
  await core.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
const call = (op: string, args: object = {}) =>
  core.call(op as never, { canvas: CANVAS, ...args }, CALLERS.you);

describe('an agent with no endpoint chosen', () => {
  it('holds messages and view opens without starting a session, and reports no endpoint', async () => {
    expect(await call('message', { to: 'a', body: 'Wait for a choice' })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(async () => {
      expect(await call('needs')).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ agent: 'a', title: `Waiting can’t start: ${S1}` })],
        },
      });
    });
    expect(await call('session.open', { agent: 'a' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable', sentence: S1 },
    });
    expect(await call('agents')).toMatchObject({
      ok: true,
      value: {
        agents: [
          expect.objectContaining({ id: 'a', adapter: null, connection: null }),
          expect.anything(),
        ],
      },
    });
    expect(fake.started).toEqual([]);
  });
  it('holds a run step with its own explanation and starts no native session', async () => {
    expect(await call('run.start')).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      const needs = await call('needs');
      expect(JSON.stringify(needs)).toContain(S1);
    });
    expect(fake.started).toEqual([]);
  });
  it('keeps an unchosen view subscribed, then starts only after your setType choice', async () => {
    const request = { topic: 'session', canvas: CANVAS, agent: 'a' };
    expect(await core.call('topics.subscribe', request, asHuman(1))).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(core.engines.canvas(CANVAS)?.engine.sessions.of('a').entries).toContainEqual(
        expect.objectContaining({ kind: 'notice', text: S1 }),
      );
    });
    expect(fake.started).toEqual([]);
    expect(
      await call('agent.setType', {
        agent: 'a',
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
      }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(fake.started).toHaveLength(1);
    });
    expect(await core.call('topics.unsubscribe', request, asHuman(1))).toMatchObject({ ok: true });
  });
  it('requires a known endpoint before changing only a connection or its fallback', async () => {
    const before = core.engines.canvas(CANVAS)?.document;
    expect(
      await call('agent.setConnection', { agent: 'a', connection: 'claude-code.sdk' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await call('agent.setFallback', { agent: 'a', fallback: null })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(core.engines.canvas(CANVAS)?.document).toBe(before);
    expect(fake.started).toEqual([]);
  });
  it('requires every role for template creation too, without creating a canvas on refusal', async () => {
    const example = EXAMPLES[0];
    if (!example) throw new Error('No template');
    const info = templateInfo(example, CATALOG);
    const before = await core.call('canvas.list', {}, CALLERS.you);
    const full = Object.fromEntries(info.agents.map((role) => [role.id, 'claude-code']));
    const role = info.agents[0];
    if (!role) throw new Error('No template role');
    for (const agents of [undefined, {}, { ...full, [role.id]: null }]) {
      expect(
        await core.call(
          'canvas.create',
          { template: info.id, ...(agents === undefined ? {} : { agents }) },
          CALLERS.you,
        ),
      ).toMatchObject({ ok: false, error: { code: 'invalid' } });
      expect(await core.call('canvas.list', {}, CALLERS.you)).toEqual(before);
    }
  });
  it('refuses spawn until chosen, and pins a connection-only source’s own endpoint', async () => {
    expect(await call('canvas.spawnAgent', { from: 'a', relation: 'peer' })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    const made = await call('canvas.spawnAgent', { from: 'b', relation: 'peer' });
    expect(made).toMatchObject({ ok: true });
    const nodes = core.engines.canvas(CANVAS)?.document.nodes;
    expect(
      nodes?.find((node) => node.id !== 'b' && node.data.label.startsWith('Agent'))?.data,
    ).toMatchObject({ adapter: 'claude-code', connection: 'claude-code.sdk' });
  });
  it('keeps every step when you choose its endpoint with setType', async () => {
    expect(
      await call('agent.setType', {
        agent: 'a',
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
      }),
    ).toMatchObject({ ok: true });
    expect(
      core.engines
        .canvas(CANVAS)
        ?.document.nodes.find((node) => node.id === 'a' && node.type === 'agent')?.data,
    ).toMatchObject({ queue });
  });
  it('requires explicit endpoints for new agent containers', async () => {
    for (const [op, args] of [
      ['canvas.group', { nodes: ['a'], kind: 'agent' }],
      ['canvas.addParent', { frame: 'f' }],
    ] as const)
      expect(await call(op, args)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(
      await call('canvas.group', { nodes: ['a'], kind: 'agent', adapter: 'codex' }),
    ).toMatchObject({ ok: true });
    expect(await call('canvas.addParent', { frame: 'f', adapter: 'codex' })).toMatchObject({
      ok: true,
    });
    expect(
      core.engines.canvas(CANVAS)?.document.nodes.find((node) => node.id === 'f')?.data,
    ).toMatchObject({ adapter: 'codex', connection: 'codex.terminal' });
  });
  it('requires every template role before inserting anything', async () => {
    const example = EXAMPLES[0];
    if (!example) throw new Error('No template');
    const info = templateInfo(example, CATALOG);
    const before = core.engines.canvas(CANVAS)?.document;
    for (const agents of [
      {},
      Object.fromEntries(info.agents.slice(1).map((role) => [role.id, 'codex'])),
    ]) {
      expect(await call('canvas.insertTemplate', { template: info.id, agents })).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
      expect(core.engines.canvas(CANVAS)?.document).toBe(before);
    }
  });
});
