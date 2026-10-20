import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROPOSING_RULES } from '../../shared/api/define';
import type { OpResult } from '../../shared/api/errors';
import { OPS } from '../../shared/api/registry';
import { OP_NAMES, SURFACE } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { findItem } from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import { toFile } from '../../shared/model/file';
import { CanvasMemory } from '../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
import { committer } from './canvas/commit';
import type { Committer } from './canvas/commit';
import { Documents } from './canvas/documents';
import type { Caller, OutsideCaller } from './caller';
import { partyIdOf, partyOf } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { changeChecks } from './rules';
import type { Store } from './store/store';
import { keepCanvases, openTestStore } from './store/test-store';
import { CALLERS, CANVAS, isLead, NO_DESKTOP, PROPOSAL } from './test-registry';

/*
 * T9 (Core Server §3.7, B9 Design §11): no token reaches what a rule forbids, by whatever op it
 * calls. Each rule that guards the canvas's document (R2, R6, R7, R8, R12, R13, R14 so far), tried as
 * an outside write token through every op that exists now, single and structural, and the self
 * cases as an agent (a lead); each refusal changing nothing, and each accepted as you; then on
 * changes no single op makes, as a batch, a composite or an undo will. `canvas.batch`, proposals
 * (R4), `reply`, `canvas.save` and `canvas.close` come with B9's later tasks: their cases are
 * listed below as what remains.
 *
 * The canvas: `lead` (a lead) holding `helper`, `team` (a frame holding `member`) and `spare` (an
 * empty frame); `a`, set to start in a mode and given a role, whose queue holds an OK with work
 * behind it and an if-then; `b`, linked to `a`; `c`, linked to nobody; and `loose`, an empty frame.
 * A second canvas holds `solo`. The outside token reaches both.
 */

const SECOND = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e' as CanvasId;
const OUTSIDE: OutsideCaller = {
  ...(CALLERS['outside-write'] as OutsideCaller),
  canvases: [CANVAS, SECOND],
};
const LEAD = CALLERS.lead;
const YOU = CALLERS.you;

const agent = (id: string, more: object = {}) => ({
  id,
  kind: 'agent',
  label: id.charAt(0).toUpperCase() + id.slice(1),
  position: { x: 0, y: 0 },
  adapter: 'codex',
  connection: 'codex.app-server',
  ...more,
});
const frame = (id: string, more: object = {}) => ({
  id,
  kind: 'group',
  label: id,
  position: { x: 0, y: 0 },
  ...more,
});

const MAIN = {
  format: 'corrallm',
  version: 2,
  id: CANVAS,
  nodes: [
    agent('lead'),
    agent('helper', { parent: 'lead', position: { x: 20, y: 60 } }),
    frame('team', { parent: 'lead', position: { x: 300, y: 60 } }),
    agent('member', { parent: 'team', position: { x: 20, y: 60 } }),
    frame('spare', { parent: 'lead', position: { x: 700, y: 60 } }),
    agent('a', {
      position: { x: 0, y: 900 },
      role: 'Reviews',
      settings: { codex: { mode: 'auto', model: 'm1' } },
      queue: [
        { id: 'first', action: 'exec_command', instruction: 'Plan it' },
        { id: 'ok', approve: 'The plan' },
        { id: 'after', message: 'Build it' },
        {
          id: 'check',
          if: { kind: 'freeText', text: 'Is it built?' },
          then: [{ id: 'fix', message: 'Fix it' }],
        },
      ],
    }),
    agent('b', { position: { x: 400, y: 900 } }),
    agent('c', { position: { x: 800, y: 900 } }),
    frame('loose', { position: { x: 1200, y: 900 } }),
  ],
  links: [{ agents: ['a', 'b'] }],
};
const OTHER = {
  format: 'corrallm',
  version: 2,
  id: SECOND,
  nodes: [agent('solo')],
  links: [],
};

let profile: string;
let core: Core;
let clock = 0;

