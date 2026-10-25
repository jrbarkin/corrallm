import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../../shared/api/errors';
import {
  MAX_CREATED_AGENTS,
  MAX_CREATED_CANVASES,
  MAX_MESSAGE_BYTES,
} from '../../../shared/api/limits';
import type { OpName } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { NeedsItem } from '../../../shared/model/needs';
import type { QueueItem } from '../../../shared/model/queue';
import { FakeConnector } from '../../sessions/fake';
import { SessionManager } from '../../sessions/manager';
import type { Caller, OutsideCaller } from '../caller';
import { createCore } from '../core';
import type { Core } from '../core';
import { asHuman } from '../gui';
import { mintTrustedPath } from '../host';
import type { HostServices } from '../host';
import { keepCanvases, readOnDisk } from '../store/test-store';
import { CALLERS, NO_DESKTOP } from '../test-registry';
import { TEMPLATE } from '../test-world';

/*
 * A canvas's lifetime, end to end (Core Server §4 B, B9 Design §1, §2, §5, §8): canvas.create,
 * canvas.open, canvas.save, canvas.saveAs, canvas.close and project.choose, as you and as an outside
 * write token, on a profile keeping two canvases, each in a file of its own with a project folder,
 * the first open in the core: `team` (agents `lead` and `worker`) and `other` (agent `solo`). The
 * dialogs answer as each test scripts them; unscripted, they are cancelled.
 */

const TEAM = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01' as CanvasId;
const OTHER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02' as CanvasId;
const YOU = CALLERS.you;
/** The outside write token, granted both canvases. */
const TOKEN: OutsideCaller = {
  ...(CALLERS['outside-write'] as OutsideCaller),
  canvases: [TEAM, OTHER],
};
/** A second window of yours. */
const ELSEWHERE = asHuman(2);

const agent = (id: string, x = 0) => ({
  id,
  kind: 'agent',
  label: id.charAt(0).toUpperCase() + id.slice(1),
  position: { x, y: 0 },
  adapter: 'codex',
  connection: 'codex.app-server',
});
const fileOf = (id: CanvasId, agents: string[]) => ({
  format: 'corrallm',
  version: 2,
  id,
  nodes: agents.map((one, i) => agent(one, i * 400)),
  links: [],
});

let profile: string;
let core: Core;
/** What each dialog answers next: a path picked, or null (cancelled). */
let answers: { open: (string | null)[]; save: (string | null)[]; folder: (string | null)[] };
let files: Record<'team' | 'other', string>;
let cap = 8;

const host: HostServices = {
  ...NO_DESKTOP,
  pickCanvasToOpen: () => Promise.resolve(picked(answers.open)),
  pickCanvasToSave: () => Promise.resolve(picked(answers.save)),
  pickFolder: () => Promise.resolve(picked(answers.folder)),
};
function picked(queue: (string | null)[]) {
  const next = queue.shift() ?? null;
  return next === null ? null : mintTrustedPath(next);
}

async function start(): Promise<Core> {
  const started = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      maxCreatedAgents: () => cap,
      limitsClock: (() => {
        let now = 0;
        return () => (now += 1000);
      })(),
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    host,
  );
  await started.engines.open(TEAM);
  return started;
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-files-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  files = { team: path.join(profile, 'team.corral'), other: path.join(profile, 'other.corral') };
  await writeFile(files.team, JSON.stringify(fileOf(TEAM, ['lead', 'worker'])));
  await writeFile(files.other, JSON.stringify(fileOf(OTHER, ['solo'])));
  await keepCanvases(profile, {
    [OTHER]: { file: files.other, project },
    [TEAM]: { file: files.team, project },
  });
  answers = { open: [], save: [], folder: [] };
  cap = 8;
  core = await start();
});
afterEach(async () => {
  await core.close();
  await rm(profile, { recursive: true, force: true });
});

