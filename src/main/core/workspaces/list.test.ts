import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newCanvasId } from '../../../shared/canvas';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { CanvasMemory } from '../../memory';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import type { KeptTree } from './cleanup';
import { listWorktrees, sharing } from './list';
import type { Provisioning, WorktreeListDeps } from './list';
import { WorkspaceStore } from './store';
import type { WorktreeRecord } from './store';

/*
 * B9a X12's authorized selector (C): who works where on a canvas, from the records the resolver
 * and cleanup keep, as you see it (every agent, with where each checkout is, its setup and the
 * kept trees) or as a token does (only the agents it reaches, none of what is yours alone). It
 * never allocates, and a shared workspace never names a member the caller doesn't reach.
 */

const canvas = newCanvasId();
const REPOSITORY = '22222222-2222-4222-8222-222222222222';
const ROOT = '/picked';
const OWNED = `${ROOT}/.corral/worktrees/profile`;
const ids = {
  team: '30000000-0000-4000-8000-000000000001',
  solo: '30000000-0000-4000-8000-000000000002',
  moving: '30000000-0000-4000-8000-000000000003',
  kept: '30000000-0000-4000-8000-000000000004',
} as const;

/**
 * The canvas: `lead` heads a group with `helper` and the frame `crew` holding `member`; `solo` and
 * `mover` work alone; `fresh` has no worktree yet; `frame` (a frame) holds `inner` and `other`.
 */
function agent(id: string, parentId?: string): CanvasNode {
  return {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    ...(parentId === undefined ? {} : { parentId }),
    data: { label: id.charAt(0).toUpperCase() + id.slice(1), queue: [] },
  };
}
function frame(id: string, parentId?: string): CanvasNode {
  return {
    id,
    type: 'frame',
    position: { x: 0, y: 0 },
    ...(parentId === undefined ? {} : { parentId }),
    data: { label: id },
  };
}
const DOCUMENT: CanvasDocument = {
  id: canvas,
  arrange: false,
  nodes: [
    agent('lead'),
    agent('helper', 'lead'),
    frame('crew', 'lead'),
    agent('member', 'crew'),
    agent('solo'),
    agent('mover'),
    agent('fresh'),
    frame('frame'),
    agent('inner', 'frame'),
    agent('other', 'frame'),
  ],
  links: [],
};

let folder: string;
let store: Store;
let workspaces: WorkspaceStore;
let trees: Record<keyof typeof ids, WorktreeRecord>;
let root: string | undefined;
let provisioning: Provisioning | undefined;
let kept: KeptTree[];

function deps(): WorktreeListDeps {
  return {
    workspaces,
    projectRoot: () => root,
    provisioning: () => provisioning,
    kept: () => kept,
  };
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-worktree-list-'));
  store = await openTestStore(folder);
  await store.write(() => {
    new CanvasMemory(store).ensure(canvas);
  });
  workspaces = new WorkspaceStore({ store });
  root = ROOT;
  provisioning = undefined;
  trees = await workspaces.write((w) => {
    w.addRepository({
      id: REPOSITORY,
      pickedRoot: ROOT,
      realRoot: ROOT,
      commonDir: `${ROOT}/.git`,
      identity: 'repository',
      rootKind: 'project',
      ownedRoot: OWNED,
    });
    w.bindCanvas(canvas, REPOSITORY);
    const make = (id: string, owner: `${'agent' | 'group'}/${string}`) =>
      w.createWorktree({
        id,
        canvas,
        repository: REPOSITORY,
        owner,
        path: `${OWNED}/${id}`,
        branchRef: `refs/heads/corrallm/profile/${id}`,
        baseCheckout: ROOT,
        baseRef: 'refs/heads/main',
        baseOid: 'a'.repeat(40),
        forkedFrom: null,
      });
    make(ids.team, 'group/lead');
    w.transition(ids.team, { from: 'creating', to: 'setup' });
    const team = w.transition(ids.team, { from: 'setup', to: 'ready' });
    make(ids.solo, 'agent/solo');
    const solo = w.transition(ids.solo, { from: 'creating', to: 'setup' });
    w.offerSetup(solo.id, {
      command: 'pnpm install --frozen-lockfile',
      source: 'detected',
      specHash: 'b'.repeat(64),
      copyManifestHash: 'c'.repeat(64),
    });
    make(ids.moving, 'agent/mover');
    const moving = w.transition(ids.moving, {
      from: 'creating',
      to: 'missing',
      errorCode: 'checkout-missing',
    });
    make(ids.kept, 'agent/former');
    const old = w.retain(ids.kept);
    for (const one of ['lead', 'helper', 'member']) w.bind(canvas, one, team.id);
    w.bind(canvas, 'solo', solo.id);
    w.bind(canvas, 'mover', moving.id);
    // The mover was moved into the lead's group: its change waits for your Switch.
    w.plan(canvas, 'mover', 'group/lead');
    // An agent deleted while its cleanup was recorded: its binding is no one's to list.
    w.bind(canvas, 'gone', solo.id);
    return { team, solo, moving, kept: old };
  });
  kept = [
    {
      workspace: ids.kept,
      canvas,
      owner: 'agent/former',
      name: 'Former',
      branch: `corrallm/profile/${ids.kept}`,
      base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
      state: 'retained',
      error: null,
      createdAt: trees.kept.createdAt,
    },
  ];
});

