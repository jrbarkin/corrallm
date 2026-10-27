import { legacyDirectories } from './workspaces/test-directories';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROPOSING_RULES } from '../../shared/api/define';
import { MAX_OPEN_PROPOSALS } from '../../shared/api/limits';
import type { OpResult } from '../../shared/api/errors';
import { OPS } from '../../shared/api/registry';
import { OP_NAMES, SURFACE } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { AgentNode, CanvasDocument } from '../../shared/model/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import { findItem } from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import { CanvasMemory } from '../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
import { committer } from './canvas/commit';
import type { Committer } from './canvas/commit';
import { Documents } from './canvas/documents';
import { commitDocument } from './canvas/test-documents';
import type { Caller, OutsideCaller } from './caller';
import { partyIdOf, partyOf } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { changeChecks } from './rules';
import type { Store } from './store/store';
import { keepCanvases, openTestStore, readOnDisk } from './store/test-store';
import type { Kept } from './store/test-store';
import { CALLERS, CANVAS, isLead, NO_DESKTOP, PROPOSAL } from './test-registry';
import { TEMPLATE } from './test-world';
import { WorkspaceCleanup } from './workspaces/cleanup';
import type { TreeState } from './workspaces/cleanup';
import { GitRunner } from './workspaces/git';
import type { WorktreeListing } from './workspaces/list';
import { WorkspacePlanner } from './workspaces/planner';
import { WorkspaceStore } from './workspaces/store';
import type { WorktreeRecord } from './workspaces/store';
import { testWorkspaces } from './workspaces/test-workspace';
import type { TestWorkspaces } from './workspaces/test-workspace';

/*
 * T9 (Core Server §3.7, B9 Design §11): no token reaches what a rule forbids, by whatever op it
 * calls. Each rule that guards the canvas's document (R2, R6, R7, R8, R11, R12, R13, R14) and
 * R34's validation, tried as an outside write token through every op that exists now, single and
 * structural, and the self cases as an agent (a lead); each refusal changing nothing, and each
 * accepted as you; then on changes no single op makes, as a composite or an undo will. R4's
 * proposals: a token's delete applies nothing and waits for you, allowed, refused or settled stale,
 * the proposer told; R3: only you answer one; and `canvas.batch`, whose combined change meets every
 * rule, each inner op checked as the caller's own call. R4's argument half: a token's canvas.save
 * that would remove agents its file has, and its canvas.close or canvas.create replacing a canvas
 * with edits not saved, with discard, are proposed. R3 on a file review: no token answers it.
 * B9a's workspace-safety, checked on everyone's change whatever builds it (a single op, a batch, a
 * file's Apply, a build no single op makes): a tree holding work is never left with no agent but
 * as you confirm, no agent working in a tree is moved out of it but by your Switch, no change runs
 * or approves a setup; and the worktree list (C's authorized selector) names to each caller only
 * the agents it reaches now, a shared tree no member it doesn't.
 *
 * The canvas: `lead` (a lead) holding `helper`, `team` (a frame holding `member`) and `spare` (an
 * empty frame); `a`, set to start in a mode and given a role, whose queue holds an OK with work
 * behind it and an if-then; `b`, linked to `a`; `c`, linked to nobody; and `loose`, an empty frame.
 * A second canvas holds `solo`. The outside token reaches both.
 */

const SECOND = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e' as CanvasId;
const CONVERSATION = '6a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a5b';
const OUTSIDE: OutsideCaller = {
  ...(CALLERS['outside-write'] as OutsideCaller),
  canvases: [CANVAS, SECOND],
};
/** The same party, by a new token: a renewal. */
const RENEWED: OutsideCaller = { ...OUTSIDE, token: 'renewed-token' };
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
    agent('b', {
      position: { x: 400, y: 900 },
      queue: [
        { id: 'b1', message: 'One' },
        { id: 'b2', message: 'Two' },
        { id: 'b3', action: 'exec_command', instruction: 'Three' },
      ],
    }),
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
      directoryResolver: legacyDirectories,
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
  const kept: Record<string, Kept> = {};
  for (const canvas of [MAIN, OTHER]) {
    const file = path.join(profile, `${canvas.id}.corral`);
    await writeFile(file, JSON.stringify(canvas));
    kept[canvas.id] = { file, project };
  }
  // B has a conversation in its CLI, which deleting it would lose.
  kept[CANVAS] = { ...kept[CANVAS], conversations: { codex: { b: { id: CONVERSATION } } } };
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

describe('R7: paused repeat holds', () => {
  it.each(['paused', 'restored'] as const)(
    'refuses a token editing an exhausted repeat while %s',
    async (when) => {
      const { id } = await applied(
        'queue.add',
        {
          agent: 'b',
          entry: {
            repeat: [{ message: 'Try' }],
            until: { kind: 'failed' },
            rounds: 1,
            otherwise: 'ask',
          },
        },
        YOU,
      );
      const repeat = itemOf('b', String(id));
      if (!repeat || !('repeat' in repeat)) throw new Error('No repeat');
      const inner = repeat.repeat[0];
      if (!inner) throw new Error('No inner item');
      const open = core.engines.canvas(CANVAS);
      if (!open) throw new Error('The canvas is not open.');
      const run = open.engine.run;
      run.restore(
        JSON.stringify({
          version: 2,
          run: {
            running: true,
            agents: {
              b: {
                status: 'asking',
                current: id,
                outcomes: {
                  b1: 'succeeded',
                  b2: 'succeeded',
                  b3: 'succeeded',
                  [inner.id]: 'succeeded',
                },
                rounds: { [String(id)]: { round: 1 } },
              },
            },
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
      run.resume();
      expect(run.snapshot().agents.b).toMatchObject({ status: 'asking', current: id });
      await applied('run.pause', { target: { agent: 'b' } });
      if (when === 'restored') {
        await core.close();
        core = await start();
      }
      await refused('queue.update', {
        agent: 'b',
        item: id,
        change: { kind: 'repeat', otherwise: 'goOn' },
      });
      expect(itemOf('b', String(id))).toMatchObject({ otherwise: 'ask' });
      await applied('run.unpause', { target: { agent: 'b' } });
    },
  );
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
      // B11a C1: the chain is yours alone too.
      await failed(
        'human-only',
        'agent.setFallback',
        { agent: 'helper', fallback: { to: [{ adapter: 'claude-code' }] } },
        caller,
      );
    }
  });

  it('refuses a token’s batch that sets a chain, as a whole', async () => {
    const before = doc();
    for (const caller of [OUTSIDE, LEAD]) {
      const result = await call(
        'canvas.batch',
        {
          ops: [
            { op: 'canvas.move', args: { moves: [{ node: 'helper', position: { x: 9, y: 9 } }] } },
            {
              op: 'agent.setFallback',
              args: { agent: 'helper', fallback: { to: [{ adapter: 'claude-code' }] } },
            },
          ],
        },
        caller,
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'human-only' } });
    }
    expect(doc()).toBe(before);
  });
});