async function call(name: OpName, args: object, caller: Caller = YOU): Promise<OpResult<unknown>> {
  return core.call(name, args, caller);
}
/** Calls `name`, expecting it to apply: its result. */
async function applied(
  name: OpName,
  args: object,
  caller: Caller = YOU,
): Promise<Record<string, unknown>> {
  const result = await call(name, args, caller);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value as Record<string, unknown>;
}
/** A canvas's document, as canvas.get gives it to you. */
async function documentOf(canvas: CanvasId): Promise<CanvasDocument> {
  const state = (await applied('canvas.get', { canvas })) as unknown as {
    nodes: CanvasDocument['nodes'];
    links: CanvasDocument['links'];
  };
  return { id: canvas, arrange: false, nodes: state.nodes, links: state.links };
}
/** The canvases the core keeps, as canvas.list gives them to `caller`, by id. */
async function listed(caller: Caller = YOU) {
  const { items } = (await applied('canvas.list', {}, caller)) as {
    items: {
      canvas: string;
      name: string | null;
      edited: boolean;
      open: boolean;
      shownIn: number[];
    }[];
  };
  return Object.fromEntries(items.map((item) => [item.canvas, item]));
}
/** The proposals waiting for you on a canvas. */
async function proposals(canvas: CanvasId): Promise<NeedsItem[]> {
  const { items } = (await applied('needs', { canvas })) as { items: NeedsItem[] };
  return items.filter((item) => item.kind === 'proposal');
}
/** Renames a node as you, an edit not saved. */
async function edit(canvas: CanvasId, node: string, label: string): Promise<void> {
  await applied('canvas.get', { canvas });
  await applied('canvas.rename', { canvas, node, label });
}
const createdBy = (canvas: string) =>
  readOnDisk(profile, (disk) =>
    disk.prepare('SELECT created_by FROM document WHERE canvas_id = ?').get(canvas),
  )?.created_by;
const labelsOf = (document: CanvasDocument) => document.nodes.map((node) => node.data.label);
/** The nodes a canvas file's text holds. */
const nodesIn = (text: string) => (JSON.parse(text) as { nodes: unknown[] }).nodes;
/** Agent `id`'s queue in `document`. */
const queueOf = (document: CanvasDocument, id: string): QueueItem[] => {
  const node = document.nodes.find((one) => one.id === id);
  return node?.type === 'agent' ? (node.data.queue ?? []) : [];
};