/** The core on the profile, with both canvases open. */
async function start(): Promise<Core> {
  const started = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      leads: isLead,
      // Each call a second after the last: no token's writes are limited here.
      limitsClock: () => (clock += 1000),
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await started.engines.open(CANVAS);
  await started.engines.open(SECOND);
  return started;
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-bypass-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const kept: Record<string, { file: string; project: string }> = {};
  for (const canvas of [MAIN, OTHER]) {
    const file = path.join(profile, `${canvas.id}.corral`);
    await writeFile(file, JSON.stringify(canvas));
    kept[canvas.id] = { file, project };
  }
  await keepCanvases(profile, kept);
  core = await start();
});
afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});

/** The canvas's document as the core has it now. */
function doc(canvas: CanvasId = CANVAS): CanvasDocument {
  const open = core.engines.canvas(canvas);
  if (!open) throw new Error('The canvas is not open.');
  return open.document;
}
function node(id: string, canvas: CanvasId = CANVAS): AgentNode {
  const found = doc(canvas).nodes.find((one) => one.id === id);
  if (found?.type !== 'agent') throw new Error(`There is no agent ${id}.`);
  return found;
}
function itemOf(owner: string, id: string): QueueItem | undefined {
  return findItem(node(owner).data.queue ?? [], id)?.item;
}
const ids = (owner: string) => (node(owner).data.queue ?? []).map((one) => one.id);
const linked = (x: string, y: string) =>
  doc().links.some(
    ({ source, target }) => (source === x && target === y) || (source === y && target === x),
  );

function call(
  name: OpName,
  args: object,
  caller: Caller,
  canvas: CanvasId = CANVAS,
): Promise<OpResult<unknown>> {
  return core.call(name, { canvas, ...args }, caller);
}

/** Calls `name` as `caller`, expecting a refusal that changes nothing; what it said. */
async function refused(
  name: OpName,
  args: object,
  caller: Caller = OUTSIDE,
  canvas: CanvasId = CANVAS,
): Promise<string> {
  const before = doc(canvas);
  const result = await call(name, args, caller, canvas);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'refused' } });
  expect(doc(canvas)).toBe(before);
  return result.ok ? '' : result.error.sentence;
}
/** Calls `name` as `caller`, expecting `code`, changing nothing. */
async function failed(
  code: string,
  name: OpName,
  args: object,
  caller: Caller = OUTSIDE,
): Promise<string> {
  const before = doc();
  const result = await call(name, args, caller);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code } });
  expect(doc()).toBe(before);
  return result.ok ? '' : result.error.sentence;
}
/** Calls `name` as `caller`, expecting it to apply: its result. */
async function applied(
  name: OpName,
  args: object,
  caller: Caller = OUTSIDE,
  canvas: CanvasId = CANVAS,
): Promise<Record<string, unknown>> {
  const result = await call(name, args, caller, canvas);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value as Record<string, unknown>;
}

/** Restores `a`'s run held for you at item `at` (as a restart restores it: paused). */
function holdAt(at: string, problem?: object) {
  const open = core.engines.canvas(CANVAS);
  if (!open) throw new Error('The canvas is not open.');
  open.engine.run.restore(
    JSON.stringify({
      version: 2,
      run: {
        running: true,
        agents: { a: { status: 'asking', current: at, outcomes: {}, ...(problem && { problem }) } },
      },
      replies: [],
      held: [],
      arrived: [],
      ended: [],
      past: [],
      due: [],
      usageDecided: [],
      warned: [],
    }),
  );
  expect(open.engine.run.snapshot()).toMatchObject({ running: false, paused: true });
}