describe('R11: what a token’s new agents run with, and how many it keeps', () => {
  it('gives a new agent its adapter’s first connection and no mode', async () => {
    const { id } = await applied('canvas.addAgent', { at: { x: 2000, y: 0 }, adapter: 'codex' });
    expect(node(String(id)).data).not.toHaveProperty('connection');
    expect(node(String(id)).data).not.toHaveProperty('settings');
  });

  it('lets a spawned agent copy its source’s connection, mode and role, linked to it', async () => {
    const { id } = await applied('canvas.spawnAgent', { from: 'a', relation: 'linked' });
    expect(node(String(id)).data).toMatchObject({
      connection: 'codex.app-server',
      settings: { codex: { mode: 'auto', model: 'm1' } },
      role: 'Reviews',
    });
    expect(linked('a', String(id))).toBe(true);
  });

  it('lets a spawned agent copy the fallback chain and handoff settings you gave its source', async () => {
    await applied(
      'agent.setFallback',
      { agent: 'a', fallback: { to: [{ adapter: 'claude-code' }], back: 'return' } },
      YOU,
    );
    const { id } = await applied('canvas.spawnAgent', { from: 'a', relation: 'linked' });
    expect(node(String(id)).data.fallback).toEqual({
      to: [{ adapter: 'claude-code', connection: 'claude-code.terminal' }],
      back: 'return',
    });
  });

  it('refuses the ninth live agent its party created, across its canvases, a restart and a renewal', async () => {
    for (let i = 0; i < 3; i++) {
      await applied(
        'canvas.addAgent',
        { at: { x: 2000 + i * 300, y: 0 }, adapter: 'codex' },
        OUTSIDE,
        SECOND,
      );
    }
    const mine: string[] = [];
    const created = async (name: OpName, args: object) =>
      mine.push(String((await applied(name, args)).id));
    await created('canvas.addAgent', { at: { x: 2000, y: 0 }, adapter: 'codex' });
    await created('canvas.addAgent', { at: { x: 2300, y: 0 }, adapter: 'codex' });
    await created('canvas.spawnAgent', { from: 'c', relation: 'peer' });
    // An agent made around a frame, or of one, counts too.
    await created('canvas.group', { nodes: ['loose'], kind: 'agent' });
    await created('canvas.addParent', { frame: 'spare' });
    expect(mine).toHaveLength(5);

    await core.close();
    core = await start();
    const ninth = await refused(
      'canvas.addAgent',
      { at: { x: 2000, y: 300 }, adapter: 'codex' },
      RENEWED,
      SECOND,
    );
    expect(ninth).toMatch(/8/);
    for (const [name, args] of [
      ['canvas.spawnAgent', { from: 'c', relation: 'peer' }],
      ['canvas.group', { nodes: ['c'], kind: 'agent' }],
    ] as const) {
      expect(await refused(name, args, RENEWED)).toMatch(/at most 8 live agents/);
    }
    // Agents you create count toward no one, and the lead's are its own.
    await applied('canvas.addAgent', { at: { x: 2000, y: 300 }, adapter: 'codex' }, YOU);
    await applied('canvas.spawnAgent', { from: 'helper', relation: 'peer' }, LEAD);
    // One of its agents gone, it may make another.
    await applied('canvas.delete', { nodes: [mine[0]] }, YOU);
    await applied('canvas.addAgent', { at: { x: 2000, y: 300 }, adapter: 'codex' }, RENEWED);
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

describe('R34: what anyone edits passes what a file would', () => {
  it('refuses a step naming an action its agent’s adapter doesn’t declare, to anyone', async () => {
    for (const caller of [OUTSIDE, YOU]) {
      await failed(
        'invalid',
        'queue.add',
        { agent: 'a', entry: { action: 'Bash', instruction: 'Run it' } },
        caller,
      );
      await failed(
        'invalid',
        'queue.update',
        { agent: 'a', item: 'first', change: { kind: 'action', action: 'Bash' } },
        caller,
      );
    }
    await applied('queue.add', { agent: 'a', entry: { action: 'apply_patch' } });
  });

  it('refuses a target, a wait or a repeat to go round with that isn’t there, to anyone', async () => {
    const entries = [
      { message: 'Hand over', target: 'ghost' },
      { action: 'exec_command', target: 'ghost' },
      { waitFor: [{ agent: 'ghost' }] },
      { waitFor: [{ agent: 'b', item: 'ghost' }] },
      {
        repeat: [{ message: 'Again' }],
        until: { kind: 'repeatEnds', agent: 'a', item: 'ghost' },
        rounds: 2,
        otherwise: 'ask',
      },
      // What it goes round with must be a repeat.
      {
        repeat: [{ message: 'Again' }],
        until: { kind: 'repeatEnds', agent: 'a', item: 'first' },
        rounds: 2,
        otherwise: 'ask',
      },
    ];
    for (const entry of entries) await failed('invalid', 'queue.add', { agent: 'a', entry }, YOU);
    await failed(
      'invalid',
      'queue.update',
      { agent: 'a', item: 'after', change: { kind: 'target', target: 'ghost' } },
      YOU,
    );
    await applied('queue.add', { agent: 'a', entry: { waitFor: [{ agent: 'a', item: 'first' }] } });
  });

  it('takes canvas text starting with a shell prefix, held at delivery, never refused as it is added', async () => {
    const { id } = await applied('queue.add', {
      agent: 'a',
      entry: { message: '!rm -rf ~', target: 'b' },
    });
    expect(itemOf('a', String(id))).toEqual({
      id,
      by: 'outside:orchestrator',
      message: '!rm -rf ~',
      target: 'b',
    });
  });

  it('marks text another party writes as its, and yours as no one’s: provenance, never authority', async () => {
    const { id } = await applied('queue.add', { agent: 'a', entry: { message: 'Token text' } });
    expect(itemOf('a', String(id))).toHaveProperty('by', 'outside:orchestrator');
    // A move keeps who wrote it; your words make it yours.
    await applied('queue.move', { agent: 'a', item: String(id), before: 'check' }, YOU);
    expect(itemOf('a', String(id))).toHaveProperty('by', 'outside:orchestrator');
    await applied(
      'queue.update',
      { agent: 'a', item: String(id), change: { kind: 'message', message: 'My text' } },
      YOU,
    );
    expect(itemOf('a', String(id))).not.toHaveProperty('by');
    const mine = await applied('queue.add', { agent: 'a', entry: { message: 'Mine' } }, YOU);
    expect(itemOf('a', String(mine.id))).not.toHaveProperty('by');
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
    await commitDocument(documents, BUILT, { ...documents.read(JSON.stringify(MAIN)), id: BUILT });
    commit = committer({
      documents,
      propose: () => Promise.resolve(PROPOSAL),
      rules: changeChecks({
        catalog: CATALOG,
        defaultAdapter: DEFAULT_ADAPTER,
        held: () => new Set(['item/a/after']),
        created: (party, canvas, removing) => documents.created(party, canvas, removing),
        maxCreated: () => 8,
      }),
    });
  });
  afterEach(async () => {
    await store.close();
  });

  /** Commits what `edit` makes of the document, as `caller`, its new agents copying `copies`. */
  function build(
    edit: (document: CanvasDocument) => CanvasDocument,
    caller: Caller = OUTSIDE,
    copies?: ReadonlyMap<string, string>,
  ) {
    const built = (document: CanvasDocument) => ({
      next: edit(document),
      result: {},
      ...(copies === undefined ? {} : { copies }),
    });
    return commit(BUILT, built, {
      op: 'canvas.batch',
      proposes: true,
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

  it.each([
    ['mode', { connection: 'codex.app-server', settings: { codex: { mode: 'plan' } } }, 'a'],
    ['connection', { connection: 'codex.app-server' }, 'c'],
    ['missing source', { connection: 'codex.app-server' }, 'absent'],
  ] as const)('refuses a copy whose %s was not copied', async (_what, data, source) => {
    if (_what === 'connection')
      await build(
        editing('c', (data) => ({ ...data, connection: 'codex.terminal' })),
        YOU,
      );
    const before = documents.live(BUILT);
    await expect(
      build(adding('new', data), OUTSIDE, new Map([['new', source]])),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(documents.live(BUILT)).toBe(before);
  });

  it('inherits copied permissions through a new copy, but not a cycle', async () => {
    const permissions = { connection: 'codex.app-server', settings: { codex: { mode: 'auto' } } };
    await expect(
      build(
        (document) => adding('second', permissions)(adding('first-copy', permissions)(document)),
        OUTSIDE,
        new Map([
          ['first-copy', 'a'],
          ['second', 'first-copy'],
        ]),
      ),
    ).resolves.toBeDefined();
    await expect(
      build(
        (document) => adding('cycle-a', permissions)(adding('cycle-b', permissions)(document)),
        OUTSIDE,
        new Map([
          ['cycle-a', 'cycle-b'],
          ['cycle-b', 'cycle-a'],
        ]),
      ),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('validates a moved item’s new container without rewriting its fields', async () => {
    await build(
      editing('b', (data) => ({
        ...data,
        queue: [
          { id: 'condition', if: { kind: 'succeeded' }, then: [] },
          { id: 'wait', waitFor: [{ agent: 'c' }] },
        ],
      })),
      YOU,
    );
    const before = documents.live(BUILT).rev;
    await expect(
      build(
        editing('b', (data) => {
          const [condition, wait] = data.queue ?? [];
          return { ...data, queue: [{ ...condition, then: [wait] }] as QueueItem[] };
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid', message: /if-then cannot hold a wait/ });
    expect(documents.live(BUILT).rev).toBe(before);
  });

  it('does not credit a removal of an agent this party did not create', async () => {
    for (let i = 0; i < 8; i++) await build(adding(`made-${String(i)}`, {}));
    await expect(
      build((document) =>
        adding(
          'replacement',
          {},
        )({ ...document, nodes: document.nodes.filter((n) => n.id !== 'c') }),
      ),
    ).rejects.toMatchObject({ code: 'refused', message: /at most 8/ });
  });

  it('counts a replacement at its final live-agent count, so removal becomes a proposal', async () => {
    for (let i = 0; i < 8; i++) await build(adding(`made-${String(i)}`, {}));
    const replace = (document: CanvasDocument) =>
      adding(
        'replacement',
        {},
      )({ ...document, nodes: document.nodes.filter((n) => n.id !== 'made-0') });
    // R4 still guards the removal; R11 must not refuse a final count of eight first.
    await expect(build(replace)).resolves.toEqual({ proposed: PROPOSAL });
    expect(documents.created(partyIdOf(OUTSIDE))).toBe(8);
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
    ['a connection', editing('b', (data) => ({ ...data, connection: 'codex.terminal' }))],
    [
      'an adapter',
      editing('a', (data) => {
        const next = { ...data, adapter: 'claude-code' };
        delete next.connection;
        return next;
      }),
    ],
    ['a role', editing('a', (data) => ({ ...data, role: 'Approves everything' }))],
    // B11a C1: an agent's fallback chain and its handoff settings are yours, whatever op builds them.
    [
      'a fallback chain',
      editing('c', (data) => ({
        ...data,
        fallback: { to: [{ adapter: 'claude-code', connection: 'claude-code.terminal' }] },
      })),
    ],
    ['handoff settings', editing('c', (data) => ({ ...data, handoff: { at: 50 } }))],
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

  it('refuses a token’s new agent on another connection, or with a startup mode, unless it copies one', async () => {
    const elsewhere = adding('new', { connection: 'codex.app-server' });
    const moded = adding('new', { settings: { 'claude-code': { mode: 'plan' } } });
    for (const edit of [elsewhere, moded]) {
      await expect(build(edit)).rejects.toMatchObject({ code: 'refused' });
      if (edit === elsewhere)
        await expect(build(edit, OUTSIDE, new Map([['new', 'a']]))).resolves.toBeDefined();
      else
        await expect(build(edit, OUTSIDE, new Map([['new', 'a']]))).rejects.toMatchObject({
          code: 'refused',
        });
      await build(
        (document) => ({ ...document, nodes: document.nodes.filter(({ id }) => id !== 'new') }),
        YOU,
      );
    }
    // Its adapter's first connection, named, is no other.
    await expect(build(adding('new', { connection: 'codex.terminal' }))).resolves.toBeDefined();
  });

  it('refuses a token’s change to a chain you set, its run position too, or its removal', async () => {
    const chain = {
      to: [
        { adapter: 'claude-code', connection: 'claude-code.terminal' },
        { adapter: 'codex', connection: 'codex.terminal' },
      ],
    };
    await build(
      editing('c', (data) => ({ ...data, fallback: chain, handoff: { at: 80 } })),
      YOU,
    );
    const before = documents.live(BUILT).rev;
    for (const edit of [
      editing('c', (data) => ({ ...data, fallback: { ...chain, to: chain.to.slice(1) } })),
      editing('c', (data) => ({ ...data, fallback: { ...chain, back: 'return' as const } })),
      editing('c', (data) => ({
        ...data,
        fallback: {
          ...chain,
          on: {
            step: 0,
            from: { adapter: 'codex', connection: 'codex.app-server' },
            why: 'rule' as const,
            at: 1,
          },
        },
      })),
      editing('c', (data) => {
        const next = { ...data };
        delete next.fallback;
        return next;
      }),
      editing('c', (data) => ({ ...data, handoff: { at: 81 } })),
      editing('c', (data) => {
        const next = { ...data };
        delete next.handoff;
        return next;
      }),
    ]) {
      await expect(build(edit)).rejects.toMatchObject({ code: 'refused' });
      await expect(build(edit, LEAD)).rejects.toMatchObject({ code: 'refused' });
    }
    expect(documents.live(BUILT).rev).toBe(before);
    // What leaves them as they are is no change to them.
    await expect(
      build(editing('c', (data) => ({ ...data, label: 'Still c' }))),
    ).resolves.toBeDefined();
  });

  it('lets a token’s new agent carry a chain and handoff settings only as an exact copy', async () => {
    const chain = { to: [{ adapter: 'claude-code', connection: 'claude-code.terminal' }] };
    await build(
      editing('a', (data) => ({ ...data, fallback: chain, handoff: { at: 70 } })),
      YOU,
    );
    const copied = { connection: 'codex.app-server', settings: { codex: { mode: 'auto' } } };
    for (const data of [{ fallback: chain }, { handoff: { at: 70 } }]) {
      // Not a copy: refused.
      await expect(build(adding('new', data))).rejects.toMatchObject({
        code: 'refused',
        message: /only the user/i,
      });
    }
    for (const data of [
      { fallback: { to: [{ adapter: 'claude-code', connection: 'claude-code.sdk' }] } },
      { fallback: { ...chain, back: 'return' as const } },
      { handoff: { at: 71 } },
      { fallback: chain, handoff: { off: true as const } },
    ]) {
      await expect(
        build(adding('new', { ...copied, ...data }), OUTSIDE, new Map([['new', 'a']])),
      ).rejects.toMatchObject({ code: 'refused' });
    }
    await expect(
      build(
        adding('new', { ...copied, fallback: chain, handoff: { at: 70 } }),
        OUTSIDE,
        new Map([['new', 'a']]),
      ),
    ).resolves.toBeDefined();
  });

  it('lets a token give a role and a link to an agent it creates in the same change', async () => {
    await expect(build(adding('new', { role: 'Checks the build' }, 'a'))).resolves.toMatchObject({
      rev: 2,
    });
  });

  it('refuses, never proposes, a removal through an op that can’t come to you as a proposal', async () => {
    const before = documents.live(BUILT).rev;
    await expect(
      commit(
        BUILT,
        (document) => ({
          next: { ...document, nodes: document.nodes.filter(({ id }) => id !== 'c') },
          result: {},
        }),
        {
          op: 'canvas.move',
          caller: OUTSIDE,
          party: partyOf(OUTSIDE, isLead),
          by: partyIdOf(OUTSIDE),
          signal: new AbortController().signal,
          noReturn: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'refused', message: /Only the user deletes C/ });
    expect(documents.live(BUILT).rev).toBe(before);
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

describe('workspace-safety on the change itself, whatever builds it', () => {
  const BUILT = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6f' as CanvasId;
  const REPOSITORY = '5e1b0000-0000-4000-8000-000000000001';
  /** `lead`'s group's tree, and `a`'s and `b`'s, each one an agent may have worked in. */
  const TREES = {
    lead: '5e1b0000-0000-4000-8000-000000000010',
    a: '5e1b0000-0000-4000-8000-000000000011',
    b: '5e1b0000-0000-4000-8000-000000000012',
  } as const;
  let folder: string;
  let store: Store;
  let workspaces: WorkspaceStore;
  let cleanup: WorkspaceCleanup;
  /** The trees cleanup was asked to remove, in order. */
  let removed: string[];
  let documents: Documents;
  let commit: Committer;
  /** What each tree holds now, as cleanup would read it: b's work not committed, a's nothing. */
  const holds = (tree: WorktreeRecord): TreeState => ({
    workspace: tree.id,
    head: 'a'.repeat(40),
    tip: 'a'.repeat(40),
    changed: tree.id === TREES.b ? 1 : 0,
    untracked: 0,
    paths: tree.id === TREES.b ? ['notes.md'] : [],
    merged: true,
    writers: [],
    setup: false,
    status: tree.id,
  });

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'corrallm-bypass-workspaces-'));
    store = await openTestStore(folder);
    const memory = new CanvasMemory(store);
    workspaces = new WorkspaceStore({ store });
    cleanup = new WorkspaceCleanup({
      workspaces,
      git: new GitRunner({ environment: () => Promise.resolve({}), hooks: path.join(folder, 'h') }),
    });
    vi.spyOn(cleanup, 'assess').mockImplementation((tree) => Promise.resolve(holds(tree)));
    removed = [];
    vi.spyOn(cleanup, 'remove').mockImplementation((workspace) => {
      removed.push(workspace);
      return Promise.resolve('removed');
    });
    documents = new Documents({
      store,
      memory,
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
      workspaces: new WorkspacePlanner({ workspaces, cleanup }),
    });
    await commitDocument(documents, BUILT, { ...documents.read(JSON.stringify(MAIN)), id: BUILT });
    await workspaces.write((w) => {
      w.addRepository({
        id: REPOSITORY,
        pickedRoot: '/work/app',
        realRoot: '/work/app',
        commonDir: '/work/app/.git',
        identity: 'bypass repository',
        rootKind: 'project',
        ownedRoot: '/work/app/.corral/worktrees/p',
      });
      w.bindCanvas(BUILT, REPOSITORY);
      for (const [id, owner] of [
        [TREES.lead, 'group/lead'],
        [TREES.a, 'agent/a'],
        [TREES.b, 'agent/b'],
      ] as const) {
        w.createWorktree({
          id,
          canvas: BUILT,
          repository: REPOSITORY,
          owner,
          path: `/work/app/.corral/worktrees/p/${id}`,
          branchRef: `refs/heads/corrallm/p/${id}`,
          baseCheckout: '/work/app',
          baseRef: 'refs/heads/main',
          baseOid: 'a'.repeat(40),
          forkedFrom: null,
        });
        w.transition(id, { from: 'creating', to: 'setup' });
        w.transition(id, { from: 'setup', to: 'ready' });
      }
      for (const one of ['lead', 'helper', 'member']) w.bind(BUILT, one, TREES.lead);
      w.bind(BUILT, 'a', TREES.a);
      w.bind(BUILT, 'b', TREES.b);
    });
    commit = committer({
      documents,
      propose: () => Promise.resolve(PROPOSAL),
      rules: changeChecks({
        catalog: CATALOG,
        defaultAdapter: DEFAULT_ADAPTER,
        held: () => new Set(),
        created: (party, canvas, removing) => documents.created(party, canvas, removing),
        maxCreated: () => 8,
      }),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await rm(folder, { recursive: true, force: true });
  });

  /** Commits what `edit` makes of the document, as `caller`, through `op` (one that may ask). */
  function build(
    edit: (document: CanvasDocument) => CanvasDocument,
    caller: Caller = OUTSIDE,
    op = 'canvas.batch',
  ) {
    return commit(BUILT, (document) => ({ next: edit(document), result: {} }), {
      op,
      proposes: op === 'canvas.batch' || op === 'canvas.delete',
      caller,
      party: partyOf(caller, isLead),
      by: partyIdOf(caller),
      signal: new AbortController().signal,
      noReturn: () => undefined,
    });
  }
  const without =
    (...ids: string[]) =>
    (document: CanvasDocument): CanvasDocument => ({
      ...document,
      nodes: document.nodes.filter((one) => !ids.includes(one.id)),
      links: document.links.filter(
        ({ source, target }) => !ids.includes(source) && !ids.includes(target),
      ),
    });
  /** `ids` put inside `parent`, which comes before them, as a document keeps its nodes. */
  const under =
    (parent: string, ...ids: string[]) =>
    (document: CanvasDocument): CanvasDocument => {
      const container = document.nodes.find((one) => one.id === parent);
      const rest = document.nodes
        .filter((one) => one.id !== parent)
        .map((one) => (ids.includes(one.id) ? { ...one, parentId: parent } : one));
      return { ...document, nodes: container === undefined ? rest : [container, ...rest] };
    };
  const renamed = (document: CanvasDocument): CanvasDocument => ({
    ...document,
    nodes: document.nodes.map((one) =>
      one.id === 'c' && one.type === 'agent'
        ? { ...one, data: { ...one.data, label: 'Sea' } }
        : one,
    ),
  });
  const binding = (agent: string) => workspaces.binding(BUILT, agent);

  it('asks you, yours too, before leaving a tree that holds work with no agent', async () => {
    const before = documents.live(BUILT).rev;
    const b = binding('b');
    for (const caller of [OUTSIDE, YOU]) {
      await expect(build((document) => renamed(without('b')(document)), caller)).resolves.toEqual({
        proposed: PROPOSAL,
      });
      expect(documents.live(BUILT).rev).toBe(before);
      expect(binding('b')).toEqual(b);
      expect(workspaces.worktree(TREES.b)?.state).toBe('ready');
    }
    expect(removed).toEqual([]);
  });

  it('refuses it rather than apply it through an op that can’t ask, yours too', async () => {
    const before = documents.live(BUILT).rev;
    await expect(build(without('b'), YOU, 'canvas.move')).rejects.toMatchObject({
      code: 'refused',
      message: /worktree that holds work.*can’t ask/,
    });
    await expect(build(without('b'), OUTSIDE, 'canvas.move')).rejects.toMatchObject({
      code: 'refused',
    });
    expect(documents.live(BUILT).rev).toBe(before);
    expect(binding('b')?.workspace).toBe(TREES.b);
  });

  it('removes a clean, merged tree with its last agent, yours, without asking', async () => {
    await expect(build(without('a'), YOU)).resolves.toMatchObject({
      rev: expect.any(Number) as number,
    });
    expect(binding('a')).toBeUndefined();
    expect(workspaces.worktree(TREES.a)?.state).toBe('removing');
    expect(removed).toEqual([TREES.a]);
  });

  it('never moves an agent working in a tree: a token’s frame, or your manager, leaves it waiting for your Switch', async () => {
    const [a, b] = [binding('a'), binding('b')];
    // Frames are free to a token: the document changes, who works where waits for you.
    await expect(
      build((document) => renamed(under('loose', 'a', 'b')(document))),
    ).resolves.toMatchObject({ rev: expect.any(Number) as number });
    expect(binding('a')).toMatchObject({ workspace: TREES.a, generation: a?.generation });
    expect(binding('b')).toMatchObject({
      workspace: TREES.b,
      generation: b?.generation,
      desired: { owner: 'group/loose' },
    });
    for (const id of Object.values(TREES)) expect(workspaces.worktree(id)?.state).toBe('ready');
    // Yours too: b put under the lead keeps its tree until you switch it.
    await expect(build(under('lead', 'b'), YOU)).resolves.toMatchObject({
      rev: expect.any(Number) as number,
    });
    expect(binding('b')).toMatchObject({
      workspace: TREES.b,
      generation: b?.generation,
      desired: { owner: 'group/lead' },
    });
    expect(
      workspaces
        .bindingsTo(BUILT, TREES.lead)
        .map(({ agent }) => agent)
        .sort(),
    ).toEqual(['helper', 'lead', 'member']);
  });

  it('runs and approves no setup: a new agent joins its group’s tree waiting for setup, still waiting', async () => {
    await workspaces.write((w) => {
      w.transition(TREES.lead, { from: 'ready', to: 'setup' });
      w.offerSetup(TREES.lead, {
        command: 'npm ci',
        source: 'detected',
        specHash: 'b'.repeat(64),
        copyManifestHash: 'c'.repeat(64),
      });
    });
    const setup = workspaces.setup(TREES.lead);
    await build((document) => ({
      ...document,
      nodes: [
        ...document.nodes,
        {
          id: 'joiner',
          type: 'agent',
          parentId: 'lead',
          position: { x: 20, y: 400 },
          data: { label: 'Joiner', adapter: 'codex' },
        },
      ],
    }));
    expect(binding('joiner')?.workspace).toBe(TREES.lead);
    expect(workspaces.setup(TREES.lead)).toEqual(setup);
    expect(workspaces.worktree(TREES.lead)?.state).toBe('setup');
  });
});

describe('proposals', () => {
  it('come only from an op declaring R4, R5 or workspace-safety: no other op’s result can be one', () => {
    for (const name of OP_NAMES) {
      const proposes = ((SURFACE[name] as { rules?: readonly string[] }).rules ?? []).some((rule) =>
        (PROPOSING_RULES as readonly string[]).includes(rule),
      );
      if (proposes) continue;
      expect(OPS[name].output.safeParse({ proposed: PROPOSAL }).success, name).toBe(false);
    }
  });

  it('R4: canvas.save of a document missing agents the file on disk has', async () => {
    const file = path.join(profile, `${CANVAS}.corral`);
    const saved = await readFile(file, 'utf8');
    await applied('canvas.delete', { nodes: ['c'] }, YOU);
    const { proposed } = await applied('canvas.save', {});
    expect(proposed).toMatch(/^proposal\//);
    expect(await proposals()).toContainEqual(
      expect.objectContaining({
        id: proposed,
        title: `"orchestrator" asks to save ${CANVAS}.corral, removing C from its file`,
      }),
    );
    // Nothing is written: the file keeps the agent.
    expect(await readFile(file, 'utf8')).toBe(saved);
    // Yours saves at once; then nothing is lost, and a token's saves too.
    expect(await applied('canvas.save', {}, YOU)).toMatchObject({ name: `${CANVAS}.corral` });
    expect(await readFile(file, 'utf8')).not.toContain('"c"');
    expect(await applied('canvas.save', {})).toMatchObject({ name: `${CANVAS}.corral` });
  });

  it('R4: canvas.close or create {replace} with discard on an edited canvas', async () => {
    await applied('canvas.rename', { node: 'solo', label: 'Edited' }, YOU, SECOND);
    const close = await applied('canvas.close', { discard: true }, OUTSIDE, SECOND);
    const replace = await core.call(
      'canvas.create',
      { replace: { canvas: SECOND, discard: true } },
      OUTSIDE,
    );
    expect(replace).toMatchObject({ ok: true, value: { proposed: expect.any(String) as string } });
    // Neither applied: the canvas stays open, with its edits; no canvas was made.
    expect(core.engines.canvas(SECOND)).toBeDefined();
    expect(node('solo', SECOND).data.label).toBe('Edited');
    expect((await proposals(SECOND)).map(({ id }) => id)).toEqual([
      close.proposed,
      replace.ok && (replace.value as { proposed: string }).proposed,
    ]);
    // Without discard, or on a canvas with no edits, a token closes it at once.
    await applied('canvas.close', {}, OUTSIDE, SECOND);
    expect(core.engines.canvas(SECOND)).toBeUndefined();
    // Yours discards: back to its file.
    await applied('canvas.close', { discard: true }, YOU, SECOND);
    const reverted = await core.call('canvas.get', { canvas: SECOND }, YOU);
    if (!reverted.ok) throw new Error(reverted.error.sentence);
    expect(reverted.value.nodes.map(({ data }) => data.label)).toEqual(['Solo']);
  });

  it('R3: a token’s reply to a file review is refused; yours settles it', async () => {
    const file = path.join(profile, `${CANVAS}.corral`);
    const theirs = JSON.stringify({
      ...MAIN,
      nodes: [...MAIN.nodes, agent('d', { position: { x: 1600, y: 900 } })],
    });
    await writeFile(file, theirs);
    // Checked before a save, which it refuses while it is open.
    expect(await call('canvas.save', {}, YOU)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    const { items } = (await applied('needs', {}, YOU)) as { items: NeedsItem[] };
    const review = items.find((item) => item.kind === 'file');
    if (review === undefined) throw new Error('No file review was raised.');
    // Its choices are yours alone; it is on no agent, which no token reaches, so no token finds it
    // to answer (R3 would refuse it, and the item's `by` too).
    expect(review.choices.every(({ humanOnly }) => humanOnly !== undefined)).toBe(true);
    for (const caller of [OUTSIDE, LEAD]) {
      for (const choice of ['apply', 'keep']) {
        expect(
          await call('reply', { to: review.id, answer: { choice } }, caller),
          `${partyIdOf(caller)}: ${choice}`,
        ).toMatchObject({ ok: false, error: { code: 'not-found' } });
      }
    }
    expect(doc().nodes.some(({ id }) => id === 'd')).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(theirs);
    expect(await call('reply', { to: review.id, answer: { choice: 'apply' } }, YOU)).toMatchObject({
      ok: true,
      value: { outcome: 'applied' },
    });
    expect(node('d')).toBeDefined();
  });
});

/** The proposals waiting for you on the canvas, as `needs` gives them to you. */
async function proposals(canvas: CanvasId = CANVAS): Promise<NeedsItem[]> {
  const { items } = (await applied('needs', {}, YOU, canvas)) as { items: NeedsItem[] };
  return items.filter((item) => item.kind === 'proposal');
}

/** What the party's `wait` returns now, reading on from where it last waited. */
async function waited(caller: Caller = OUTSIDE): Promise<Message[]> {
  const result = await core.call('wait', { timeoutSeconds: 0 }, caller);
  if (!result.ok) throw new Error(result.error.sentence);
  return (result.value as unknown as { messages: Message[] }).messages;
}

/** Proposes, as the outside token, what `name` would do: the proposal's id. */
async function propose(name: OpName, args: object, caller: Caller = OUTSIDE): Promise<string> {
  const before = doc();
  const { proposed } = await applied(name, args, caller);
  expect(proposed).toMatch(/^proposal\//);
  expect(doc()).toBe(before);
  return String(proposed);
}

/** Answers a proposal as you: what reply returned. */
function answer(to: string, choice: 'allow' | 'refuse', caller: Caller = YOU) {
  return call('reply', { to, answer: { choice } }, caller);
}

/** The canvas's last revision as kept: its op, who made it, and who proposed it. */
function lastRevision(): Record<string, unknown> | undefined {
  return readOnDisk(profile, (disk) =>
    disk
      .prepare(
        `SELECT op, by_party, proposed_by FROM revision WHERE canvas_id = ?
         ORDER BY rev DESC LIMIT 1`,
      )
      .get(CANVAS),
  );
}

describe('R4: a token’s delete of an agent comes to you as a proposal', () => {
  it('raises one proposal, deleting nothing, worded with what it would lose', async () => {
    const request = '7b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
    const proposed = await propose('canvas.delete', { nodes: ['b'], request });
    expect(await proposals()).toEqual([
      {
        id: proposed,
        canvas: CANVAS,
        agent: 'b',
        kind: 'proposal',
        for: 'you',
        by: ['you'],
        title: '"orchestrator" asks to delete B: 3 queued tasks and its conversation',
        choices: [
          {
            value: 'allow',
            label: 'Allow',
            description: expect.any(String) as string,
            humanOnly: expect.any(String) as string,
          },
          { value: 'refuse', label: 'Refuse', humanOnly: expect.any(String) as string },
        ],
        answerIn: 'api',
      },
    ]);
    // A repeat of the call is answered as the first was: one proposal still.
    expect(await applied('canvas.delete', { nodes: ['b'], request })).toEqual({ proposed });
    expect(await proposals()).toHaveLength(1);
    // The proposer sees it waiting for you, without its choices.
    const theirs = (await applied('needs', {})) as { items: NeedsItem[] };
    expect(theirs.items).toContainEqual(expect.objectContaining({ id: proposed, choices: [] }));
  });

  it('deletes as you once you allow it, its links going with it; the proposer hears', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['b'] });
    const reply = await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU);
    expect(reply).toMatchObject({ outcome: 'allowed' });
    expect(doc().nodes.some((one) => one.id === 'b')).toBe(false);
    expect(linked('a', 'b')).toBe(false);
    expect(lastRevision()).toEqual({
      op: 'canvas.delete',
      by_party: 'you',
      proposed_by: 'outside:orchestrator',
    });
    expect(await proposals()).toEqual([]);
    expect(await waited()).toContainEqual(
      expect.objectContaining({
        id: reply.id,
        from: 'corrallm',
        to: 'outside:orchestrator',
        kind: 'settled',
        state: 'delivered',
        body: expect.stringContaining(`allowed your proposal ${proposed} to delete B`) as string,
      }),
    );
    // Settled once: a second answer is a conflict.
    expect(await answer(proposed, 'refuse')).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
  });

  it('changes nothing once you refuse it; the proposer hears that too', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['b'] });
    const before = doc();
    const reply = await applied('reply', { to: proposed, answer: { choice: 'refuse' } }, YOU);
    expect(reply).toMatchObject({ outcome: 'refused' });
    expect(doc()).toBe(before);
    expect(await proposals()).toEqual([]);
    expect(await waited()).toContainEqual(
      expect.objectContaining({
        id: reply.id,
        kind: 'settled',
        body: expect.stringMatching(/refused/) as string,
      }),
    );
  });

  it('settles stale, changing nothing, when an entity it touched changed since', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['b'] });
    await applied('canvas.rename', { node: 'b', label: 'Bee' }, YOU);
    const before = doc();
    const reply = await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU);
    expect(reply).toMatchObject({ outcome: 'stale' });
    expect(doc()).toBe(before);
    expect(node('b').data.label).toBe('Bee');
    expect(await proposals()).toEqual([]);
    expect(await waited()).toContainEqual(
      expect.objectContaining({
        id: reply.id,
        kind: 'settled',
        body: expect.stringMatching(/stale/) as string,
      }),
    );
  });

  it.each(['message', 'OK', 'link'] as const)(
    'settles stale when a delete would now remove a newly added %s, across a restart',
    async (what) => {
      const proposed = await propose('canvas.delete', { nodes: ['c'] });
      if (what === 'link') await applied('canvas.link', { a: 'b', b: 'c' }, YOU);
      else
        await applied(
          'queue.add',
          {
            agent: 'c',
            entry: what === 'message' ? { message: 'New work' } : { approve: 'New decision' },
          },
          YOU,
        );
      await core.close();
      core = await start();
      const before = doc();
      expect(
        await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU),
      ).toMatchObject({ outcome: 'stale' });
      expect(doc()).toBe(before);
      expect(await proposals()).toEqual([]);
    },
  );

  it('settles a batch stale when a formerly unrelated row it would now clear changed', async () => {
    const proposed = await propose('canvas.batch', {
      ops: [
        { op: 'canvas.rename', args: { node: 'b', label: 'Bee' } },
        { op: 'canvas.delete', args: { nodes: ['c'] } },
      ],
    });
    await applied(
      'queue.update',
      { agent: 'b', item: 'b1', change: { kind: 'target', target: 'c' } },
      YOU,
    );
    const before = doc();
    expect(
      await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU),
    ).toMatchObject({ outcome: 'stale' });
    expect(doc()).toBe(before);
  });

  it('allows an unrelated edit after a proposal without making the proposal stale', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['c'] });
    await applied('canvas.rename', { node: 'b', label: 'Bee' }, YOU);
    expect(
      await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU),
    ).toMatchObject({ outcome: 'allowed' });
    expect(node('b').data.label).toBe('Bee');
    expect(doc().nodes.some((node) => node.id === 'c')).toBe(false);
  });

  it('keeps a proposal across a restart, to allow then', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['c'] });
    await core.close();
    core = await start();
    expect((await proposals()).map(({ id }) => id)).toEqual([proposed]);
    await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU);
    expect(doc().nodes.some((one) => one.id === 'c')).toBe(false);
  });

  it('proposes nothing a rule refuses: an agent holding an OK, a manager, the caller itself', async () => {
    await refused('canvas.delete', { nodes: ['a'] });
    await refused('canvas.delete', { nodes: ['lead'] });
    await refused('canvas.delete', { nodes: ['lead'] }, LEAD);
    expect(await proposals()).toEqual([]);
  });

  it('proposes a lead’s delete of its team’s agent too', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['helper'] }, LEAD);
    expect(await proposals()).toEqual([
      expect.objectContaining({
        id: proposed,
        title: 'Lead asks to delete Helper: nothing queued',
      }),
    ]);
  });

  it('applies yours at once', async () => {
    await applied('canvas.delete', { nodes: ['b'] }, YOU);
    expect(doc().nodes.some((one) => one.id === 'b')).toBe(false);
    expect(await proposals()).toEqual([]);
  });
});

