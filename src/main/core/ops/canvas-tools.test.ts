import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanvasDocument, AgentNode } from '../../../shared/model/canvas';
import type { OpName } from '../../../shared/api/surface';
import { MAX_MESSAGE_BYTES } from '../../../shared/api/limits';
import { EXAMPLES } from '../../../shared/examples';
import { workspaceOwners } from '../../../shared/model/workspaces';
import { fromFile, toFile } from '../../../shared/model/file';
import { arrange } from '../../../shared/model/layout';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { FakeConnector } from '../../sessions/fake';
import { createCore } from '../core';
import type { Core } from '../core';
import { CALLERS, CANVAS, NO_DESKTOP, isLead } from '../test-registry';
import { keepCanvases, readOnDisk } from '../store/test-store';

let core: Core;
let profile: string;
const initial = (): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes: [
    {
      id: 'lead',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Lead', adapter: 'codex' },
    },
    {
      id: 'other',
      type: 'agent',
      position: { x: 600, y: 700 },
      data: { label: 'Other', adapter: 'codex' },
    },
  ],
  links: [{ source: 'lead', target: 'other' }],
});
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-canvas-tools-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(file, toFile(initial()));
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  core = await createCore(
    {
      profile,
      app: { name: 'test', version: '1' },
      check: true,
      distribution: 'local',
      leads: isLead,
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
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
const doc = () => {
  const open = core.engines.canvas(CANVAS);
  if (!open) throw new Error('Canvas closed');
  return open.document;
};
const revision = () =>
  Number(
    readOnDisk(profile, (disk) =>
      disk.prepare('SELECT rev FROM document WHERE canvas_id=?').get(CANVAS),
    )?.rev,
  );
async function applied(name: OpName, args: object, caller = CALLERS.you) {
  const done = await core.call(name, { canvas: CANVAS, ...args }, caller);
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) throw new Error(done.error.sentence);
  return done.value;
}
async function spec() {
  const listed = await core.call('templates.list', {}, CALLERS.you);
  if (!listed.ok) throw new Error(listed.error.sentence);
  const found = listed.value.items.find((x) => x.name === 'Spec first');
  if (!found) throw new Error('No template');
  return found;
}

describe('canvas.insertTemplate', () => {
  it('inserts the template’s own roots and agents at one revision, filling, translating and retargeting', async () => {
    const template = await spec();
    const before = revision();
    const made = (await applied(
      'canvas.insertTemplate',
      {
        template: template.id,
        values: { feature: 'Export invoices' },
        agents: { builder: 'codex' },
      },
      CALLERS['outside-write'],
    )) as { roots: string[]; agents: string[]; revs: Record<string, number> };
    expect(made.roots).toHaveLength(1);
    expect(doc().nodes).toHaveLength(initial().nodes.length + 4);
    expect(made).not.toHaveProperty('group');
    expect(made.revs).toMatchObject({ [`canvas:${CANVAS}`]: before + 1 });
    expect(revision()).toBe(before + 1);
    const group = doc().nodes.find((n) => n.id === made.roots[0]);
    expect(group).toMatchObject({ type: 'frame', data: { label: 'Spec and implementation' } });
    const agents = doc().nodes.filter(
      (n): n is AgentNode => made.agents.includes(n.id) && n.type === 'agent',
    );
    expect(agents).toHaveLength(template.agents.length);
    for (const node of agents) {
      expect(node.parentId).toBe(made.roots[0]);
      expect(node.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(node.data.connection).toBe(
        CATALOG.adapters.find((a) => a.id === (node.data.adapter ?? DEFAULT_ADAPTER))
          ?.connections[0]?.id,
      );
    }
    const planner = agents.find((n) => n.data.label === 'Planner');
    expect(planner?.data.queue?.[0]).toMatchObject({
      message: expect.stringContaining('Export invoices') as string,
      by: 'outside:orchestrator',
    });
    expect(planner?.data.queue?.[1]).not.toHaveProperty('by');
    const builder = agents.find((n) => n.data.label === 'Builder');
    expect(builder?.data.queue).toContainEqual(expect.objectContaining({ action: 'exec_command' }));
    expect(builder?.data.queue?.[0]).toMatchObject({
      waitFor: [{ agent: planner?.id, item: 'plan' }],
    });
    expect(fromFile(toFile(doc()), CATALOG, DEFAULT_ADAPTER)).toEqual(doc());
    const rows = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT entity FROM change WHERE canvas_id=? AND rev=?').all(CANVAS, before + 1),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { entity: `node/${String(made.roots[0])}` },
        { entity: `node/${String(planner?.id)}` },
      ]),
    );
  });
  it('puts a lead’s insertion in its own team and leaves your filled text unattributed', async () => {
    const template = await spec();
    const lead = (await applied(
      'canvas.insertTemplate',
      { template: template.id, values: { feature: 'Build it' } },
      CALLERS.lead,
    )) as { roots: string[] };
    expect(doc().nodes.find((n) => n.id === lead.roots[0])?.parentId).toBe('lead');
    const yours = (await applied('canvas.insertTemplate', {
      template: template.id,
      values: { feature: 'Your work' },
      parent: lead.roots[0],
    })) as { roots: string[]; agents: string[] };
    expect(doc().nodes.find((n) => n.id === yours.roots[0])?.parentId).toBe(lead.roots[0]);
    const planner = doc().nodes.find(
      (n) => yours.agents.includes(n.id) && n.data.label === 'Planner',
    );
    expect(planner?.type === 'agent' && planner.data.queue?.[0]).not.toHaveProperty('by');
  });
  it('is request-idempotent and gives independent ids to repeated insertions', async () => {
    const template = await spec();
    const args = {
      template: template.id,
      values: {},
      request: '2f1ad1f9-7978-4f49-b7ae-39291affdcf9',
    };
    const first = (await applied('canvas.insertTemplate', args)) as {
      roots: string[];
      agents: string[];
    };
    const before = revision();
    expect(await applied('canvas.insertTemplate', args)).toEqual(first);
    expect(revision()).toBe(before);
    const second = (await applied('canvas.insertTemplate', { ...args, request: undefined })) as {
      roots: string[];
      agents: string[];
    };
    expect(second.roots[0]).not.toBe(first.roots[0]);
    expect(second.agents.some((id) => first.agents.includes(id))).toBe(false);
    expect(doc().nodes.find((n) => n.id === second.roots[0])?.data.label).toBe(
      'Spec and implementation',
    );
  });
  it.each([undefined, 'lead'])(
    'keeps Head to head’s three ordered roots separate unless parent is %s',
    async (parent) => {
      const template = EXAMPLES.find(({ name }) => name === 'Head to head');
      if (!template) throw new Error('No template');
      const before = new Set(doc().nodes.map(({ id }) => id));
      const made = (await applied('canvas.insertTemplate', {
        template: fromFile(template.text, CATALOG, DEFAULT_ADAPTER).id,
        ...(parent === undefined ? {} : { parent }),
      })) as { roots: string[]; agents: string[] };
      const added = doc().nodes.filter(({ id }) => !before.has(id));
      expect(added).toHaveLength(3);
      expect(added.map(({ data }) => data.label)).toEqual(['Claude', 'Codex', 'Judge']);
      expect(made.roots).toEqual(added.map(({ id }) => id));
      expect(made.agents).toEqual(made.roots);
      expect(added.map(({ parentId }) => parentId)).toEqual([parent, parent, parent]);
      if (parent === undefined) expect(workspaceOwners({ ...doc(), nodes: added })).toHaveLength(3);
      if (parent !== undefined) {
        const owner = workspaceOwners(doc()).find(({ agents }) =>
          agents.includes(made.agents[0] ?? ''),
        );
        expect(owner).toMatchObject({ key: 'group/lead', agents: ['lead', ...made.agents] });
      }
    },
  );
  it('refuses unknown template choices and overlong expanded text without a revision', async () => {
    const template = await spec();
    const before = revision();
    for (const [args, code] of [
      [{ template: crypto.randomUUID(), values: {} }, 'not-found'],
      [{ template: template.id, values: {}, parent: 'missing' }, 'not-found'],
      [{ template: template.id, values: { unknown: 'words' } }, 'invalid'],
      // An agent the template lacks is an argument it doesn't take, as canvas.create says.
      [{ template: template.id, values: {}, agents: { missing: 'codex' } }, 'invalid'],
      [
        { template: template.id, values: {}, connections: { missing: 'codex.terminal' } },
        'invalid',
      ],
      [{ template: template.id, values: {}, agents: { builder: 'absent' } }, 'invalid'],
      [
        { template: template.id, values: {}, connections: { builder: 'codex.app-server' } },
        'invalid',
      ],
      [{ template: template.id, values: { feature: 'x'.repeat(MAX_MESSAGE_BYTES) } }, 'invalid'],
      [{ canvas: crypto.randomUUID(), template: template.id, values: {} }, 'not-found'],
    ] as const) {
      expect(
        await core.call('canvas.insertTemplate', { canvas: CANVAS, ...args }, CALLERS.you),
        JSON.stringify(args).slice(0, 180),
      ).toMatchObject({ ok: false, error: { code } });
      expect(revision()).toBe(before);
    }
  });
  it('uses R11 on the whole template, refusing its third insertion at the live-agent cap', async () => {
    const template = await spec();
    for (let i = 0; i < 2; i++)
      await applied(
        'canvas.insertTemplate',
        { template: template.id, values: {} },
        CALLERS['outside-write'],
      );
    const before = revision();
    expect(
      await core.call(
        'canvas.insertTemplate',
        { canvas: CANVAS, template: template.id, values: {} },
        CALLERS['outside-write'],
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'refused', sentence: expect.stringContaining('8') as string },
    });
    expect(revision()).toBe(before);
  });
  it('applies explicit connections for you but R11 refuses a token’s non-default connection', async () => {
    const template = await spec();
    const args = {
      canvas: CANVAS,
      template: template.id,
      values: {},
      connections: { planner: 'claude-code.sdk' },
    };
    expect(await core.call('canvas.insertTemplate', args, CALLERS['outside-write'])).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    const made = (await applied('canvas.insertTemplate', args)) as { agents: string[] };
    expect(
      doc().nodes.find((n) => made.agents.includes(n.id) && n.data.label === 'Planner'),
    ).toMatchObject({ data: { connection: 'claude-code.sdk' } });
  });
});