describe('R2: no token changes the mode an agent starts in', () => {
  it('refuses a mode other than the saved one, or none while one is saved', async () => {
    const settings = (one: object) => ({ agent: 'a', adapter: 'codex', settings: one });
    await refused('agent.setSettings', settings({ mode: 'read-only' }));
    await refused('agent.setSettings', settings({ mode: null }));
    await refused('agent.setSettings', settings({ model: 'm2', mode: 'plan' }));
    // Under another adapter too: what the agent would start in if it ran that one.
    await refused('agent.setSettings', {
      agent: 'a',
      adapter: 'claude-code',
      settings: { mode: 'plan' },
    });
    // The lead, on its team.
    await refused(
      'agent.setSettings',
      { agent: 'helper', adapter: 'codex', settings: { mode: 'read-only' } },
      LEAD,
    );
    expect(node('a').data.settings).toEqual({ codex: { mode: 'auto', model: 'm1' } });
  });

  it('keeps the saved mode for a call that leaves it out or passes it as it is', async () => {
    await applied('agent.setSettings', { agent: 'a', adapter: 'codex', settings: { model: 'm2' } });
    await applied('agent.setSettings', {
      agent: 'a',
      adapter: 'codex',
      settings: { mode: 'auto', effort: 'low' },
    });
    expect(node('a').data.settings).toEqual({
      codex: { mode: 'auto', model: 'm2', effort: 'low' },
    });
  });

  it('applies yours', async () => {
    await applied(
      'agent.setSettings',
      { agent: 'a', adapter: 'codex', settings: { mode: 'read-only' } },
      YOU,
    );
    expect(node('a').data.settings?.codex?.mode).toBe('read-only');
  });
});

describe('R6: an agent never edits itself', () => {
  it('refuses the lead its own settings, role, deletion and a manager', async () => {
    await refused(
      'agent.setSettings',
      { agent: 'lead', adapter: 'codex', settings: { model: 'mine' } },
      LEAD,
    );
    await refused('agent.setRole', { agent: 'lead', role: 'Decides everything' }, LEAD);
    await refused('canvas.delete', { nodes: ['lead'] }, LEAD);
    // Nothing names it as the target here: the change gives it a manager.
    expect(await refused('canvas.group', { nodes: ['lead'], kind: 'agent' }, LEAD)).toMatch(/Lead/);
  });

  it('lets the lead put itself in a frame, which gives it no manager', async () => {
    await applied('canvas.group', { nodes: ['lead'], kind: 'frame' }, LEAD);
    expect(node('lead').parentId).toBeDefined();
  });
});

describe('R7: no token touches an OK, or what the run holds for you', () => {
  it('refuses removing, moving or changing an OK, held or not', async () => {
    await refused('queue.remove', { agent: 'a', item: 'ok' });
    await refused('queue.move', { agent: 'a', item: 'ok', before: 'first' });
    await refused('queue.move', { agent: 'a', item: 'ok', after: 'check' });
    await refused('queue.update', {
      agent: 'a',
      item: 'ok',
      change: { kind: 'approve', approve: 'Anything' },
    });
    expect(ids('a')).toEqual(['first', 'ok', 'after', 'check']);
  });

  it('refuses moving work past an OK, either way', async () => {
    await refused('queue.move', { agent: 'a', item: 'after', before: 'first' });
    await refused('queue.move', { agent: 'a', item: 'check', before: 'ok' });
    // Work the OK comes after, taken behind it (or the OK moved up past it: a change is the same).
    await refused('queue.move', { agent: 'a', item: 'first', after: 'ok' });
    // Work on one side of it may be reordered there.
    await applied('queue.move', { agent: 'a', item: 'check', before: 'after' });
    expect(ids('a')).toEqual(['first', 'ok', 'check', 'after']);
  });

  it('lets a token add an OK, and work after one', async () => {
    const ok = await applied('queue.add', { agent: 'a', entry: { approve: 'Ship it' } });
    await applied('queue.add', { agent: 'a', entry: { message: 'And then' } });
    expect(itemOf('a', String(ok.id))).toMatchObject({ approve: 'Ship it' });
  });

  it('refuses deleting an agent whose queue holds an OK: refused, not proposed', async () => {
    expect(await refused('canvas.delete', { nodes: ['a'] })).toMatch(/OK/);
    expect(node('a')).toBeDefined();
  });

  it('refuses touching what the run holds for you, while it is paused too: a held If', async () => {
    holdAt('check', {
      kind: 'uncertain',
      reason: 'unheard-reply',
      text: 'Decide whether the condition holds.',
      agent: 'a',
      conditionKey: JSON.stringify(['a', 'check']),
    });
    const condition = { kind: 'freeText', text: 'Is it shipped?' };
    await refused('queue.update', {
      agent: 'a',
      item: 'check',
      change: { kind: 'condition', condition },
    });
    await refused('queue.remove', { agent: 'a', item: 'check' });
    await refused('queue.move', { agent: 'a', item: 'check', before: 'after' });
    await refused('canvas.delete', { nodes: ['a'] });
    await applied(
      'queue.update',
      { agent: 'a', item: 'check', change: { kind: 'condition', condition } },
      YOU,
    );
    expect(itemOf('a', 'check')).toMatchObject({ if: condition });
  });

  it('refuses touching a held task, and deleting its agent', async () => {
    await applied('queue.remove', { agent: 'a', item: 'ok' }, YOU);
    holdAt('first', {
      kind: 'failed',
      reason: 'error',
      text: 'It failed.',
      agent: 'a',
    });
    await refused('queue.update', {
      agent: 'a',
      item: 'first',
      change: { kind: 'instruction', instruction: 'Plan it differently' },
    });
    await refused('canvas.delete', { nodes: ['a'] });
  });

  it('lets a token change an if-then the run doesn’t hold', async () => {
    const condition = { kind: 'freeText', text: 'Is it shipped?' };
    await applied('queue.update', {
      agent: 'a',
      item: 'check',
      change: { kind: 'condition', condition },
    });
    expect(itemOf('a', 'check')).toMatchObject({ if: condition });
  });

  it('applies yours', async () => {
    await applied('queue.move', { agent: 'a', item: 'after', before: 'first' }, YOU);
    await applied('queue.remove', { agent: 'a', item: 'ok' }, YOU);
    expect(ids('a')).toEqual(['after', 'first', 'check']);
  });
});