describe('R4 in a batch: a batch holding a delete is one proposal, or refused whole', () => {
  it('proposes the whole batch, applying none of it; Allow applies it all in one revision', async () => {
    const proposed = await propose('canvas.batch', {
      ops: [
        { op: 'canvas.rename', args: { node: 'c', label: 'Sea' } },
        { op: 'canvas.delete', args: { nodes: ['b'] } },
      ],
    });
    expect(await proposals()).toEqual([
      expect.objectContaining({
        id: proposed,
        agent: 'b',
        title: '"orchestrator" asks to delete B: 3 queued tasks and its conversation',
        detail: expect.stringMatching(/1 other change/) as string,
      }),
    ]);
    const rev = core.engines.canvas(CANVAS)?.document;
    expect(rev).toBeDefined();
    const before = readOnDisk(profile, (disk) =>
      Number(disk.prepare('SELECT rev FROM document WHERE canvas_id = ?').get(CANVAS)?.rev),
    );
    await applied('reply', { to: proposed, answer: { choice: 'allow' } }, YOU);
    expect(node('c').data.label).toBe('Sea');
    expect(doc().nodes.some((one) => one.id === 'b')).toBe(false);
    expect(linked('a', 'b')).toBe(false);
    const after = readOnDisk(profile, (disk) =>
      Number(disk.prepare('SELECT rev FROM document WHERE canvas_id = ?').get(CANVAS)?.rev),
    );
    expect(after).toBe(before + 1);
    expect(lastRevision()).toEqual({
      op: 'canvas.batch',
      by_party: 'you',
      proposed_by: 'outside:orchestrator',
    });
  });

  it('refuses a batch mixing a refusal and a delete, rather than proposing it', async () => {
    const said = await refused('canvas.batch', {
      ops: [
        { op: 'canvas.delete', args: { nodes: ['b'] } },
        { op: 'canvas.link', args: { a: 'a', b: 'c' } },
      ],
    });
    expect(said).toMatch(/links A and C/);
    expect(await proposals()).toEqual([]);
  });

  it('proposes a batch whose delete takes links between agents that existed with it', async () => {
    await propose('canvas.batch', {
      ops: [{ op: 'canvas.delete', args: { nodes: ['b'], links: [{ a: 'a', b: 'b' }] } }],
    });
  });
});

