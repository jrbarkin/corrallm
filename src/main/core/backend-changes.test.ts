import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Dispatcher } from './call';
import { toFile } from '../../shared/model/file';
import type { CanvasDocument } from '../../shared/model/canvas';
import { fakeConnector } from '../sessions/test-fake';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { legacyDirectories } from './workspaces/test-directories';
import { CALLERS, CANVAS, NO_DESKTOP, OTHER_CANVAS } from './test-registry';

let core: Core;
let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-backend-changes-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  const document: CanvasDocument = {
    id: CANVAS,
    arrange: false,
    links: [],
    nodes: [
      {
        id: 'worker',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'Worker', adapter: 'codex', connection: 'codex.app-server' },
      },
      {
        id: 'fallen',
        type: 'agent',
        position: { x: 300, y: 0 },
        data: {
          label: 'Fallen',
          adapter: 'codex',
          connection: 'codex.app-server',
          fallback: {
            to: [{ adapter: 'codex', connection: 'codex.app-server' }],
            on: {
              step: 0,
              from: { adapter: 'claude-code', connection: 'claude-code.sdk' },
              why: 'usage-limit',
              at: 1,
            },
          },
        },
      },
    ],
  };
  await writeFile(file, toFile(document));
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  core = await createCore(
    {
      profile,
      app: { name: 'test', version: '1' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      watchFolder: () => ({ close: () => undefined }),
      sessions: {
        connectors: {
          'codex.app-server': fakeConnector({ adapter: 'codex' }),
        },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
});
afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});
const data = () => core.engines.canvas(CANVAS)?.document.nodes[0]?.data;
async function propose(op: string, args: object) {
  const result = await (core as Dispatcher).call(
    op,
    { canvas: CANVAS, agent: 'worker', ...args },
    CALLERS['outside-write'],
  );
  expect(result).toMatchObject({
    ok: true,
    value: { proposed: expect.stringMatching(/^proposal\//) as unknown },
  });
  if (!result.ok || !('proposed' in (result.value as object)))
    throw new Error(JSON.stringify(result));
  return (result.value as { proposed: string }).proposed;
}
const answer = (to: string, choice = 'allow', caller = CALLERS.you) =>
  core.call('reply', { canvas: CANVAS, to, answer: { choice } }, caller);

describe('backend changes proposed by an outside orchestrator', () => {
  it.each([
    ['agent.setConnection', { connection: 'codex.terminal' }, { connection: 'codex.terminal' }],
    ['agent.setType', { adapter: 'claude-code' }, { adapter: 'claude-code' }],
    [
      'agent.setFallback',
      { fallback: { to: [{ adapter: 'claude-code' }] } },
      { fallback: { to: [{ adapter: 'claude-code' }] } },
    ],
  ])(
    'applies %s only after your approval and refuses the proposer’s answer',
    async (op, args, expected) => {
      const before = structuredClone(data());
      const to = await propose(op, args);
      expect(data()).toEqual(before);
      expect(await answer(to, 'allow', CALLERS['outside-write'])).toMatchObject({
        ok: false,
        error: { code: 'refused' },
      });
      expect(data()).toEqual(before);
      expect(await answer(to)).toMatchObject({ ok: true, value: { outcome: 'allowed' } });
      expect(data()).toMatchObject(expected);
    },
  );
  it('keeps a declined change and a stale approval from changing the agent', async () => {
    const refused = await propose('agent.setConnection', { connection: 'codex.terminal' });
    expect(await answer(refused, 'refuse')).toMatchObject({
      ok: true,
      value: { outcome: 'refused' },
    });
    const stale = await propose('agent.setConnection', { connection: 'codex.terminal' });
    await core.call(
      'canvas.rename',
      { canvas: CANVAS, node: 'worker', label: 'Renamed' },
      CALLERS.you,
    );
    expect(await answer(stale)).toMatchObject({ ok: true, value: { outcome: 'stale' } });
    expect(data()).toMatchObject({ connection: 'codex.app-server' });
  });
  it('refuses modes, invalid endpoints, and out-of-reach agents without a proposal', async () => {
    for (const [op, args] of [
      ['agent.setSettings', { adapter: 'codex', settings: { mode: 'plan' } }],
      ['agent.setConnection', { connection: 'unknown' }],
      ['agent.setType', { adapter: 'unknown' }],
      ['agent.setFallback', { fallback: { to: [{ adapter: 'codex', model: '-flag' }] } }],
      ['agent.setConnection', { canvas: OTHER_CANVAS, connection: 'codex.terminal' }],
    ] as const) {
      expect(
        await core.call(op, { canvas: CANVAS, agent: 'worker', ...args }, CALLERS['outside-write']),
      ).toMatchObject({ ok: false });
    }
    expect(await core.call('needs', { canvas: CANVAS }, CALLERS.you)).toMatchObject({
      ok: true,
      value: { items: [] },
    });
  });
});

it('lets an outside writer return an agent it did not create, and accepts no other endpoint', async () => {
  for (const extra of [
    { adapter: 'codex' },
    { connection: 'codex.terminal' },
    { model: 'default' },
    { effort: 'low' },
    { mode: 'auto' },
  ]) {
    expect(
      await core.call(
        'agent.return',
        { canvas: CANVAS, agent: 'fallen', ...extra },
        CALLERS['outside-write'],
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
  }
  expect(
    await core.call('agent.return', { canvas: CANVAS, agent: 'fallen' }, CALLERS['outside-read']),
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(
    await core.call(
      'agent.return',
      { canvas: OTHER_CANVAS, agent: 'fallen' },
      CALLERS['outside-write'],
    ),
  ).toMatchObject({ ok: false, error: { code: 'not-found' } });
  const result = await core.call(
    'agent.return',
    { canvas: CANVAS, agent: 'fallen' },
    CALLERS['outside-write'],
  );
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    value: { revs: { [`canvas:${CANVAS}`]: expect.any(Number) as unknown } },
  });
  const returned = core.engines.canvas(CANVAS)?.document.nodes.find(({ id }) => id === 'fallen');
  expect(returned?.data).toMatchObject({ adapter: 'claude-code', connection: 'claude-code.sdk' });
  if (returned?.type !== 'agent') throw new Error('No returned agent');
  expect(returned.data.fallback).not.toHaveProperty('on');
  expect(
    await core.call('agent.return', { canvas: CANVAS, agent: 'fallen' }, CALLERS['outside-write']),
  ).toMatchObject({ ok: false, error: { sentence: 'This agent is not on a fallback step.' } });
});

it('refuses a backend change that would also change a saved mode, without proposing it', async () => {
  expect(
    await core.call(
      'agent.setSettings',
      { canvas: CANVAS, agent: 'worker', adapter: 'codex', settings: { mode: 'plan' } },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
  expect(
    await core.call(
      'canvas.batch',
      {
        canvas: CANVAS,
        ops: [
          { op: 'agent.setConnection', args: { agent: 'worker', connection: 'codex.terminal' } },
          {
            op: 'agent.setSettings',
            args: { agent: 'worker', adapter: 'codex', settings: { mode: 'auto' } },
          },
        ],
      },
      CALLERS['outside-write'],
    ),
  ).toMatchObject({ ok: false, error: { code: 'refused' } });
  expect(data()).toMatchObject({ adapter: 'codex', settings: { codex: { mode: 'plan' } } });
});
