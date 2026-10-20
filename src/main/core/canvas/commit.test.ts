import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../../shared/canvas';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { CanvasMemory } from '../../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { OpFailure } from '../call';
import type { Caller } from '../caller';
import { asHuman } from '../gui';
import { Superseded } from '../scopes';
import { SYSTEM_DEPS } from '../store/store';
import type { Store } from '../store/store';
import { openTestStore, readOnDisk } from '../store/test-store';
import { PROPOSAL } from '../test-registry';
import type { ChangeSet } from './change';
import { committer } from './commit';
import type { ChangeRule, CommitCall } from './commit';
import { Documents } from './documents';

/*
 * An op's commit (B9 Design §3): what it builds over a canvas's live document, checked against the
 * revisions its caller expects and, for a token, the change rules, then written past its point of
 * no return; and what follows it.
 */

let profile: string;
let store: Store;
let documents: Documents;
let canvas: CanvasId;

const YOU = asHuman(1);
const ORCHESTRATOR: Caller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [],
};

/** A lead and a worker. */
const document = (id: CanvasId): CanvasDocument => ({
  id,
  arrange: false,
  nodes: [
    { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Lead' } },
    { id: 'worker', type: 'agent', position: { x: 300, y: 0 }, data: { label: 'Worker' } },
  ],
  links: [],
});
/** `doc` with node `id` called `label`. */
const renamed = (doc: CanvasDocument, id: string, label: string): CanvasDocument => ({
  ...doc,
  nodes: doc.nodes.map((node) =>
    node.id === id ? { ...node, data: { ...node.data, label } } : node,
  ),
});
const rename = (id: string, label: string) => (doc: CanvasDocument) => ({
  next: renamed(doc, id, label),
  result: { label },
});

/** A call of canvas.rename by `caller`, with what else it says. */
function callOf(caller: Caller, more: Partial<CommitCall> = {}): CommitCall & { said: string[] } {
  const said: string[] = [];
  return {
    op: 'canvas.rename',
    caller,
    party: caller.kind === 'human' ? 'you' : 'outside-write',
    by: caller.kind === 'human' ? 'you' : 'outside:orchestrator',
    signal: new AbortController().signal,
    noReturn: () => said.push('past its point of no return'),
    said,
    ...more,
  };
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-commit-'));
  store = await openTestStore(profile);
  const memory = new CanvasMemory(store);
  documents = new Documents({ store, memory, catalog: CATALOG, defaultAdapter: DEFAULT_ADAPTER });
  canvas = newCanvasId();
  await documents.edit(canvas, toFile(document(canvas)));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

describe('a commit', () => {
  it('writes what its op builds past its point of no return, and says what changed', async () => {
    const heard: ChangeSet[] = [];
    const commit = committer({
      documents,
      rules: {},
      committed: (_canvas, change) => heard.push(change),
    });
    const call = callOf(ORCHESTRATOR);
    expect(await commit(canvas, rename('worker', 'Builder'), call)).toEqual({
      result: { label: 'Builder' },
      rev: 2,
    });
    expect(call.said).toEqual(['past its point of no return']);
    expect(documents.live(canvas).revs.get('node/worker')).toBe(2);
    expect(heard.map((change) => [...change.entities.keys()])).toEqual([['node/worker']]);
    expect(heard[0]).toMatchObject({ canvas, op: 'canvas.rename', by: 'outside:orchestrator' });
  });

  it('changes nothing, and checks nothing, for a build that changes nothing', async () => {
    const heard: unknown[] = [];
    const commit = committer({
      documents,
      rules: { links: () => ({ refuse: 'Never.' }) },
      committed: (...args) => heard.push(args),
    });
    const call = callOf(ORCHESTRATOR, { expect: { 'node/worker': 9 } });
    expect(await commit(canvas, rename('worker', 'Worker'), call)).toEqual({
      result: { label: 'Worker' },
    });
    expect([heard, call.said]).toEqual([[], []]);
  });

  it('is a conflict when an entity it expects is at another revision, saying what each is now', async () => {
    const commit = committer({ documents, rules: {} });
    const call = callOf(ORCHESTRATOR, {
      expect: { 'node/lead': 1, 'node/worker': 3, 'item/worker/gone': 0, 'node/ghost': 2 },
    });
    const failed = commit(canvas, rename('lead', 'Head'), call);
    await expect(failed).rejects.toBeInstanceOf(OpFailure);
    await expect(failed).rejects.toMatchObject({
      code: 'conflict',
      message:
        'node/worker is at revision 1, not 3; node/ghost is at revision 0, not 2: they changed since you read them. Read them again before you change them.',
      current: {
        'node/worker': { rev: 1, value: expect.objectContaining({ label: 'Worker' }) as unknown },
        'node/ghost': { rev: 0, value: null },
      },
    });
    expect(call.said).toEqual([]);
    expect(documents.live(canvas).rev).toBe(1);
    // As expected, it goes.
    await commit(
      canvas,
      rename('lead', 'Head'),
      callOf(ORCHESTRATOR, { expect: { 'node/lead': 1 } }),
    );
    expect(documents.live(canvas).rev).toBe(2);
  });

  it('lets each change rule refuse a token’s commit, never yours, writing nothing', async () => {
    const heard: unknown[] = [];
    const named: ChangeRule = (change) =>
      [...change.entities.values()].some(
        (entity) => (entity.after as { label?: string } | null)?.label === 'Forbidden',
      )
        ? { refuse: 'Nothing is called Forbidden.' }
        : undefined;
    const commit = committer({
      documents,
      rules: { role: named },
      committed: (...args) => heard.push(args),
    });
    await expect(
      commit(canvas, rename('lead', 'Forbidden'), callOf(ORCHESTRATOR)),
    ).rejects.toMatchObject({ code: 'refused', message: 'Nothing is called Forbidden.' });
    expect(documents.live(canvas).rev).toBe(1);
    expect(heard).toEqual([]);
    await expect(commit(canvas, rename('lead', 'Forbidden'), callOf(YOU))).resolves.toMatchObject({
      rev: 2,
    });
  });

  it('is followed by nothing when its flush failed: nothing of it was kept, nor of any after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failing = false;
    await store.close();
    store = await openTestStore(profile, {
      ...SYSTEM_DEPS,
      flush: (fd) =>
        failing ? Promise.reject(new Error('EIO: fsync failed')) : SYSTEM_DEPS.flush(fd),
    });
    documents = new Documents({
      store,
      memory: new CanvasMemory(store),
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    await documents.load(canvas);
    const heard: ChangeSet[] = [];
    const commit = committer({
      documents,
      rules: {},
      committed: (_canvas, change) => heard.push(change),
    });
    failing = true;
    const call = callOf(YOU);
    await expect(commit(canvas, rename('worker', 'Builder'), call)).rejects.toThrow(
      /^The change couldn’t be written, so nothing changed: The core’s database could not be written to the drive \(EIO: fsync failed\), so it keeps nothing more until the core opens it again/,
    );
    expect(call.said).toEqual(['past its point of no return']);
    failing = false;
    await expect(commit(canvas, rename('lead', 'Head'), callOf(YOU))).rejects.toThrow(
      'so it keeps nothing more until the core opens it again',
    );
    expect(heard).toEqual([]);
    expect(documents.live(canvas)).toMatchObject({ document: document(canvas), rev: 1 });
  });

  it('makes a token’s change only you may make a proposal, writing nothing, if its op may be one', async () => {
    const raised: [CanvasId, string[], CommitCall][] = [];
    const commit = committer({
      documents,
      rules: { discard: () => ({ propose: 'Only the user deletes Worker' }) },
      propose: (on, change, call) => {
        raised.push([on, [...change.entities.keys()], call]);
        return Promise.resolve(PROPOSAL);
      },
    });
    const call = callOf(ORCHESTRATOR, { proposes: true, args: { node: 'worker' } });
    expect(await commit(canvas, rename('worker', 'Builder'), call)).toEqual({
      proposed: PROPOSAL,
    });
    expect(raised).toEqual([[canvas, ['node/worker'], call]]);
    expect([documents.live(canvas).rev, call.said]).toEqual([1, []]);
    // An op that can't be one is refused instead, saying why.
    await expect(
      commit(canvas, rename('worker', 'Builder'), callOf(ORCHESTRATOR)),
    ).rejects.toMatchObject({
      code: 'refused',
      message:
        'Only the user deletes Worker, and canvas.rename can’t come to them as a proposal: ask with canvas.delete or canvas.batch, which can.',
    });
    // Yours applies.
    await expect(commit(canvas, rename('worker', 'Builder'), callOf(YOU))).resolves.toMatchObject({
      rev: 2,
    });
  });

  it('refuses a change a rule refuses rather than propose it, whichever rule comes first', async () => {
    const raised: unknown[] = [];
    const commit = committer({
      documents,
      rules: {
        discard: () => ({ propose: 'Only the user deletes Worker' }),
        links: () => ({ refuse: 'Never.' }),
      },
      propose: () => {
        raised.push('raised');
        return Promise.resolve(PROPOSAL);
      },
    });
    await expect(
      commit(canvas, rename('worker', 'Builder'), callOf(ORCHESTRATOR, { proposes: true })),
    ).rejects.toMatchObject({ code: 'refused', message: 'Never.' });
    expect(raised).toEqual([]);
  });

  it('records the party whose proposal you allowed, and writes what else its write holds with it', async () => {
    const said: string[] = [];
    const commit = committer({ documents, rules: {} });
    await commit(
      canvas,
      rename('worker', 'Builder'),
      callOf(YOU, {
        proposedBy: 'outside:orchestrator',
        within: () => {
          store.prepare('UPDATE canvas SET project = ? WHERE id = ?').run('/settled', canvas);
          said.push('staged');
          return { reveal: () => said.push('revealed'), undo: () => said.push('undone') };
        },
      }),
    );
    expect(said).toEqual(['staged', 'revealed']);
    expect(
      readOnDisk(profile, (disk) => ({
        ...disk
          .prepare('SELECT op, by_party, proposed_by FROM revision WHERE canvas_id = ? AND rev = 2')
          .get(canvas),
        ...disk.prepare('SELECT project FROM canvas WHERE id = ?').get(canvas),
      })),
    ).toEqual({
      op: 'canvas.rename',
      by_party: 'you',
      proposed_by: 'outside:orchestrator',
      project: '/settled',
    });
  });

  it('undoes what else its write held when the write failed, keeping nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.close();
    store = await openTestStore(profile, {
      ...SYSTEM_DEPS,
      flush: () => Promise.reject(new Error('EIO: fsync failed')),
    });
    documents = new Documents({
      store,
      memory: new CanvasMemory(store),
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    await documents.load(canvas);
    const said: string[] = [];
    const commit = committer({ documents, rules: {} });
    await expect(
      commit(
        canvas,
        rename('worker', 'Builder'),
        callOf(YOU, {
          within: () => {
            said.push('staged');
            return { reveal: () => said.push('revealed'), undo: () => said.push('undone') };
          },
        }),
      ),
    ).rejects.toThrow('EIO: fsync failed');
    expect(said).toEqual(['staged', 'undone']);
    expect(documents.live(canvas).rev).toBe(1);
  });

  it('unwinds, writing nothing, when it is superseded before its point of no return', async () => {
    const commit = committer({ documents, rules: {} });
    const controller = new AbortController();
    controller.abort(new Superseded());
    await expect(
      commit(canvas, rename('lead', 'Head'), callOf(YOU, { signal: controller.signal })),
    ).rejects.toBeInstanceOf(Superseded);
    expect(documents.live(canvas).rev).toBe(1);
  });
});
