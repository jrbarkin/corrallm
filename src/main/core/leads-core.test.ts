import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import type { LeadGrants } from '../../shared/api/ops/leads';
import type { OpName } from '../../shared/api/surface';
import type { TopicSnapshot } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import { fakeConnector } from '../sessions/test-fake';
import type { AgentCaller, Caller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { mintTrustedPath } from './host';
import type { HostServices } from './host';
import { SYSTEM_DEPS } from './store/store';
import { keepCanvases, readOnDisk } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { templateAgents } from './test-template';

/*
 * Who leads, end to end (B24 C1): agent.setLead, outside.setGrant and leads.get through core.call,
 * yours alone; an agent's party read from the lead store on every call (no test override), so a
 * lead's team writes work at once and a demotion refuses its next call; a lead held as its agent
 * changes, until you confirm it; its row going with its agent and its canvas; a canvas file, a
 * template and Save As making no lead; and the `leads:<c>` topic, yours alone.
 */

const TEAM = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01' as CanvasId;
const GRANTS: LeadGrants = { questions: true, plans: false, approvals: true };
const YOU = CALLERS.you;
/** The canvas's lead, its helper nested in it, and an agent whose CLI isn't chosen. */
const LEAD: AgentCaller = { ...(CALLERS.lead as AgentCaller), canvas: TEAM };
const TEAM_LEAD_TEMPLATE = '8150e630-f601-4abe-afae-e93bbf6aa197';

const fileOf = (extra: Record<string, unknown> = {}, node: Record<string, unknown> = {}) => ({
  format: 'corrallm',
  version: 3,
  id: TEAM,
  nodes: [
    {
      id: 'lead',
      kind: 'agent',
      label: 'Lead',
      position: { x: 0, y: 0 },
      connection: 'codex.app-server',
      role: 'Leads the team.',
      ...node,
    },
    {
      id: 'helper',
      kind: 'agent',
      label: 'Helper',
      parent: 'lead',
      position: { x: 0, y: 200 },
      connection: 'codex.app-server',
    },
    { id: 'blank', kind: 'agent', label: 'Blank', position: { x: 400, y: 0 } },
  ],
  links: [],
  ...extra,
});

let profile: string;
let file: string;
let core: Core;
let answers: { open: (string | null)[]; save: (string | null)[] };

const host: HostServices = {
  ...NO_DESKTOP,
  pickCanvasToOpen: () => Promise.resolve(picked(answers.open)),
  pickCanvasToSave: () => Promise.resolve(picked(answers.save)),
};
function picked(queue: (string | null)[]) {
  const next = queue.shift() ?? null;
  return next === null ? null : mintTrustedPath(next);
}
/** The next log flush, held until released: what a write waits on before it answers. */
let held: { entered: () => void; release: Promise<void> } | undefined;
function holdFlush(): { entered: Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  held = {
    entered: () => {
      entered.resolve(undefined);
    },
    release: release.promise.then(() => undefined),
  };
  return {
    entered: entered.promise.then(() => undefined),
    release: () => {
      release.resolve(undefined);
    },
  };
}

async function start(): Promise<Core> {
  const started = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      store: {
        ...SYSTEM_DEPS,
        flush: async (fd) => {
          const now = held;
          if (now !== undefined) {
            held = undefined;
            now.entered();
            await now.release;
          }
          await SYSTEM_DEPS.flush(fd);
        },
      },
      limitsClock: (() => {
        let now = 0;
        return () => (now += 1000);
      })(),
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: { 'codex.app-server': fakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    host,
  );
  await started.engines.open(TEAM);
  return started;
}

async function keep(text: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(text));
  const project = path.join(profile, 'project');
  await mkdir(project, { recursive: true });
  await keepCanvases(profile, { [TEAM]: { file, project } });
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-leads-core-'));
  file = path.join(profile, 'team.corral');
  answers = { open: [], save: [] };
  await keep(fileOf());
  core = await start();
});
afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});

function call(name: OpName, args: object, caller: Caller = YOU): Promise<OpResult<unknown>> {
  return core.call(name, args, caller);
}
async function applied(
  name: OpName,
  args: object,
  caller: Caller = YOU,
): Promise<Record<string, unknown>> {
  const result = await call(name, args, caller);
  expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value as Record<string, unknown>;
}
const setLead = (agent: string, grants: LeadGrants | null = GRANTS, canvas: CanvasId = TEAM) =>
  applied('agent.setLead', { canvas, agent, lead: grants === null ? null : { grants } });
const leadsOf = (canvas: CanvasId = TEAM) => applied('leads.get', { canvas });
/** The lead's write on its team: a lead's alone of the agent parties (L). */
const teamWrite = () =>
  call('queue.add', { canvas: TEAM, agent: 'helper', entry: { message: 'Work' } }, LEAD);
const rows = () =>
  readOnDisk(profile, (disk) => disk.prepare('SELECT canvas_id, agent_id, held FROM lead').all());