describe('canvas.create', () => {
  it('caps open canvases by creating party across renewal and restart, freeing a closed slot', async () => {
    const made: CanvasId[] = [];
    for (let i = 0; i < MAX_CREATED_CANVASES; i++) {
      const { canvas } = await applied('canvas.create', {}, TOKEN);
      made.push(canvas as CanvasId);
    }
    await core.close();
    core = await start();
    const renewed: OutsideCaller = { ...TOKEN, token: 'renewed' };
    const before = Object.keys(await listed());
    expect(await call('canvas.create', {}, renewed)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    expect(Object.keys(await listed())).toEqual(before);
    await applied('canvas.create', {}, { ...TOKEN, name: 'other-party' });
    await applied('canvas.create', {}, YOU);
    await applied(
      'canvas.close',
      { canvas: made[0] },
      { ...renewed, canvases: [...renewed.canvases, ...made] },
    );
    // Two concurrent creates cannot both claim the one available slot.
    const results = await Promise.all([
      call('canvas.create', {}, renewed),
      call('canvas.create', {}, renewed),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: 'refused' } },
    ]);
    // Replacing an owned open canvas does not consume another open slot.
    await applied(
      'canvas.create',
      { replace: { canvas: made[1] } },
      { ...renewed, canvases: [...renewed.canvases, ...made] },
    );
    expect((await listed())[String(made[1])]).toMatchObject({ open: false });
  });

  it('bounds the template drafts a token makes and closes: R11 counts their agents for good', async () => {
    cap = MAX_CREATED_AGENTS;
    let reach = TOKEN;
    let refused: OpResult<unknown> | undefined;
    for (let i = 0; i <= MAX_CREATED_CANVASES; i++) {
      const result = await call('canvas.create', { template: TEMPLATE }, reach);
      if (!result.ok) {
        refused = result;
        break;
      }
      const { canvas } = result.value as { canvas: CanvasId };
      reach = { ...reach, canvases: [...reach.canvases, canvas] };
      expect(await applied('canvas.close', { canvas }, reach)).toEqual({ revs: {} });
    }
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
    const kept = readOnDisk(profile, (disk) =>
      disk
        .prepare('SELECT count(*) AS n FROM document WHERE created_by = ?')
        .get('outside:orchestrator'),
    );
    expect(Number(kept?.n)).toBeLessThan(MAX_CREATED_CANVASES);
    expect(Number(kept?.n)).toBeLessThanOrEqual(MAX_CREATED_AGENTS);
  });

  it('makes an empty canvas, open, shown in your window, kept once it holds something', async () => {
    const { canvas } = (await applied('canvas.create', {})) as { canvas: CanvasId };
    expect(await listed()).toMatchObject({
      [canvas]: { name: null, edited: false, open: true, shownIn: [1] },
    });
    expect(createdBy(canvas)).toBeUndefined();
    await applied('canvas.addAgent', { canvas, at: { x: 0, y: 0 }, adapter: 'codex' });
    expect(createdBy(canvas)).toBe('you');
    expect((await listed())[canvas]).toMatchObject({ edited: true });
  });

  it('makes a template’s canvas: its blanks filled, its agents’ adapters chosen, connections each adapter’s first', async () => {
    const { canvas, revs } = (await applied('canvas.create', {
      template: TEMPLATE,
      values: { feature: 'Export CSV' },
      agents: { planner: 'claude-code', builder: 'codex' },
      connections: { builder: 'codex.app-server' },
    })) as { canvas: CanvasId; revs: Record<string, number> };
    expect(revs).toEqual({ [`canvas:${canvas}`]: 1 });
    const document = await documentOf(canvas);
    const byId = Object.fromEntries(document.nodes.map((node) => [node.id, node.data]));
    expect(byId.planner).toMatchObject({
      adapter: 'claude-code',
      connection: 'claude-code.terminal',
    });
    expect(byId.builder).toMatchObject({ adapter: 'codex', connection: 'codex.app-server' });
    expect(byId.reviewer).toMatchObject({ connection: 'claude-code.terminal' });
    const spec = queueOf(document, 'planner').find((item) => item.id === 'spec') as QueueItem & {
      message: string;
    };
    expect(spec.message).toMatch(/\n\nExport CSV$/);
    // Yours: no one's text.
    expect(spec).not.toHaveProperty('by');
  });

  it('keeps the first template canvas and its folder when showing a new template canvas', async () => {
    const { canvas: first } = await applied('canvas.create', { template: TEMPLATE });
    answers.folder.push(profile);
    await applied('project.choose', { canvas: first });
    const { canvas: second } = await applied('canvas.create', { template: TEMPLATE });
    expect(await listed()).toMatchObject({
      [String(first)]: { open: true, edited: true, project: { path: profile }, shownIn: [] },
      [String(second)]: { open: true, edited: true, project: null, shownIn: [1] },
    });
  });

  it('refuses a template there isn’t, or choices it doesn’t have, making nothing', async () => {
    const before = Object.keys(await listed());
    expect(
      await call('canvas.create', { template: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4cff' }),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    for (const args of [
      { template: TEMPLATE, agents: { nobody: 'codex' } },
      { template: TEMPLATE, agents: { planner: 'nothing' } },
      { template: TEMPLATE, connections: { planner: 'codex.terminal' } },
      { values: { feature: 'Export CSV' } },
      // As canvas.insertTemplate refuses them (the one fill): a blank it hasn't, and a value
      // that, filled in among the template's words, passes what a message holds.
      { template: TEMPLATE, values: { nothing: 'Export CSV' } },
      { template: TEMPLATE, values: { feature: 'x'.repeat(MAX_MESSAGE_BYTES) } },
    ]) {
      expect(await call('canvas.create', args), JSON.stringify(args)).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
    }
    expect(Object.keys(await listed())).toEqual(before);
  });

  it('makes a token’s canvas its own: kept as its creator’s, reached by its next calls, shown in no window', async () => {
    const token = await core.tokens.create({
      name: 'orchestrator',
      canvases: [TEAM],
      access: 'write',
    });
    const before = core.clientOf(token);
    expect(before?.canvases).toEqual([TEAM]);
    if (before === undefined) throw new Error('The token isn’t kept.');
    const { canvas } = (await applied('canvas.create', {}, before)) as {
      canvas: CanvasId;
    };
    expect(createdBy(canvas)).toBe('outside:orchestrator');
    expect((await listed())[canvas]).toMatchObject({ open: true, shownIn: [] });
    // Its next call reaches it, as a renewed token of its name does; another party's doesn't.
    const after = core.clientOf(token) as Caller;
    await applied('canvas.addAgent', { canvas, at: { x: 0, y: 0 }, adapter: 'codex' }, after);
    expect(Object.keys(await listed(after))).toEqual(expect.arrayContaining([TEAM, canvas]));
    const renewal = await core.tokens.create({
      name: 'orchestrator',
      canvases: [TEAM],
      access: 'write',
    });
    const renewed = core.clientOf(renewal) as Caller;
    expect((await documentOf(canvas)).nodes).toHaveLength(1);
    await applied('canvas.get', { canvas }, renewed);
    const stranger = core.clientOf(
      await core.tokens.create({ name: 'stranger', canvases: [TEAM], access: 'write' }),
    ) as Caller;
    expect(await call('canvas.get', { canvas }, stranger)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    // Across a restart too.
    await core.close();
    core = await start();
    expect(core.clientOf(renewal)?.canvases).toEqual([TEAM, canvas]);
  });

  it('marks the text a token’s values filled in as the token’s, and checks its agents as R11 does', async () => {
    const { canvas } = (await applied(
      'canvas.create',
      { template: TEMPLATE, values: { feature: 'Export CSV' } },
      TOKEN,
    )) as { canvas: CanvasId };
    const [spec, ok, plan] = queueOf(await documentOf(canvas), 'planner');
    expect(spec).toMatchObject({ id: 'spec', by: 'outside:orchestrator' });
    expect(ok).not.toHaveProperty('by');
    expect(plan).not.toHaveProperty('by');
    expect(
      readOnDisk(profile, (disk) =>
        disk
          .prepare(`SELECT count(*) AS n FROM node WHERE created_by = ? AND kind = 'agent'`)
          .get('outside:orchestrator'),
      ),
    ).toEqual({ n: 3 });

    // A connection other than its adapter's first, or past its party's cap: refused, nothing made.
    const before = Object.keys(await listed());
    const refused = await call(
      'canvas.create',
      {
        template: TEMPLATE,
        agents: { builder: 'codex' },
        connections: { builder: 'codex.app-server' },
      },
      TOKEN,
    );
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
    cap = 3;
    expect(await call('canvas.create', { template: TEMPLATE }, TOKEN)).toMatchObject({
      ok: false,
      error: { code: 'refused', sentence: expect.stringMatching(/at most 3/) as string },
    });
    expect(Object.keys(await listed())).toEqual(before);
  });

  it('replaces a canvas: closed once the new one is made, its edits kept, or discarded', async () => {
    await edit(OTHER, 'solo', 'Edited');
    const { canvas } = (await applied('canvas.create', { replace: { canvas: OTHER } })) as {
      canvas: CanvasId;
    };
    let list = await listed();
    expect(list[OTHER]).toMatchObject({ open: false, edited: true });
    expect(list[canvas]).toMatchObject({ open: true, shownIn: [1] });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Edited']);
    // Discarded: back to its file.
    await applied('canvas.create', { replace: { canvas: OTHER, discard: true } });
    list = await listed();
    expect(list[OTHER]).toMatchObject({ open: false });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Solo']);
    // A draft discarded is forgotten.
    await applied('canvas.addAgent', { canvas, at: { x: 0, y: 0 }, adapter: 'codex' });
    await applied('canvas.create', { replace: { canvas, discard: true } });
    expect((await listed())[canvas]).toBeUndefined();
    expect(await call('canvas.get', { canvas })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });
});

describe('canvas.open', () => {
  it('keeps the runtime and sessions when Open picks the canvas already shown', async () => {
    await applied('window.show', { canvas: OTHER });
    const before = core.engines.canvas(OTHER);
    expect(before).toBeDefined();
    const close = vi.spyOn(SessionManager.prototype, 'closeCanvas');
    try {
      answers.open.push(files.other);
      expect(await applied('canvas.open', {})).toMatchObject({ canvas: OTHER });
      expect(close).not.toHaveBeenCalled();
      expect(core.engines.canvas(OTHER)).toBe(before);
      await expect(core.flush()).resolves.toBeUndefined();
    } finally {
      close.mockRestore();
    }
  });

  it('opens nothing, replacing nothing, when the dialog is cancelled', async () => {
    expect(await applied('canvas.open', { replace: { canvas: TEAM } })).toEqual({
      canvas: null,
      revs: {},
    });
    expect((await listed())[TEAM]).toMatchObject({ open: true });
  });

  it('opens the file picked in your window, its folder restored, closing what it replaces', async () => {
    const { canvas: draft } = (await applied('canvas.create', {})) as { canvas: CanvasId };
    answers.open.push(files.other);
    expect(await applied('canvas.open', { replace: { canvas: draft } })).toMatchObject({
      canvas: OTHER,
    });
    const list = await listed();
    expect(list[OTHER]).toMatchObject({ open: true, shownIn: [1], name: 'other.corral' });
    expect(list[draft]).toBeUndefined();
    expect(core.engines.canvas(TEAM)).toBeDefined();

    // A copy of a canvas kept in another file opens as a canvas of its own.
    const copy = path.join(profile, 'copy.corral');
    await writeFile(copy, await readFile(files.other, 'utf8'));
    answers.open.push(copy);
    const { canvas } = (await applied('canvas.open', {})) as { canvas: CanvasId };
    expect(canvas).not.toBe(OTHER);
    expect((await listed())[canvas]).toMatchObject({ name: 'copy.corral', shownIn: [1] });
  });
});

describe('canvas.save and canvas.saveAs', () => {
  it('saves a canvas to its file, not edited after; one never saved has none to save to', async () => {
    await edit(OTHER, 'solo', 'Saved');
    expect(await applied('canvas.save', { canvas: OTHER }, TOKEN)).toEqual({
      name: 'other.corral',
      revs: {},
    });
    expect(JSON.parse(await readFile(files.other, 'utf8'))).toMatchObject({
      nodes: [expect.objectContaining({ label: 'Saved' })],
    });
    const { canvas } = (await applied('canvas.create', {})) as { canvas: CanvasId };
    expect(await call('canvas.save', { canvas })).toMatchObject({
      ok: false,
      error: { code: 'refused', sentence: expect.stringMatching(/no file yet/) as string },
    });
  });

  it('saves as the file you pick, which becomes its file, the canvas keeping its id', async () => {
    expect(await applied('canvas.saveAs', { canvas: OTHER })).toEqual({ name: null, revs: {} });
    const target = path.join(profile, 'renamed.corral');
    answers.save.push(target);
    expect(await applied('canvas.saveAs', { canvas: OTHER })).toEqual({
      name: 'renamed.corral',
      revs: {},
    });
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ id: OTHER });
    expect((await listed())[OTHER]).toMatchObject({ name: 'renamed.corral' });
  });
});