afterEach(async () => {
  await store.close();
  await rm(folder, { recursive: true, force: true });
});

const byAgent = (listing: ReturnType<typeof listWorktrees>) =>
  Object.fromEntries(listing.items.map((item) => [item.agent, item]));

describe('as you see it', () => {
  it('keeps merge observations unknown until an observation is supplied', () => {
    const listing = listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' });
    expect(listing.into).toBeNull();
    for (const item of listing.items)
      expect(item.merge).toEqual({ merged: null, uncommitted: null });
  });
  it('lists every agent with its tree, sharing and state, and what is yours alone', () => {
    const listing = listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' });
    expect(listing.items.map((item) => item.agent)).toEqual([
      'lead',
      'helper',
      'member',
      'solo',
      'mover',
      'fresh',
      'inner',
      'other',
    ]);
    const items = byAgent(listing);
    const team = trees.team;
    for (const one of ['lead', 'helper', 'member']) {
      expect(items[one]).toEqual({
        agent: one,
        mode: 'group',
        group: 'lead',
        workspace: team.id,
        generation: workspaces.binding(canvas, one)?.generation,
        branch: `corrallm/profile/${team.id}`,
        base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
        state: 'ready',
        merge: { merged: null, uncommitted: null },
        location: team.path,
      });
    }
    // Its setup card, the command it would run, and where: yours alone.
    expect(items.solo).toMatchObject({
      mode: 'own',
      workspace: ids.solo,
      state: 'setup',
      merge: { merged: null, uncommitted: null },
      need: `setup/${ids.solo}/${String(workspaces.setup(ids.solo)?.generation)}`,
      location: trees.solo.path,
      setup: {
        state: 'pending',
        command: 'pnpm install --frozen-lockfile',
        source: 'detected',
        exitCode: null,
      },
    });
    expect(items.solo).not.toHaveProperty('group');
    // A change waiting for your Switch: still its own (missing) tree, with the change's card.
    const generation = workspaces.binding(canvas, 'mover')?.desired?.generation ?? 0;
    expect(items.mover).toMatchObject({
      mode: 'own',
      workspace: ids.moving,
      state: 'pending-change',
      need: `rebind/${encodeURIComponent('group/lead')}/${String(generation)}`,
      error: 'checkout-missing',
    });
    // No tree yet: one is made as it starts, and a list never makes one.
    expect(items.fresh).toEqual({
      agent: 'fresh',
      mode: 'own',
      workspace: null,
      generation: 0,
      branch: null,
      base: null,
      state: 'unmade',
      merge: { merged: null, uncommitted: null },
    });
    expect(items.inner).toMatchObject({ mode: 'group', group: 'frame', state: 'unmade' });
    expect(workspaces.worktreesOf(canvas)).toHaveLength(4);
  });

  it('lists the trees the canvas keeps, with where each is', () => {
    expect(listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' }).kept).toEqual([
      {
        workspace: ids.kept,
        owner: 'agent/former',
        name: 'Former',
        branch: `corrallm/profile/${ids.kept}`,
        base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
        state: 'retained',
        error: null,
        location: trees.kept.path,
        createdAt: trees.kept.createdAt,
      },
    ]);
  });

  it('says what the resolver is doing for an agent with no tree yet, and why it failed', () => {
    provisioning = { making: true };
    expect(byAgent(listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' })).fresh).toMatchObject({
      state: 'creating',
      workspace: null,
    });
    provisioning = { making: false, error: 'Too many workspaces are being made at once.' };
    expect(byAgent(listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' })).fresh).toMatchObject({
      state: 'error',
      error: 'Too many workspaces are being made at once.',
    });
    provisioning = {
      making: false,
      project: { kind: 'refused', sentence: 'Choose the repository’s top level instead.' },
    };
    expect(byAgent(listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' })).fresh).toMatchObject({
      state: 'error',
      error: 'Choose the repository’s top level instead.',
    });
  });

  it('says a folder that isn’t a repository is shared, and that none is chosen', async () => {
    await workspaces.write((w) => {
      for (const one of w.bindingsOf(canvas)) w.unbind(canvas, one.agent);
      w.bindCanvas(canvas, null);
    });
    expect(byAgent(listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' })).solo).toEqual({
      agent: 'solo',
      mode: 'shared-folder',
      workspace: null,
      generation: 0,
      branch: null,
      base: null,
      state: 'ready',
      merge: { merged: null, uncommitted: null },
      location: ROOT,
    });
    root = undefined;
    expect(byAgent(listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' })).solo).toMatchObject({
      state: 'no-project',
      workspace: null,
    });
  });

  it('lists one agent when asked, and no kept tree then', () => {
    const listing = listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' }, 'helper');
    expect(listing.items.map((item) => item.agent)).toEqual(['helper']);
    expect(listing.kept).toEqual([]);
  });
});