describe('agent.setLead', () => {
  it('makes an agent a lead at once, on disk before it answers; no lead again, its next call is refused', async () => {
    // Not a lead yet: a worker, whose audience holds no team write.
    expect(await teamWrite()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const made = await setLead('lead');
    expect(made).toMatchObject({ revs: { [`leads:${TEAM}`]: expect.any(Number) as number } });
    expect(rows()).toEqual([{ canvas_id: TEAM, agent_id: 'lead', held: null }]);
    expect(await teamWrite()).toMatchObject({ ok: true });
    expect(await leadsOf()).toEqual({
      leads: [{ agent: 'lead', grants: GRANTS, held: null }],
      outside: [],
    });

    await setLead('lead', null);
    expect(rows()).toEqual([]);
    expect(await teamWrite()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await leadsOf()).toEqual({ leads: [], outside: [] });
  });

  it('refuses a lead’s call already on its way that reaches its scope once it is no lead', async () => {
    await setLead('lead');
    const gate = holdFlush();
    const demoting = call('agent.setLead', { canvas: TEAM, agent: 'lead', lead: null });
    await gate.entered;
    // Admitted as a lead's, then waiting for the canvas's scope behind the demotion.
    const queued = teamWrite();
    gate.release();
    expect(await demoting).toMatchObject({ ok: true });
    expect(await queued).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('is kept across a restart', async () => {
    await setLead('lead');
    await core.close();
    core = await start();
    expect(await teamWrite()).toMatchObject({ ok: true });
    expect((await leadsOf()).leads).toEqual([{ agent: 'lead', grants: GRANTS, held: null }]);
  });

  it.each(['lead', 'worker', 'outside-read', 'outside-write'] as const)(
    'refuses every one of who-leads’ ops to a %s caller, as only yours',
    async (party) => {
      const caller = CALLERS[party];
      for (const [name, args] of [
        ['agent.setLead', { canvas: TEAM, agent: 'lead', lead: { grants: GRANTS } }],
        ['outside.setGrant', { canvas: TEAM, name: 'orchestrator', approvals: true }],
        ['leads.get', { canvas: TEAM }],
      ] as const)
        expect(await call(name, args, caller), `${party} ${name}`).toMatchObject({
          ok: false,
          error: { code: 'human-only' },
        });
      expect(rows()).toEqual([]);
    },
  );

  it('refuses an agent that isn’t there, or whose CLI isn’t chosen', async () => {
    expect(
      await call('agent.setLead', { canvas: TEAM, agent: 'ghost', lead: { grants: GRANTS } }),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(
      await call('agent.setLead', { canvas: TEAM, agent: 'blank', lead: { grants: GRANTS } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid', sentence: 'Choose its agent before making it a lead.' },
    });
    expect(rows()).toEqual([]);
  });

  it('holds a lead whose role you changed, as a worker, though changed back, until you confirm it', async () => {
    await setLead('lead');
    await applied('agent.setRole', { canvas: TEAM, agent: 'lead', role: 'Something else.' });
    expect(await teamWrite()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect((await leadsOf()).leads).toEqual([{ agent: 'lead', grants: GRANTS, held: 'role' }]);
    await applied('agent.setRole', { canvas: TEAM, agent: 'lead', role: 'Leads the team.' });
    expect(await teamWrite()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(rows()).toEqual([{ canvas_id: TEAM, agent_id: 'lead', held: 'role' }]);
    // Confirm: the same grants again.
    await setLead('lead');
    expect(await teamWrite()).toMatchObject({ ok: true });
    expect((await leadsOf()).leads).toEqual([{ agent: 'lead', grants: GRANTS, held: null }]);
  });

  it('goes with its agent', async () => {
    await setLead('lead');
    await applied('canvas.delete', { canvas: TEAM, nodes: ['lead'] });
    expect(rows()).toEqual([]);
    expect((await leadsOf()).leads).toEqual([]);
  });

  it('goes with a draft forgotten', async () => {
    const { canvas } = (await applied('canvas.create', {})) as { canvas: CanvasId };
    const { id: agent } = (await applied('canvas.addAgent', {
      canvas,
      adapter: 'codex',
      at: { x: 0, y: 0 },
    })) as { id: string };
    await setLead(agent, GRANTS, canvas);
    expect(rows()).toContainEqual({ canvas_id: canvas, agent_id: agent, held: null });
    await applied('canvas.close', { canvas, discard: true });
    expect(rows().filter((row) => row.canvas_id === canvas)).toEqual([]);
  });
});

describe('a canvas file, a template and Save As', () => {
  it('make no lead from a file’s lead, leads or grants keys, and saving writes none back', async () => {
    await core.close();
    await keep(
      fileOf(
        { leads: { lead: { grants: GRANTS } }, grants: { lead: GRANTS } },
        { lead: true, leads: ['helper'], grants: GRANTS },
      ),
    );
    core = await start();
    expect(await leadsOf()).toEqual({ leads: [], outside: [] });
    expect(await teamWrite()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    await setLead('lead');
    await applied('canvas.rename', { canvas: TEAM, node: 'helper', label: 'Aide' });
    await applied('canvas.save', { canvas: TEAM });
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      nodes: Record<string, unknown>[];
    };
    expect(saved).toMatchObject({ nodes: [{ id: 'lead' }, { label: 'Aide' }, {}] });
    const keys = [...Object.keys(saved), ...saved.nodes.flatMap((node) => Object.keys(node))];
    for (const key of ['lead', 'leads', 'grants', 'held', 'fingerprint'])
      expect(keys, key).not.toContain(key);
  });

  it('makes no lead of the Team lead template’s lead', async () => {
    const inserted = (await applied('canvas.insertTemplate', {
      canvas: TEAM,
      template: TEAM_LEAD_TEMPLATE,
      agents: templateAgents(TEAM_LEAD_TEMPLATE, 'codex'),
    })) as { agents: string[] };
    expect(inserted.agents.length).toBeGreaterThan(1);
    expect(await leadsOf()).toEqual({ leads: [], outside: [] });
    expect(rows()).toEqual([]);
  });

  it('keeps the grants with the canvas saved as another file; the file it left opens as a copy with none', async () => {
    await setLead('lead');
    const target = path.join(profile, 'renamed.corral');
    answers.save.push(target);
    await applied('canvas.saveAs', { canvas: TEAM });
    expect((await leadsOf()).leads).toEqual([{ agent: 'lead', grants: GRANTS, held: null }]);
    // The file it was kept in still holds its id: opened, it is a canvas of its own.
    answers.open.push(file);
    const { canvas: copy } = (await applied('canvas.open', {})) as { canvas: CanvasId };
    expect(copy).not.toBe(TEAM);
    expect(await leadsOf(copy)).toEqual({ leads: [], outside: [] });
    expect(rows()).toEqual([{ canvas_id: TEAM, agent_id: 'lead', held: null }]);
  });
});

describe('outside.setGrant', () => {
  it('grants only a live write token’s name reaching the canvas, kept past its token until you take it back', async () => {
    expect(
      await call('outside.setGrant', { canvas: TEAM, name: 'orchestrator', approvals: true }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    await core.tokens.create({ name: 'watcher', canvases: [TEAM], access: 'read' });
    expect(
      await call('outside.setGrant', { canvas: TEAM, name: 'watcher', approvals: true }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    await core.tokens.create({ name: 'orchestrator', canvases: [TEAM], access: 'write' });
    // Listed, before any grant, beside nothing granted.
    expect((await leadsOf()).outside).toEqual([
      { name: 'orchestrator', approvals: false, live: true },
    ]);
    await applied('outside.setGrant', { canvas: TEAM, name: 'orchestrator', approvals: true });
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT canvas_id, name FROM outside_grant').all(),
      ),
    ).toEqual([{ canvas_id: TEAM, name: 'orchestrator' }]);
    expect((await leadsOf()).outside).toEqual([
      { name: 'orchestrator', approvals: true, live: true },
    ]);
    // Revoked, the grant stays, shown with no live token.
    await core.tokens.revoke('orchestrator');
    expect((await leadsOf()).outside).toEqual([
      { name: 'orchestrator', approvals: true, live: false },
    ]);
    await applied('outside.setGrant', { canvas: TEAM, name: 'orchestrator', approvals: false });
    expect((await leadsOf()).outside).toEqual([]);
    expect(
      readOnDisk(profile, (disk) => disk.prepare('SELECT name FROM outside_grant').all()),
    ).toEqual([]);
  });
});

describe('the leads topic', () => {
  it('is yours, read again as who leads changes, as a commit holds a lead and as a token comes', async () => {
    const changes: unknown[] = [];
    const { snapshot, stop } = await core.topics.follow(YOU, `leads:${TEAM}`, (batch) => {
      changes.push(...batch);
    });
    try {
      expect((snapshot as TopicSnapshot<`leads:${CanvasId}`>).state).toEqual({
        leads: [],
        outside: [],
      });
      const last = () =>
        (changes.at(-1) as { replace?: unknown } | undefined)?.replace as
          { leads: unknown[]; outside: unknown[] } | undefined;
      await setLead('lead');
      await vi.waitFor(() => {
        expect(last()?.leads).toEqual([{ agent: 'lead', grants: GRANTS, held: null }]);
      });
      await applied('agent.setRole', { canvas: TEAM, agent: 'lead', role: 'Another.' });
      await vi.waitFor(() => {
        expect(last()?.leads).toEqual([{ agent: 'lead', grants: GRANTS, held: 'role' }]);
      });
      await core.tokens.create({ name: 'orchestrator', canvases: [TEAM], access: 'write' });
      await vi.waitFor(() => {
        expect(last()?.outside).toEqual([{ name: 'orchestrator', approvals: false, live: true }]);
      });
    } finally {
      stop();
    }
    for (const party of ['lead', 'outside-write'] as const)
      await expect(
        core.topics.follow(CALLERS[party], `leads:${TEAM}`, () => undefined),
      ).rejects.toMatchObject({ code: 'human-only' });
  });
});