describe('canvas.close', () => {
  it('closes a canvas: no longer open, its run journaled and its sessions ended, its edits kept', async () => {
    await edit(TEAM, 'lead', 'Head');
    await applied('canvas.close', { canvas: TEAM }, TOKEN);
    expect(core.engines.canvas(TEAM)).toBeUndefined();
    expect((await listed())[TEAM]).toMatchObject({ open: false, edited: true });
    expect(
      readOnDisk(profile, (disk) => disk.prepare('SELECT canvas_id FROM run').all()),
    ).toContainEqual({ canvas_id: TEAM });
    // Opened again, it has its edits.
    answers.open.push(files.team);
    await applied('canvas.open', {});
    expect(labelsOf(await documentOf(TEAM))).toEqual(['Head', 'Worker']);
  });

  it('shows each window that showed it another canvas: the one open used last, else a new one', async () => {
    answers.open.push(files.other);
    await applied('canvas.open', {}, ELSEWHERE);
    answers.open.push(files.other);
    await applied('canvas.open', {});
    expect(await applied('canvas.close', { canvas: OTHER })).toMatchObject({ canvas: TEAM });
    const list = await listed();
    expect(list[OTHER]).toMatchObject({ open: false, shownIn: [] });
    expect(list[TEAM]).toMatchObject({ open: true });
    expect(list[TEAM]?.shownIn.toSorted()).toEqual([1, 2]);
    await applied('canvas.close', { canvas: TEAM });
    const fresh = Object.values(await listed()).filter((item) => item.shownIn.length > 0);
    expect(fresh).toEqual([expect.objectContaining({ name: null, open: true })]);
    expect(fresh[0]?.shownIn.toSorted()).toEqual([1, 2]);
  });

  it('discards a canvas’s edits: back to its file, or a draft forgotten', async () => {
    await edit(OTHER, 'solo', 'Edited');
    await applied('canvas.close', { canvas: OTHER, discard: true });
    expect((await listed())[OTHER]).toMatchObject({ open: false });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Solo']);
    const { canvas } = (await applied('canvas.create', {})) as { canvas: CanvasId };
    await applied('canvas.close', { canvas, discard: true });
    expect((await listed())[canvas]).toBeUndefined();
  });

  it('refuses a canvas the core doesn’t keep', async () => {
    expect(
      await call('canvas.close', { canvas: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4cff' }),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});

describe('window.show', () => {
  it('opens a canvas it shows that isn’t open: open until it is closed, whatever the window shows next', async () => {
    expect((await listed())[OTHER]).toMatchObject({ open: false, shownIn: [] });
    await applied('window.show', { canvas: OTHER });
    expect((await listed())[OTHER]).toMatchObject({ open: true, shownIn: [1] });
    // The window shows another canvas: this one stays open, as any canvas open does.
    await applied('canvas.create', {});
    expect((await listed())[OTHER]).toMatchObject({ open: true, shownIn: [] });
  });
});

describe('R4: what a token may not discard comes to you as a proposal', () => {
  it('proposes a token’s close of a canvas a window shows; Allow closes it', async () => {
    answers.open.push(files.other);
    await applied('canvas.open', {});
    const { proposed } = await applied('canvas.close', { canvas: OTHER }, TOKEN);
    expect(proposed).toMatch(/^proposal\//);
    expect((await listed())[OTHER]).toMatchObject({ open: true, shownIn: [1] });
    expect(await proposals(OTHER)).toEqual([
      expect.objectContaining({
        id: proposed,
        title: '"orchestrator" asks to close other.corral',
        detail: 'Only the user decides: a window shows it.',
      }),
    ]);
    expect(
      await applied('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'allowed', canvas: TEAM });
    expect((await listed())[OTHER]).toMatchObject({ open: false, shownIn: [] });
    expect(await proposals(OTHER)).toEqual([]);
  });

  it('reuses one proposal for a token’s repeated close that leaves discard out', async () => {
    answers.open.push(files.other);
    await applied('canvas.open', {});
    const first = await applied('canvas.close', { canvas: OTHER }, TOKEN);
    const again = await applied('canvas.close', { canvas: OTHER }, TOKEN);
    expect(again.proposed).toBe(first.proposed);
    expect(await proposals(OTHER)).toEqual([expect.objectContaining({ id: first.proposed })]);
  });

  it('proposes a token’s discard of edits not saved; Allow discards them, unless the canvas changed since', async () => {
    await edit(OTHER, 'solo', 'Edited');
    const { proposed } = await applied('canvas.close', { canvas: OTHER, discard: true }, TOKEN);
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Edited']);
    expect(await proposals(OTHER)).toEqual([
      expect.objectContaining({
        title: '"orchestrator" asks to close other.corral, discarding its edits not saved',
      }),
    ]);
    // Edited again since: stale, nothing changed.
    await applied('canvas.rename', { canvas: OTHER, node: 'solo', label: 'Again' });
    expect(
      await applied('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'stale' });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Again']);
    // Proposed anew, then allowed.
    const again = await applied('canvas.close', { canvas: OTHER, discard: true }, TOKEN);
    await applied('reply', { canvas: OTHER, to: again.proposed, answer: { choice: 'allow' } });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Solo']);
    expect((await listed())[OTHER]).toMatchObject({ open: false });
    // A token's discard of what has no edits closes it at once.
    expect(await applied('canvas.close', { canvas: OTHER, discard: true }, TOKEN)).toEqual({
      revs: {},
    });
  });

  it('keeps a token’s close across a restart, with no canvas snapshot: Allow still closes it', async () => {
    await edit(OTHER, 'solo', 'Edited');
    const { proposed } = await applied('canvas.close', { canvas: OTHER, discard: true }, TOKEN);
    await core.close();
    core = await start();
    expect(await proposals(OTHER)).toEqual([expect.objectContaining({ id: proposed })]);
    expect(
      await applied('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'allowed' });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Solo']);
    expect((await listed())[OTHER]).toMatchObject({ open: false });
  });

  it('proposes a token’s replace of a canvas it may not close; refusals still win', async () => {
    await edit(OTHER, 'solo', 'Edited');
    const { proposed } = await applied(
      'canvas.create',
      { replace: { canvas: OTHER, discard: true } },
      TOKEN,
    );
    expect(await proposals(OTHER)).toEqual([
      expect.objectContaining({
        id: proposed,
        title:
          '"orchestrator" asks to replace other.corral with a new canvas, discarding its edits not saved',
      }),
    ]);
    const before = Object.keys(await listed());
    // What R11 refuses is refused, never proposed.
    expect(
      await call(
        'canvas.create',
        {
          template: TEMPLATE,
          agents: { builder: 'codex' },
          connections: { builder: 'codex.app-server' },
          replace: { canvas: OTHER, discard: true },
        },
        TOKEN,
      ),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await proposals(OTHER)).toHaveLength(1);
    // Allowed: made as the token's own, the canvas it replaces discarded and closed.
    await applied('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } });
    const after = await listed();
    const made = Object.keys(after).filter((id) => !before.includes(id));
    expect(made).toHaveLength(1);
    expect(after[OTHER]).toMatchObject({ open: false });
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Solo']);
  });

  it.each([
    ['from a template', { template: TEMPLATE }],
    ['empty', {}],
  ])(
    'keeps a token’s replace, allowed, as the token’s own canvas, %s: in its reach',
    async (_, made) => {
      const token = await core.tokens.create({
        name: 'orchestrator',
        canvases: [OTHER],
        access: 'write',
      });
      const client = core.clientOf(token);
      if (client === undefined) throw new Error('The token isn’t kept.');
      answers.open.push(files.other);
      await applied('canvas.open', {});
      const { proposed } = await applied(
        'canvas.create',
        { ...made, replace: { canvas: OTHER } },
        client,
      );
      const before = Object.keys(await listed());
      expect(
        await applied('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
      ).toMatchObject({ outcome: 'allowed' });
      const canvas = Object.keys(await listed()).find((id) => !before.includes(id));
      if (canvas === undefined) throw new Error('Allow made no canvas.');
      expect(createdBy(canvas)).toBe('outside:orchestrator');
      const after = core.clientOf(token);
      if (after === undefined) throw new Error('The token isn’t kept.');
      expect(after.canvases).toContain(canvas);
      expect(Object.keys(await listed(after))).toContain(canvas);
      await applied('canvas.get', { canvas }, after);
    },
  );

  it('refuses, on Allow, a token’s replace past its cap of open canvases it created', async () => {
    let reach = TOKEN;
    for (let i = 0; i < MAX_CREATED_CANVASES; i++) {
      const { canvas } = (await applied('canvas.create', {}, reach)) as { canvas: CanvasId };
      reach = { ...reach, canvases: [...reach.canvases, canvas] };
    }
    answers.open.push(files.other);
    await applied('canvas.open', {});
    const { proposed } = await applied('canvas.create', { replace: { canvas: OTHER } }, reach);
    const before = Object.keys(await listed());
    expect(
      await applied('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'stale' });
    expect(Object.keys(await listed())).toEqual(before);
    expect((await listed())[OTHER]).toMatchObject({ open: true, shownIn: [1] });
  });

  it('proposes a token’s save that would remove agents its file has; Allow saves, unless the file changed since', async () => {
    await applied('canvas.get', { canvas: TEAM });
    await applied('canvas.delete', { canvas: TEAM, nodes: ['worker'] });
    const { proposed } = await applied('canvas.save', { canvas: TEAM }, TOKEN);
    expect(await proposals(TEAM)).toEqual([
      expect.objectContaining({
        id: proposed,
        title: '"orchestrator" asks to save team.corral, removing Worker from its file',
      }),
    ]);
    expect(nodesIn(await readFile(files.team, 'utf8'))).toHaveLength(2);
    // Its file changed on disk since: stale, the file as it is.
    const changed = JSON.stringify(fileOf(TEAM, ['lead', 'worker', 'third']));
    await writeFile(files.team, changed);
    expect(
      await applied('reply', { canvas: TEAM, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'stale' });
    expect(await readFile(files.team, 'utf8')).toBe(changed);
    // Proposed anew and allowed, it goes stale too: a save over a file changed on disk waits for
    // you to review the change (B9 Design §5).
    const again = await applied('canvas.save', { canvas: TEAM }, TOKEN);
    expect(
      await applied('reply', { canvas: TEAM, to: again.proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'stale' });
    expect(await readFile(files.team, 'utf8')).toBe(changed);
    const { items } = (await applied('needs', { canvas: TEAM })) as { items: NeedsItem[] };
    const review = items.find((item) => item.kind === 'file');
    await applied('reply', { canvas: TEAM, to: review?.id, answer: { choice: 'keep' } });
    // Kept, then proposed and allowed: written as the canvas has it.
    const kept = await applied('canvas.save', { canvas: TEAM }, TOKEN);
    await applied('reply', { canvas: TEAM, to: kept.proposed, answer: { choice: 'allow' } });
    expect(nodesIn(await readFile(files.team, 'utf8'))).toEqual([
      expect.objectContaining({ id: 'lead' }),
    ]);
    // Nothing more to lose: a token saves at once.
    expect(await applied('canvas.save', { canvas: TEAM }, TOKEN)).toEqual({
      name: 'team.corral',
      revs: {},
    });
  });
});

describe('project.choose', () => {
  it('remembers the folder you pick, its sessions ending only when it is another', async () => {
    expect(await applied('project.choose', { canvas: OTHER })).toEqual({ project: null, revs: {} });
    const folder = path.join(profile, 'elsewhere');
    await mkdir(folder);
    answers.folder.push(folder);
    expect(await applied('project.choose', { canvas: OTHER })).toEqual({
      project: { name: 'elsewhere', path: folder },
      revs: {},
    });
    expect((await listed())[OTHER]).toMatchObject({ project: { name: 'elsewhere', path: folder } });
  });

  it('is yours alone, as canvas.open and canvas.saveAs are', async () => {
    for (const [name, args] of [
      ['project.choose', { canvas: TEAM }],
      ['canvas.open', {}],
      ['canvas.saveAs', { canvas: TEAM }],
    ] as const) {
      expect(await call(name, args, TOKEN)).toMatchObject({
        ok: false,
        error: { code: 'human-only' },
      });
    }
  });
});

describe('command proposal completion', () => {
  it.each(['canvas.close', 'canvas.create'] as const)(
    'allows %s discarding a draft before its proposal is forgotten',
    async (op) => {
      const { canvas } = (await applied('canvas.create', {}, TOKEN)) as { canvas: CanvasId };
      const creator = { ...TOKEN, canvases: [...TOKEN.canvases, canvas] };
      await applied('canvas.addAgent', { canvas, at: { x: 0, y: 0 }, adapter: 'codex' }, creator);
      const args =
        op === 'canvas.close' ? { canvas, discard: true } : { replace: { canvas, discard: true } };
      const { proposed } = await applied(op, args, creator);
      expect(
        await call('reply', { canvas, to: proposed, answer: { choice: 'allow' } }),
      ).toMatchObject({ ok: true, value: { outcome: 'allowed' } });
      expect((await listed())[canvas]).toBeUndefined();
    },
  );
  it('keeps a failed template replacement unapplied and its proposal pending', async () => {
    await edit(OTHER, 'solo', 'Unsaved');
    const { proposed } = await applied(
      'canvas.create',
      { template: TEMPLATE, replace: { canvas: OTHER, discard: true } },
      TOKEN,
    );
    await writeFile(files.other, 'not a canvas');
    const before = await listed();
    expect(
      await call('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ ok: false });
    expect(Object.keys(await listed())).toEqual(Object.keys(before));
    expect(
      readOnDisk(profile, (disk) =>
        disk
          .prepare('SELECT outcome FROM proposal WHERE id = ?')
          .get(String(proposed).slice('proposal/'.length)),
      ),
    ).toEqual({ outcome: null });
  });
});

it('rolls back a new template canvas when closing its replacement fails after preflight', async () => {
  await edit(OTHER, 'solo', 'Unsaved');
  const { proposed } = await applied(
    'canvas.create',
    { template: TEMPLATE, replace: { canvas: OTHER, discard: true } },
    TOKEN,
  );
  const before = await listed();
  const fail = vi
    .spyOn(core.engines, 'closeCanvas')
    .mockRejectedValueOnce(new Error('Could not journal the old run'));
  try {
    expect(
      await call('reply', { canvas: OTHER, to: proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ ok: false });
    expect(await listed()).toEqual(before);
    expect(labelsOf(await documentOf(OTHER))).toEqual(['Unsaved']);
    expect(
      readOnDisk(profile, (disk) =>
        disk
          .prepare('SELECT outcome FROM proposal WHERE id = ?')
          .get(String(proposed).slice('proposal/'.length)),
      ),
    ).toEqual({ outcome: null });
  } finally {
    fail.mockRestore();
  }
});