describe('R8: no token changes how an existing agent runs', () => {
  it('answers the ops that would human-only, to an outside token and to the lead', async () => {
    for (const caller of [OUTSIDE, LEAD]) {
      await failed(
        'human-only',
        'agent.setConnection',
        { agent: 'helper', connection: 'codex.terminal' },
        caller,
      );
      await failed(
        'human-only',
        'agent.setType',
        { agent: 'helper', adapter: 'claude-code' },
        caller,
      );
    }
  });
});

describe('R12: a token gives a role only to an agent it creates in the same commit', () => {
  it('refuses a role on an agent that existed', async () => {
    await refused('agent.setRole', { agent: 'a', role: 'Approves everything' });
    await refused('agent.setRole', { agent: 'helper', role: 'Approves everything' }, LEAD);
    // A copy has its source's role as it is made; a later commit's role is refused.
    const { id } = await applied('canvas.spawnAgent', { from: 'a', relation: 'peer' });
    await refused('agent.setRole', { agent: String(id), role: 'Approves everything' });
    expect(node('a').data.role).toBe('Reviews');
  });

  it('applies yours', async () => {
    await applied('agent.setRole', { agent: 'a', role: 'Approves' }, YOU);
    expect(node('a').data.role).toBe('Approves');
  });
});

describe('R13: no token links or unlinks agents that existed', () => {
  it('refuses a link added or removed between agents that both existed and remain', async () => {
    await refused('canvas.link', { a: 'a', b: 'c' });
    await refused('canvas.unlink', { a: 'a', b: 'b' });
    await refused('canvas.delete', { links: [{ a: 'b', b: 'a' }] });
    await refused('canvas.link', { a: 'lead', b: 'helper' }, LEAD);
    expect([linked('a', 'b'), linked('a', 'c')]).toEqual([true, false]);
  });

  it('lets a token link an agent it creates', async () => {
    const { id } = await applied('canvas.spawnAgent', { from: 'c', relation: 'linked' });
    expect(linked('c', String(id))).toBe(true);
  });

  it('applies yours', async () => {
    await applied('canvas.link', { a: 'a', b: 'c' }, YOU);
    await applied('canvas.unlink', { a: 'a', b: 'b' }, YOU);
    expect([linked('a', 'b'), linked('a', 'c')]).toEqual([false, true]);
  });
});