describe('R3: only you answer a proposal', () => {
  it('refuses a token’s reply to a proposal, whichever it chooses; yours settles it', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['helper'] }, LEAD);
    for (const caller of [OUTSIDE, LEAD]) {
      for (const choice of ['allow', 'refuse'] as const) {
        expect(await answer(proposed, choice, caller)).toMatchObject({
          ok: false,
          error: { code: 'refused', sentence: expect.stringMatching(/only the user/i) as string },
        });
      }
    }
    expect(node('helper')).toBeDefined();
    expect(await answer(proposed, 'refuse')).toMatchObject({ ok: true });
  });

  it('refuses a choice the item doesn’t offer, and an item that isn’t there', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['b'] });
    expect(await call('reply', { to: proposed, answer: { choice: 'maybe' } }, YOU)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    const missing = 'proposal/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a00';
    for (const caller of [YOU, OUTSIDE]) {
      expect(await answer(missing, 'allow', caller)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
    }
  });
});

describe('a token’s repeated request', () => {
  it('gets its first result though what it deleted is gone; anything else naming it finds nothing', async () => {
    const request = '6a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a70';
    const first = await call('canvas.delete', { nodes: ['loose'], request }, OUTSIDE);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(doc().nodes.some(({ id }) => id === 'loose')).toBe(false);
    // The client's retry, as an MCP client retries a call whose answer it lost.
    expect(await call('canvas.delete', { nodes: ['loose'], request }, OUTSIDE)).toEqual(first);
    // A call of no request, another token's of the same id, or this token's of the same id and
    // another node, each its own call.
    for (const [args, caller] of [
      [{ nodes: ['loose'] }, OUTSIDE],
      [{ nodes: ['loose'], request }, RENEWED],
      [{ nodes: ['loose', 'spare'], request }, OUTSIDE],
    ] as const) {
      expect(await call('canvas.delete', args, caller)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
    }
    expect(doc().nodes.some(({ id }) => id === 'spare')).toBe(true);
  });
});

describe('canvas.batch: every rule on the whole, each inner op checked as its own call', () => {
  it('gives an agent a role in the commit that adds it; never one that existed, nor a mode', async () => {
    const { results } = (await applied('canvas.batch', {
      ops: [
        { op: 'canvas.addAgent', args: { at: { x: 2000, y: 0 }, adapter: 'codex', role: 'Tests' } },
        { op: 'canvas.addAgent', args: { at: { x: 2400, y: 0 }, adapter: 'codex' } },
      ],
    })) as { results: { id: string }[] };
    const [made] = results;
    expect(node(String(made?.id)).data.role).toBe('Tests');
    // A later commit's role is refused, in a batch as alone.
    for (const name of ['agent.setRole'] as const) {
      await refused('canvas.batch', {
        ops: [{ op: name, args: { agent: String(made?.id), role: 'Approves everything' } }],
      });
    }
    await refused('canvas.batch', {
      ops: [
        { op: 'canvas.rename', args: { node: 'c', label: 'Sea' } },
        { op: 'agent.setRole', args: { agent: 'a', role: 'Approves everything' } },
      ],
    });
    await refused('canvas.batch', {
      ops: [
        {
          op: 'agent.setSettings',
          args: { agent: String(made?.id), adapter: 'codex', settings: { mode: 'plan' } },
        },
      ],
    });
    await refused('canvas.batch', {
      ops: [
        {
          op: 'agent.setSettings',
          args: { agent: 'a', adapter: 'codex', settings: { mode: null } },
        },
      ],
    });
    expect(node('c').data.label).toBe('C');
  });

  it('refuses a batch holding agent.setConnection, yours alone, or a link or unlink between agents that exist', async () => {
    const before = doc();
    expect(
      await call(
        'canvas.batch',
        {
          ops: [{ op: 'agent.setConnection', args: { agent: 'b', connection: 'codex.terminal' } }],
        },
        OUTSIDE,
      ),
    ).toMatchObject({ ok: false, error: { code: 'human-only' } });
    expect(doc()).toBe(before);
    await refused('canvas.batch', { ops: [{ op: 'canvas.link', args: { a: 'a', b: 'c' } }] });
    await refused('canvas.batch', { ops: [{ op: 'canvas.unlink', args: { a: 'a', b: 'b' } }] });
    // A link to an agent it creates is a token's to make.
    const { results } = (await applied('canvas.batch', {
      ops: [{ op: 'canvas.spawnAgent', args: { from: 'c', relation: 'linked' } }],
    })) as { results: { id: string }[] };
    expect(linked('c', String(results[0]?.id))).toBe(true);
    // Yours, all of it.
    await applied(
      'canvas.batch',
      {
        ops: [
          { op: 'agent.setConnection', args: { agent: 'b', connection: 'codex.terminal' } },
          { op: 'canvas.link', args: { a: 'a', b: 'c' } },
        ],
      },
      YOU,
    );
    expect(node('b').data.connection).toBe('codex.terminal');
    expect(linked('a', 'c')).toBe(true);
  });

  it('checks each inner op as the caller’s own: an agent at itself, an id out of its reach', async () => {
    expect(
      await refused(
        'canvas.batch',
        { ops: [{ op: 'agent.setRole', args: { agent: 'lead', role: 'Mine' } }] },
        LEAD,
      ),
    ).toMatch(/itself/);
    expect(
      await call(
        'canvas.batch',
        { ops: [{ op: 'canvas.rename', args: { node: 'a', label: 'Mine' } }] },
        LEAD,
      ),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('refuses what the run holds for you and any OK, in a batch as alone', async () => {
    await refused('canvas.batch', {
      ops: [
        { op: 'queue.add', args: { agent: 'a', entry: { message: 'Fine' } } },
        { op: 'queue.remove', args: { agent: 'a', item: 'ok' } },
      ],
    });
    expect(ids('a')).toEqual(['first', 'ok', 'after', 'check']);
  });
});

it('rechecks reach before returning a repeated conflict with current rows', async () => {
  const args = {
    node: 'helper',
    label: 'Renamed',
    expect: { 'node/helper': 0 },
    request: '6a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a71',
  };
  const first = await call('canvas.rename', args, LEAD);
  expect(first).toMatchObject({
    ok: false,
    error: { code: 'conflict', current: { 'node/helper': { value: { label: 'Helper' } } } },
  });
  await applied('canvas.ungroup', { nodes: ['helper'] }, YOU);
  expect(await call('canvas.rename', args, LEAD)).toMatchObject({
    ok: false,
    error: { code: 'not-found' },
  });
});

describe('proposal defaults and bounds', () => {
  it.each(['parent', 'authorship'])(
    'keeps a lead’s template %s when its batch is allowed after a restart',
    async (field) => {
      const proposed = await propose(
        'canvas.batch',
        {
          ops: [
            {
              op: 'canvas.insertTemplate',
              args: { template: TEMPLATE, values: { feature: 'Keep this authorship' } },
            },
            { op: 'canvas.delete', args: { nodes: ['helper'] } },
          ],
        },
        LEAD,
      );
      await core.close();
      core = await start();
      expect(await answer(proposed, 'allow')).toMatchObject({
        ok: true,
        value: { outcome: 'allowed' },
      });
      const group = doc().nodes.find(
        (one) => one.type === 'frame' && one.data.label === 'Spec and implementation',
      );
      expect(group).toBeDefined();
      if (field === 'parent') expect(group?.parentId).toBe('lead');
      else {
        const filled = doc()
          .nodes.flatMap((one) => (one.type === 'agent' ? (one.data.queue ?? []) : []))
          .find((item) => 'message' in item && item.message.includes('Keep this authorship'));
        expect(filled).toMatchObject({ by: 'agent:lead' });
      }
      expect(lastRevision()).toMatchObject({ by_party: 'you', proposed_by: 'agent:lead' });
    },
  );

  it('deduplicates identical pending deletes without request ids, across renewal and restart', async () => {
    const proposed = await propose('canvas.delete', { nodes: ['b'] });
    for (let i = 0; i < MAX_OPEN_PROPOSALS + 8; i++)
      expect(await propose('canvas.delete', { nodes: ['b'] }, RENEWED)).toBe(proposed);
    expect(await proposals()).toHaveLength(1);
    await core.close();
    core = await start();
    expect(await propose('canvas.delete', { nodes: ['b'] }, RENEWED)).toBe(proposed);
    expect(await proposals()).toHaveLength(1);
    // A changed baseline is a different proposal; a settled one is never reused.
    await applied('canvas.rename', { node: 'b', label: 'Bee' }, YOU);
    const fresh = await propose('canvas.delete', { nodes: ['b'] });
    expect(fresh).not.toBe(proposed);
    expect(await answer(fresh, 'refuse')).toMatchObject({ ok: true });
    expect(await propose('canvas.delete', { nodes: ['b'] })).not.toBe(fresh);
  });

  it('caps distinct open proposals per party and canvas and frees a settled slot', async () => {
    const pending: string[] = [];
    const args = (i: number) => ({
      ops: [
        { op: 'canvas.rename', args: { node: 'c', label: `Choice ${String(i)}` } },
        { op: 'canvas.delete', args: { nodes: ['b'] } },
      ],
    });
    for (let i = 0; i < MAX_OPEN_PROPOSALS; i++)
      pending.push(await propose('canvas.batch', args(i)));
    await core.close();
    core = await start();
    await refused('canvas.batch', args(MAX_OPEN_PROPOSALS), RENEWED);
    expect(await proposals()).toHaveLength(MAX_OPEN_PROPOSALS);
    // A repeat still works at the cap, and other parties/canvases have separate budgets.
    expect(await propose('canvas.batch', args(0), RENEWED)).toBe(pending[0]);
    await propose('canvas.delete', { nodes: ['helper'] }, LEAD);
    await applied('canvas.delete', { nodes: ['solo'] }, OUTSIDE, SECOND);
    expect(await answer(String(pending[0]), 'refuse')).toMatchObject({ ok: true });
    await propose('canvas.batch', args(MAX_OPEN_PROPOSALS), RENEWED);
  });
});

/*
 * Over real worktrees, through core.call: the canvas's project a real repository, `lead`'s group
 * (the lead, the helper, the member) working in one tree, waiting for its setup; `a` and `b` each
 * in one of their own, ready, b's holding work not committed; and `c`, moved out of the lead's
 * group while it worked there, its move waiting for your Switch (still in the lead's tree).
 */
describe('workspace-safety and the worktree list, over real worktrees', () => {
  let made: TestWorkspaces;
  let wcore: Core;
  let trees: Record<'lead' | 'a' | 'b', WorktreeRecord>;

  beforeEach(async () => {
    made = await testWorkspaces();
    await made.store.write(() => {
      new CanvasMemory(made.store).ensure(CANVAS);
    });
    const repository = await made.repository();
    const make = async (owner: `${'agent' | 'group'}/${string}`) =>
      made.provisioner.provision({ canvas: CANVAS, repository, owner });
    trees = { lead: await make('group/lead'), a: await make('agent/a'), b: await make('agent/b') };
    await made.workspaces.write((w) => {
      w.bindCanvas(CANVAS, repository.id);
      for (const id of [trees.a.id, trees.b.id]) w.transition(id, { from: 'setup', to: 'ready' });
      for (const one of ['lead', 'helper', 'member']) w.bind(CANVAS, one, trees.lead.id);
      w.bind(CANVAS, 'a', trees.a.id);
      w.bind(CANVAS, 'b', trees.b.id);
      w.bind(CANVAS, 'c', trees.lead.id);
      w.plan(CANVAS, 'c', 'agent/c');
    });
    writeFileSync(path.join(trees.b.path, 'notes.md'), 'B’s work, not committed\n');
    await made.store.close();
    const file = path.join(made.root, 'main.corral');
    await writeFile(file, JSON.stringify(MAIN));
    await keepCanvases(made.profile, { [CANVAS]: { file, project: made.app } });
    wcore = await createCore(
      {
        profile: made.profile,
        app: { name: 'corrallm', version: '1.0.0' },
        check: true,
        distribution: 'local',
        leads: isLead,
        limitsClock: () => (clock += 1000),
        sessions: {
          connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
          environment: () => Promise.resolve(made.env),
        },
      },
      NO_DESKTOP,
    );
    await wcore.engines.open(CANVAS);
  });
  afterEach(async () => {
    await wcore.close();
    rmSync(made.root, { recursive: true, force: true });
  });

  const wcall = (name: OpName, args: object, caller: Caller) =>
    wcore.call(name, { canvas: CANVAS, ...args }, caller);
  async function done(
    name: OpName,
    args: object,
    caller: Caller,
  ): Promise<Record<string, unknown>> {
    const result = await wcall(name, args, caller);
    if (!result.ok) throw new Error(`${name}: ${result.error.sentence}`);
    return result.value as Record<string, unknown>;
  }
  const listed = async (caller: Caller = YOU, args: object = {}) =>
    (await done('worktree.list', args, caller)) as unknown as WorktreeListing;
  const itemOf = async (agent: string, caller: Caller = YOU) =>
    (await listed(caller)).items.find((item) => item.agent === agent);
  const wdoc = (): CanvasDocument => {
    const open = wcore.engines.canvas(CANVAS);
    if (!open) throw new Error('The canvas is not open.');
    return open.document;
  };
  const has = (id: string) => wdoc().nodes.some((one) => one.id === id);
  const lead = LEAD;

  it('asks you before a delete leaves a tree holding work with no agent, a token’s and yours, and keeps it on Delete', async () => {
    const before = wdoc();
    const theirs = await done('canvas.delete', { nodes: ['b'] }, OUTSIDE);
    expect(theirs.proposed).toMatch(/^proposal\//);
    expect(wdoc()).toBe(before);
    const { items } = (await done('needs', {}, YOU)) as { items: NeedsItem[] };
    expect(JSON.stringify(items.find((item) => item.id === theirs.proposed))).toMatch(/notes\.md/);
    expect(await itemOf('b')).toMatchObject({ workspace: trees.b.id, state: 'ready' });
    // Yours asks too, deleting nothing until you choose.
    const yours = await done('canvas.delete', { nodes: ['b'] }, YOU);
    expect(yours.proposed).toMatch(/^proposal\//);
    expect(has('b')).toBe(true);
    expect(
      await wcall('reply', { to: yours.proposed, answer: { choice: 'allow' } }, YOU),
    ).toMatchObject({ ok: true, value: { outcome: 'allowed' } });
    expect(has('b')).toBe(false);
    // Delete, keep its work: in Kept worktrees, its checkout and its work as they were.
    expect((await listed()).kept).toContainEqual(
      expect.objectContaining({ workspace: trees.b.id, state: 'retained', location: trees.b.path }),
    );
    expect(existsSync(path.join(trees.b.path, 'notes.md'))).toBe(true);
  });

  it('asks for a whole batch leaving one, a token’s and yours, applying none of it', async () => {
    const ops = [
      { op: 'canvas.rename', args: { node: 'c', label: 'Sea' } },
      { op: 'canvas.delete', args: { nodes: ['b'] } },
    ];
    for (const caller of [OUTSIDE, YOU]) {
      const before = wdoc();
      expect((await done('canvas.batch', { ops }, caller)).proposed).toMatch(/^proposal\//);
      expect(wdoc()).toBe(before);
    }
    expect(await itemOf('b')).toMatchObject({ workspace: trees.b.id, state: 'ready' });
  });

  it('removes a clean, merged tree with its last agent without asking you, yours', async () => {
    expect(await done('canvas.delete', { nodes: ['a'] }, YOU)).not.toHaveProperty('proposed');
    expect(has('a')).toBe(false);
    await vi.waitFor(
      async () => {
        expect(existsSync(trees.a.path)).toBe(false);
        expect((await listed()).kept).toEqual([]);
      },
      { timeout: 10_000, interval: 50 },
    );
  });

  it.each([
    ['alone', 'canvas.group', { nodes: ['a', 'b'], kind: 'frame' }],
    [
      'in a batch',
      'canvas.batch',
      {
        ops: [
          { op: 'canvas.rename', args: { node: 'c', label: 'Sea' } },
          { op: 'canvas.group', args: { nodes: ['a', 'b'], kind: 'frame' } },
        ],
      },
    ],
  ] as const)(
    'never moves an agent working in a tree: a token’s frame around two, %s, waits for your Switch',
    async (_how, name, args) => {
      const { revs } = await done(name, args, OUTSIDE);
      // Who works where changed with the document: its revision is said, though no window watches.
      expect(revs).toMatchObject({ [`worktrees:${CANVAS}`]: expect.any(Number) as number });
      // The first member's tree becomes the group's; the other keeps its own until you switch it.
      const [a, b] = [await itemOf('a'), await itemOf('b')];
      expect(a).toMatchObject({ workspace: trees.a.id, mode: 'group', state: 'ready' });
      expect(b).toMatchObject({ workspace: trees.b.id, mode: 'own', state: 'pending-change' });
      expect(b?.need).toMatch(/^rebind\//);
      expect((await listed()).kept).toEqual([]);
      expect(existsSync(path.join(trees.b.path, 'notes.md'))).toBe(true);
    },
  );

  it('joins a token’s new agent to its group’s tree at once, running and approving no setup', async () => {
    await vi.waitFor(async () => {
      expect((await itemOf('lead'))?.need).toMatch(/^setup\//);
    });
    const before = await itemOf('lead');
    const { id } = await done('canvas.spawnAgent', { from: 'helper', relation: 'peer' }, OUTSIDE);
    const joined = await itemOf(String(id));
    expect(joined).toMatchObject({ workspace: trees.lead.id, state: 'setup', need: before?.need });
    expect(joined?.setup).toEqual(before?.setup);
    expect(before?.setup?.state).toBe('pending');
  });

  it('keeps what a file’s Apply leaves holding work, asking nothing more of it', async () => {
    const file = path.join(made.root, 'main.corral');
    await writeFile(
      file,
      JSON.stringify({ ...MAIN, nodes: MAIN.nodes.filter((one) => one.id !== 'b'), links: [] }),
    );
    expect(await wcall('canvas.save', {}, YOU)).toMatchObject({ ok: false });
    const { items } = (await done('needs', {}, YOU)) as { items: NeedsItem[] };
    const review = items.find((item) => item.kind === 'file');
    if (review === undefined) throw new Error('No file review was raised.');
    const applied = await wcall('reply', { to: review.id, answer: { choice: 'apply' } }, YOU);
    expect(applied, JSON.stringify(applied)).toMatchObject({
      ok: true,
      value: { outcome: 'applied' },
    });
    expect(has('b')).toBe(false);
    expect((await listed()).kept).toContainEqual(
      expect.objectContaining({ workspace: trees.b.id, state: 'retained' }),
    );
    expect(existsSync(path.join(trees.b.path, 'notes.md'))).toBe(true);
  });

  it('lists to a lead only the agents it reaches: a member of its tree it doesn’t reach is never named', async () => {
    const theirs = await listed(lead);
    expect(theirs.items.map((item) => item.agent)).toEqual(['lead', 'helper', 'member']);
    expect(theirs.kept).toEqual([]);
    for (const item of theirs.items) {
      expect(item).toMatchObject({ workspace: trees.lead.id, mode: 'group', group: 'lead' });
      for (const field of ['need', 'error', 'location', 'setup'])
        expect(item).not.toHaveProperty(field);
    }
    // C still works in the lead's tree, its move waiting: the lead never learns it.
    expect(await wcall('worktree.list', { agent: 'c' }, lead)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    // The outside token reaches the whole canvas: c, in the lead's tree, waiting; no card named.
    const c = await itemOf('c', OUTSIDE);
    expect(c).toEqual({
      agent: 'c',
      mode: 'group',
      group: 'lead',
      workspace: trees.lead.id,
      generation: expect.any(Number) as number,
      branch: trees.lead.branchRef.slice('refs/heads/'.length),
      base: { ref: trees.lead.baseRef, oid: trees.lead.baseOid },
      state: 'pending-change',
    });
  });

  it('reads reach afresh: linked, an agent is listed to the lead; unlinked, or deleted, it isn’t', async () => {
    expect((await listed(lead)).items.map((item) => item.agent)).not.toContain('a');
    await done('canvas.link', { a: 'lead', b: 'a' }, YOU);
    expect((await listed(lead)).items.map((item) => item.agent)).toContain('a');
    await done('canvas.unlink', { a: 'lead', b: 'a' }, YOU);
    expect((await listed(lead)).items.map((item) => item.agent)).not.toContain('a');
    await done('canvas.delete', { nodes: ['a'] }, YOU);
    expect((await listed(OUTSIDE)).items.map((item) => item.agent)).not.toContain('a');
  });
});