describe('canvas.setArrange', () => {
  it('can prepare Arrange and insertion inside one atomic batch', async () => {
    const template = await spec();
    const before = revision();
    const result = (await applied('canvas.batch', {
      ops: [
        { op: 'canvas.setArrange', args: { on: true } },
        {
          op: 'canvas.insertTemplate',
          args: { template: template.id, values: { feature: 'Batch work' } },
        },
      ],
    })) as { results: [object, { roots: string[] }]; revs: Record<string, number> };
    expect(result.revs).toMatchObject({ [`canvas:${CANVAS}`]: before + 1 });
    expect(doc().arrange).toBe(true);
    expect(doc().nodes.some((n) => n.id === result.results[1].roots[0])).toBe(true);
  }, 1000);
  it('lays out when enabled as one commit and changes nothing when repeated', async () => {
    const before = doc();
    const rev = revision();
    expect(await applied('canvas.setArrange', { on: true }, CALLERS['outside-write'])).toEqual({
      revs: { [`canvas:${CANVAS}`]: rev + 1 },
    });
    expect(doc()).toEqual(arrange({ ...before, arrange: true }));
    const changed = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT entity FROM change WHERE canvas_id=? AND rev=?').all(CANVAS, rev + 1),
    );
    expect(changed).toContainEqual({ entity: 'meta' });
    expect(changed).toContainEqual({ entity: 'node/other' });
    expect(await applied('canvas.setArrange', { on: true })).toEqual({ revs: {} });
    expect(revision()).toBe(rev + 1);
    const positions = doc().nodes.map((n) => n.position);
    expect(await applied('canvas.setArrange', { on: false })).toEqual({
      revs: { [`canvas:${CANVAS}`]: rev + 2 },
    });
    expect(doc().nodes.map((n) => n.position)).toEqual(positions);
    expect(await applied('canvas.setArrange', { on: false })).toEqual({ revs: {} });
  });
  it('refuses a canvas it does not keep', async () => {
    expect(
      await core.call('canvas.setArrange', { canvas: crypto.randomUUID(), on: true }, CALLERS.you),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});
