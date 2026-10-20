import { asHuman } from './gui';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { RunContext } from '../../shared/run';
import { toFile } from '../../shared/model/file';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import { SYSTEM_DEPS } from './store/store';
import { keepCanvases, openedLast } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
const document = (): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes: [
    {
      id: 'lead',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Lead', adapter: 'codex', connection: 'codex.app-server' },
    },
    {
      id: 'helper',
      type: 'agent',
      parentId: 'lead',
      position: { x: 0, y: 200 },
      data: {
        label: 'Helper',
        adapter: 'codex',
        connection: 'codex.app-server',
        role: 'Private role',
      },
    },
  ],
  links: [],
});
async function profile() {
  const root = await mkdtemp(path.join(tmpdir(), 'corrallm-b9-probe-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function world() {
  const root = await profile();
  const project = path.join(root, 'project');
  await mkdir(project);
  const file = path.join(root, 'canvas.corral');
  await writeFile(file, toFile(document()));
  await keepCanvases(root, { [CANVAS]: { file, project } });
  // The canvas a window shows, as it opens.
  await openedLast(root, CANVAS);
  let held = false;
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const core = await createCore(
    {
      profile: root,
      check: true,
      app: { name: 'probe', version: '1' },
      distribution: 'local',
      leads: (_canvas, agent) => agent === 'lead',
      store: {
        ...SYSTEM_DEPS,
        flush: async (fd) => {
          if (held) {
            held = false;
            entered.resolve(undefined);
            await release.promise;
          }
          await SYSTEM_DEPS.flush(fd);
        },
      },
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  cleanups.push(() => core.close());
  await core.engines.open(CANVAS);
  return {
    core,
    root,
    file,
    hold: () => {
      held = true;
      return {
        entered: entered.promise,
        release: () => {
          release.resolve(undefined);
        },
      };
    },
  };
}

describe('reach when a queued canvas call runs', () => {
  it('queued reach mutation', async () => {
    const w = await world();
    const gate = w.hold();
    const moved = w.core.call('canvas.ungroup', { canvas: CANVAS, nodes: ['lead'] }, CALLERS.you);
    await gate.entered;
    const queued = w.core.call(
      'canvas.rename',
      { canvas: CANVAS, node: 'helper', label: 'Unauthorized' },
      CALLERS.lead,
    );
    gate.release();
    expect(await moved).toMatchObject({ ok: true });
    const result = await queued;
    expect(result).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
  it('queued expect does not reveal a node after it leaves reach', async () => {
    const w = await world();
    const gate = w.hold();
    const moved = w.core.call('canvas.ungroup', { canvas: CANVAS, nodes: ['lead'] }, CALLERS.you);
    await gate.entered;
    const queued = w.core.call(
      'canvas.rename',
      { canvas: CANVAS, node: 'helper', label: 'Attempt', expect: { 'node/helper': 1 } },
      CALLERS.lead,
    );
    gate.release();
    await moved;
    const result = await queued;
    expect(result).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});

describe('reach when a batch’s commit builds', () => {
  it('refuses a batch whose inner op names an agent that left the caller’s reach while it waited', async () => {
    const w = await world();
    const { token } = (await w.core.channels.call(7, 'run:get', [])) as RunContext;
    // The window's edit, which commits outside every op's scope: the helper out of the lead's team.
    const ungrouped = toFile({
      ...document(),
      nodes: document().nodes.map(({ parentId, ...node }) =>
        node.id === 'helper' || parentId === undefined ? node : { ...node, parentId },
      ),
    });
    const snapshot = await w.core.call('canvas.get', { canvas: CANVAS }, asHuman(7));
    if (!snapshot.ok) throw new Error(snapshot.error.sentence);
    const gate = w.hold();
    const edited = w.core.channels.call(7, 'run:save', [
      token,
      null,
      ungrouped,
      snapshot.value.rev,
    ]);
    await gate.entered;
    // The batch takes its scope and passes its inner op's checks there, the edit not live yet,
    // then waits for the canvas's turn behind it.
    const batch = w.core.call(
      'canvas.batch',
      {
        canvas: CANVAS,
        ops: [{ op: 'canvas.rename', args: { node: 'helper', label: 'Unauthorized' } }],
      },
      CALLERS.lead,
    );
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    gate.release();
    await edited;
    expect(await batch).toMatchObject({ ok: false, error: { code: 'not-found' } });
    const helper = w.core.engines.canvas(CANVAS)?.document.nodes.find((one) => one.id === 'helper');
    expect(helper?.data.label).toBe('Helper');
    expect(helper?.parentId).toBeUndefined();
  });
});