describe('R14: no token changes who manages an existing agent; frames are free', () => {
  it('refuses an agent made around agents, of a frame holding one, or out of one', async () => {
    await refused('canvas.group', { nodes: ['helper'], kind: 'agent' });
    await refused('canvas.addParent', { frame: 'team' });
    await refused('canvas.ungroup', { nodes: ['lead'] });
    // Deleting a manager gives its team another: refused, not proposed.
    await refused('canvas.delete', { nodes: ['lead'] });
    await refused('canvas.group', { nodes: ['member'], kind: 'agent' }, LEAD);
  });

  it('lets frames come and go around agents', async () => {
    await applied('canvas.group', { nodes: ['helper'], kind: 'frame' });
    await applied('canvas.ungroup', { nodes: ['team'] });
    expect(node('member').parentId).toBe('lead');
  });

  it('applies yours', async () => {
    const { id } = await applied('canvas.group', { nodes: ['helper'], kind: 'agent' }, YOU);
    expect(node('helper').parentId).toBe(id);
    await applied('canvas.addParent', { frame: 'team' }, YOU);
    expect(node('team').type).toBe('agent');
  });
});

/*
 * Whatever builds a change: a batch, a composite's sub-ops, an undo or an op not written yet. The
 * change rules read the change itself, so a token's commit is refused whatever made it.
 */