describe('as a token sees it', () => {
  const token = (...reached: string[]) => ({ kind: 'token', reached: new Set(reached) }) as const;

  it('lists only the agents it reaches, without what is yours alone, and no kept tree', () => {
    const listing = listWorktrees(deps(), canvas, DOCUMENT, token('solo', 'mover', 'fresh'));
    expect(listing.kept).toEqual([]);
    expect(listing.items).toEqual([
      {
        agent: 'solo',
        mode: 'own',
        workspace: ids.solo,
        generation: workspaces.binding(canvas, 'solo')?.generation,
        branch: `corrallm/profile/${ids.solo}`,
        base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
        // It waits for setup; the command, the card and where it runs are yours.
        state: 'setup',
        merge: { merged: null, uncommitted: null },
      },
      expect.objectContaining({ agent: 'mover', state: 'pending-change' }),
      expect.objectContaining({ agent: 'fresh', state: 'unmade' }),
    ]);
    for (const item of listing.items) {
      for (const field of ['need', 'error', 'location', 'setup']) {
        expect(item, `${item.agent}: ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it('never names a member of a shared tree it doesn’t reach, nor a group head it doesn’t', () => {
    // The member reaches itself alone: it shares the lead's tree, and learns no one else's id.
    const listing = listWorktrees(deps(), canvas, DOCUMENT, token('member'));
    expect(listing.items).toEqual([
      {
        agent: 'member',
        mode: 'group',
        workspace: ids.team,
        generation: workspaces.binding(canvas, 'member')?.generation,
        branch: `corrallm/profile/${ids.team}`,
        base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
        state: 'ready',
        merge: { merged: null, uncommitted: null },
      },
    ]);
    expect(JSON.stringify(listing)).not.toMatch(/lead|helper/);
    // A frame around an agent it reaches it sees, as canvas.get shows it.
    expect(listWorktrees(deps(), canvas, DOCUMENT, token('inner')).items).toEqual([
      expect.objectContaining({ agent: 'inner', mode: 'group', group: 'frame' }),
    ]);
    // A head it reaches is named.
    expect(
      listWorktrees(deps(), canvas, DOCUMENT, token('member', 'lead')).items.map((item) => [
        item.agent,
        item.group,
      ]),
    ).toEqual([
      ['lead', 'lead'],
      ['member', 'lead'],
    ]);
  });

  it('says who shares an agent’s tree only as far as the caller reaches (what a workspace context reads)', () => {
    const yours = listWorktrees(deps(), canvas, DOCUMENT, { kind: 'you' });
    expect(sharing(yours, 'member').map((item) => item.agent)).toEqual([
      'member',
      'lead',
      'helper',
    ]);
    const theirs = listWorktrees(deps(), canvas, DOCUMENT, token('member', 'helper'));
    expect(sharing(theirs, 'member').map((item) => item.agent)).toEqual(['member', 'helper']);
    // Not listed to it, or with no tree yet: no one to name.
    expect(sharing(theirs, 'lead')).toEqual([]);
    expect(sharing(yours, 'fresh').map((item) => item.agent)).toEqual(['fresh']);
  });

  it('reads reach as it is now: an agent out of reach, or gone, is never listed', () => {
    expect(listWorktrees(deps(), canvas, DOCUMENT, token('solo', 'gone')).items).toEqual([
      expect.objectContaining({ agent: 'solo' }),
    ]);
    expect(listWorktrees(deps(), canvas, DOCUMENT, token()).items).toEqual([]);
    // Asked for one it doesn't reach (core.call refuses that first): nothing.
    expect(listWorktrees(deps(), canvas, DOCUMENT, token('solo'), 'lead').items).toEqual([]);
  });
});