describe('on the change itself, whatever builds it', () => {
  let store: Store;
  let documents: Documents;
  let commit: Committer;
  const BUILT = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5f' as CanvasId;

  beforeEach(async () => {
    store = await openTestStore(profile);
    documents = new Documents({
      store,
      memory: new CanvasMemory(store),
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    await documents.edit(BUILT, toFile({ ...documents.read(JSON.stringify(MAIN)), id: BUILT }));
    commit = committer({
      documents,
      rules: changeChecks({
        catalog: CATALOG,
        defaultAdapter: DEFAULT_ADAPTER,
        held: () => new Set(['item/a/after']),
      }),
    });
  });
  afterEach(async () => {
    await store.close();
  });

  /** Commits what `edit` makes of the document, as `caller`. */
  function build(edit: (document: CanvasDocument) => CanvasDocument, caller: Caller = OUTSIDE) {
    return commit(BUILT, (document) => ({ next: edit(document), result: {} }), {
      op: 'canvas.batch',
      caller,
      party: partyOf(caller, isLead),
      by: partyIdOf(caller),
      signal: new AbortController().signal,
      noReturn: () => undefined,
    });
  }
  /** `document` with agent `id`'s data changed by `change`. */
  const editing =
    (id: string, change: (data: AgentNode['data']) => AgentNode['data']) =>
    (document: CanvasDocument): CanvasDocument => ({
      ...document,
      nodes: document.nodes.map((one) =>
        one.id === id && one.type === 'agent' ? { ...one, data: change(one.data) } : one,
      ),
    });
  /** `document` with a new agent `id`, from `data`, linked to `to`. */
  const adding =
    (id: string, data: Partial<AgentNode['data']>, to?: string) =>
    (document: CanvasDocument): CanvasDocument => ({
      ...document,
      nodes: [
        ...document.nodes,
        {
          id,
          type: 'agent',
          position: { x: 3000, y: 0 },
          data: { label: 'New', adapter: 'codex', ...data },
        },
      ],
      links: to === undefined ? document.links : [...document.links, { source: to, target: id }],
    });

  const EDITS: [string, (document: CanvasDocument) => CanvasDocument][] = [
    ['a mode', editing('a', (data) => ({ ...data, settings: { codex: { mode: 'plan' } } }))],
    [
      'a mode under another adapter',
      editing('a', (data) => ({
        ...data,
        settings: { ...data.settings, 'claude-code': { mode: 'plan' } },
      })),
    ],
    ['a connection', editing('a', (data) => ({ ...data, connection: 'codex.terminal' }))],
    [
      'an adapter',
      editing('a', (data) => {
        const next = { ...data, adapter: 'claude-code' };
        delete next.connection;
        return next;
      }),
    ],
    ['a role', editing('a', (data) => ({ ...data, role: 'Approves everything' }))],
    [
      'an OK',
      editing('a', (data) => ({
        ...data,
        queue: (data.queue ?? []).filter(({ id }) => id !== 'ok'),
      })),
    ],
    [
      'what the run holds for you',
      editing('a', (data) => ({
        ...data,
        queue: (data.queue ?? []).map((one) =>
          one.id === 'after' ? { ...one, target: 'c' } : one,
        ),
      })),
    ],
    [
      'a link between agents that existed, beside an agent it creates',
      (document) =>
        adding(
          'new',
          {},
        )({ ...document, links: [...document.links, { source: 'a', target: 'c' }] }),
    ],
    ['an unlink between agents that existed', (document) => ({ ...document, links: [] })],
    [
      'a manager',
      (document) => ({
        ...document,
        nodes: document.nodes.map((one) => (one.id === 'c' ? { ...one, parentId: 'a' } : one)),
      }),
    ],
  ];

  it.each(EDITS)('refuses a token’s change of %s, and applies yours', async (_what, edit) => {
    const before = documents.live(BUILT).rev;
    await expect(build(edit)).rejects.toMatchObject({ code: 'refused' });
    expect(documents.live(BUILT).rev).toBe(before);
    await expect(build(edit, YOU)).resolves.toMatchObject({ rev: before + 1 });
  });

  it('lets a token give a role and a link to an agent it creates in the same change', async () => {
    await expect(build(adding('new', { role: 'Checks the build' }, 'a'))).resolves.toMatchObject({
      rev: 2,
    });
  });

  it('refuses an agent its own role, settings, connection or manager, whatever builds it', async () => {
    const lead = { ...LEAD, canvas: BUILT };
    await expect(
      build(
        editing('lead', (data) => ({ ...data, role: 'Mine' })),
        lead,
      ),
    ).rejects.toMatchObject({ code: 'refused', message: /its own role/ });
    await expect(
      build(
        editing('lead', (data) => ({ ...data, settings: { codex: { model: 'm9' } } })),
        lead,
      ),
    ).rejects.toMatchObject({ code: 'refused', message: /its own settings/ });
    await expect(
      build(
        (document) => ({
          ...document,
          nodes: document.nodes.filter(
            ({ id }) =>
              id !== 'lead' &&
              id !== 'helper' &&
              id !== 'team' &&
              id !== 'member' &&
              id !== 'spare',
          ),
        }),
        lead,
      ),
    ).rejects.toMatchObject({ code: 'refused', message: /removes itself|remove/ });
  });
});

describe('proposals', () => {
  it('come only from an op declaring R4 or R5: no other op’s result can be one', () => {
    for (const name of OP_NAMES) {
      const proposes = ((SURFACE[name] as { rules?: readonly string[] }).rules ?? []).some((rule) =>
        (PROPOSING_RULES as readonly string[]).includes(rule),
      );
      if (proposes) continue;
      expect(OPS[name].output.safeParse({ proposed: PROPOSAL }).success, name).toBe(false);
    }
  });

  // B9 Design §1, Claude 9, 10 and 12: what these rules guard comes with those tasks.
  it.todo('R4: a token’s canvas.delete of an agent is a proposal, deleting nothing (Claude 10)');
  it.todo('R4: a delete in a canvas.batch is one proposal, its links going with it (Claude 10)');
  it.todo('R4: a batch mixing a refusal and a delete is refused, not proposed (Claude 10)');
  it.todo('R4: canvas.save of a document missing agents the file on disk has (Claude 9)');
  it.todo('R4: canvas.close or create {replace} with discard on an edited canvas (Claude 9)');
  it.todo(
    'canvas.batch: addAgent with setSettings {mode} refused, with setRole accepted (Claude 10)',
  );
  it.todo('canvas.batch: holding agent.setConnection, link or unlink, refused (Claude 10)');
  it.todo('R3: a token’s reply to a proposal or a file review is refused (Claude 10, 12)');
  it.todo('Allow after an entity a proposal touched changed settles it stale (Claude 10)');
});
