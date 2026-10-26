import { legacyDirectories } from './workspaces/test-directories';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPS, opsFor } from '../../shared/api/registry';
import { GUI_OPS, PARTIES, SURFACE } from '../../shared/api/surface';
import type { OpName, Party } from '../../shared/api/surface';
import type {
  Change,
  TopicUpdate,
  TopicKey,
  TopicRequest,
  TopicSnapshot,
} from '../../shared/api/topics';
import { topicKey } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { Entities } from '../../shared/model/state';
import { canvasStateOf } from '../../shared/model/state';
import type { Settings } from '../settings';
import { createCore } from './core';
import type { Core } from './core';
import { asHuman, WindowPorts } from './gui';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { openWindow } from './test-window';
import { REAL_FIXTURES, startWorld, WORKER_WORKTREE } from './test-world';
import type { WorktreeListing } from './workspaces/list';
import { validFor } from './test-registry';

function legacy(batch: readonly TopicUpdate[]): Change[] {
  if (
    batch.some(
      (update) => 'kind' in update || /^(run|sessions|session|messages):/.test(update.topic),
    )
  )
    throw new Error('This fixture subscribes only to small document topics.');
  return batch as Change[];
}

let profile: string;
let core: Core;
const closing: (() => void)[] = [];

/** T3c: topic state is the corresponding read's, and only subscribed windows hear it. */
describe('T3c: usage and settings topics', () => {
  beforeEach(async () => {
    profile = await mkdtemp(path.join(tmpdir(), 'corrallm-topics-'));
    core = await createCore(
      {
        profile,
        app: { name: 'corrallm', version: '1' },
        check: true,
        distribution: 'local',
        directoryResolver: legacyDirectories,
        sessions: { connectors: {}, environment: () => Promise.resolve({}) },
      },
      NO_DESKTOP,
    );
  });
  afterEach(async () => {
    for (const close of closing.splice(0)) close();
    await core.close();
    await rm(profile, { recursive: true, force: true });
  });

  function connect(served: WindowPorts, id: number) {
    const window = openWindow(served, id);
    closing.push(window.close);
    const changes: Change[] = [];
    const epochs: string[] = [];
    window.link.on('topic', (batch) => changes.push(...legacy(batch)));
    window.link.on('epoch', (epoch) => epochs.push(epoch));
    return { ...window, changes, epochs };
  }

  it('subscribes to global topics with several open canvases without inferring a canvas', async () => {
    await core.call('canvas.create', {}, CALLERS.you);
    await core.call('canvas.create', {}, CALLERS.you);
    const served = new WindowPorts(core);
    const window = connect(served, 7);
    for (const topic of ['usage', 'settings', 'canvases'] as const) {
      const answer = await window.link.request('call', 'topics.subscribe', { topic });
      expect(answer).toMatchObject({ ok: true, value: { ok: true } });
      expect(await window.link.request('call', 'topics.unsubscribe', { topic })).toMatchObject({
        ok: true,
        value: { ok: true },
      });
    }
  });

  it.each(['usage', 'settings'] as const)(
    'serves %s’s read, pushes changes to subscribers, and stops on unsubscribe',
    async (topic) => {
      const served = new WindowPorts(core);
      const a = connect(served, 7);
      const b = connect(served, 8);
      const read = topic === 'usage' ? 'usage.get' : 'settings.get';
      expect(GUI_OPS).toContain(read);
      const initial = await a.link.request('call', 'topics.subscribe', { topic });
      const state = await core.call(read, {}, CALLERS.you);
      expect(state.ok).toBe(true);
      expect(initial).toEqual({
        ok: true,
        value: {
          ok: true,
          value: {
            rev: 0,
            epoch: expect.any(String) as string,
            state: state.ok ? state.value : undefined,
            revs: {},
          },
        },
      });
      await vi.waitFor(() => {
        expect(a.epochs).toHaveLength(1);
      });
      async function change() {
        if (topic === 'usage') {
          await core.call(
            'usage.simulate',
            { backend: 'codex', windows: { fiveHour: { usedPercent: 70, resetsAt: null } } },
            CALLERS.you,
          );
        } else await (core.settings as Settings).consent('codex', 'plan').give();
      }
      await change();
      await vi.waitFor(() => {
        expect(a.changes).toHaveLength(1);
      });
      const updated = await core.call(read, {}, CALLERS.you);
      expect(a.changes[0]).toMatchObject({
        topic,
        rev: 1,
        epoch: a.epochs[0],
        seq: expect.any(Number) as number,
        by: 'you',
        at: expect.any(Number) as number,
        replace: updated.ok ? updated.value : undefined,
      });
      expect(b.changes).toEqual([]);
      await a.link.request('call', 'topics.unsubscribe', { topic });
      await b.link.request('call', 'topics.subscribe', { topic });
      if (topic === 'usage')
        await core.call('usage.simulate', { backend: 'codex', windows: null }, CALLERS.you);
      else await (core.settings as Settings).consent('codex', 'other').give();
      await vi.waitFor(() => {
        expect(b.changes).toHaveLength(1);
      });
      expect(a.changes).toHaveLength(1);
    },
  );

  it('forgets subscriptions when a window’s port goes, and gives a restarted core a new epoch', async () => {
    const served = new WindowPorts(core);
    const a = connect(served, 7);
    await a.link.request('call', 'topics.subscribe', { topic: 'usage' });
    served.gone(7);
    const b = connect(served, 7);
    await vi.waitFor(() => {
      expect(b.epochs).toHaveLength(1);
    });
    await core.call(
      'usage.setRule',
      { backend: 'codex', rule: { window: 'weekly', percent: 80, action: 'ask' } },
      CALLERS.you,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(b.changes).toEqual([]);
    await core.close();
    core = await createCore(
      {
        profile,
        app: { name: 'corrallm', version: '1' },
        check: true,
        distribution: 'local',
        directoryResolver: legacyDirectories,
        sessions: { connectors: {}, environment: () => Promise.resolve({}) },
      },
      NO_DESKTOP,
    );
    const restarted = connect(new WindowPorts(core), 7);
    await vi.waitFor(() => {
      expect(restarted.epochs).toHaveLength(1);
    });
    expect(restarted.epochs[0]).not.toBe(b.epochs[0]);
  });

  it('batches global topic changes for a window in order every 16 ms', async () => {
    const window = connect(new WindowPorts(core), 7);
    const batches: Change[][] = [];
    window.link.on('topic', (batch) => batches.push(legacy(batch)));
    await window.link.request('call', 'topics.subscribe', { topic: 'usage' });
    await window.link.request('call', 'topics.subscribe', { topic: 'settings' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await core.call(
        'usage.setRule',
        {
          backend: 'codex',
          rule: { window: 'weekly', percent: 80, action: 'ask' },
        },
        CALLERS.you,
      );
      await (core.settings as Settings).consent('codex', 'plan').give();
      // Wait for the topic queue, without advancing its batching clock.
      await window.link.request('call', 'topics.subscribe', { topic: 'usage' });
      expect(batches).toEqual([]);
      await vi.advanceTimersByTimeAsync(16);
      await vi.waitFor(() => {
        expect(batches).toHaveLength(1);
      });
      expect(batches[0]?.map(({ topic, rev, seq }) => ({ topic, rev, seq }))).toEqual([
        { topic: 'usage', rev: 1, seq: 1 },
        { topic: 'settings', rev: 1, seq: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a canvas’s topic that names no canvas, and one the core doesn’t keep', async () => {
    const window = connect(new WindowPorts(core), 7);
    for (const [request, code] of [
      [{ topic: 'canvas' }, 'invalid'],
      [{ topic: 'needs' }, 'invalid'],
      [{ topic: 'canvas', canvas: randomUUID() }, 'not-found'],
      [{ topic: 'needs', canvas: randomUUID() }, 'unavailable'],
    ] as const) {
      expect(await window.link.request('call', 'topics.subscribe', request)).toMatchObject({
        ok: true,
        value: { ok: false, error: { code } },
      });
    }
  });

  it('serves a canvas the app shows: its entities from each commit, and nothing waiting in the core', async () => {
    const served = new WindowPorts(core);
    const window = connect(served, 7);
    const shown = await core.call('window.get', {}, asHuman(7));
    if (!shown.ok) throw new Error(shown.error.sentence);
    const canvas = shown.value.canvas as CanvasId;
    const subscribe = async (request: TopicRequest) => {
      const answer = await window.link.request('call', 'topics.subscribe', request);
      if (!answer.ok || !answer.value.ok) throw new Error(JSON.stringify(answer));
      return answer.value.value as TopicSnapshot;
    };
    // A new draft: nothing but its meta.
    const snapshot = await subscribe({ topic: 'canvas', canvas });
    expect(snapshot).toMatchObject({ rev: 0, state: { meta: { name: null, edited: false } } });
    expect(Object.keys(snapshot.state as object)).toEqual(['meta']);
    expect((await subscribe({ topic: 'needs', canvas })).state).toEqual({ items: [] });

    // A gesture's operation, through the window's port: committed, and so said.
    const answer = await window.link.request('call', 'canvas.addAgent', {
      canvas,
      adapter: 'codex',
      at: { x: 0, y: 0 },
      request: randomUUID(),
    });
    if (!answer.ok || !answer.value.ok) throw new Error(JSON.stringify(answer));
    const { id } = answer.value.value as { id: string };
    await vi.waitFor(() => {
      expect(window.changes.find(({ topic }) => topic === `canvas:${canvas}`)).toBeDefined();
    });
    expect(window.changes.find(({ topic }) => topic === `canvas:${canvas}`)).toMatchObject({
      rev: 1,
      by: 'you',
      set: {
        [`node/${id}`]: { id, adapter: 'codex', rev: 1, by: 'you' },
        meta: { edited: true, rev: 1 },
      },
    });
    // A run journaled beside it commits nothing of the canvas: no change of its own.
    await core.engines.canvas(canvas)?.journal();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.changes.filter(({ topic }) => topic === `canvas:${canvas}`)).toHaveLength(1);
  });

  it('lists no topic operation for a token and refuses either if called', async () => {
    for (const party of ['lead', 'worker', 'outside-read', 'outside-write'] as const) {
      expect(opsFor(SURFACE, party)).not.toContain('topics.subscribe');
      expect(opsFor(SURFACE, party)).not.toContain('topics.unsubscribe');
      for (const op of ['topics.subscribe', 'topics.unsubscribe'] as const) {
        expect(OPS[op]).toBeDefined();
        expect(await core.call(op, { topic: 'usage' }, CALLERS[party])).toMatchObject({
          ok: false,
          error: { code: 'human-only' },
        });
      }
    }
  });
});

/**
 * A copy of a topic as a window keeps it: its snapshot, then each change applied in order, a keyed
 * one by setting and removing entities. Every change must follow the last at the next revision.
 */
class Copy {
  readonly topic: TopicKey;
  readonly initial: unknown;
  rev: number;
  state: unknown;
  /** Each change applied, in order. */
  readonly changes: Change[] = [];

  constructor(topic: TopicKey, snapshot: TopicSnapshot) {
    this.topic = topic;
    this.initial = snapshot.state;
    this.rev = snapshot.rev;
    this.state = snapshot.state;
  }

  apply(changes: readonly Change[]): void {
    for (const change of changes) {
      if (change.topic !== this.topic) continue;
      // What the snapshot holds already.
      if (change.rev <= this.rev) continue;
      expect(change.rev, `${this.topic} skipped a revision`).toBe(this.rev + 1);
      if ('replace' in change) this.state = change.replace;
      else {
        const next = { ...(this.state as Record<string, unknown>), ...change.set };
        for (const key of change.remove ?? []) Reflect.deleteProperty(next, key);
        this.state = next;
      }
      this.rev = change.rev;
      this.changes.push(change);
    }
  }
}

/** The parties in an op's audience. */
const audienceOf = (op: OpName): Party[] => PARTIES.filter((party) => party in SURFACE[op].access);

/** The doc ops, in the registry's order: what changes a canvas's document. */
const DOC_OPS = (Object.keys(REAL_FIXTURES) as OpName[]).filter(
  (name) => SURFACE[name].kind === 'doc',
);

describe('T3c: the canvas, canvases and needs topics', () => {
  let world: Awaited<ReturnType<typeof startWorld>>;
  /** Each party's copy of each topic: yours through a window's port, a token's as it would be. */
  const copies = new Map<Party, Map<TopicKey, Copy>>();
  /** What your window was sent of the canvas's topics, in order. */
  const sent: Change[] = [];
  const stops: (() => void)[] = [];
  const TOPICS: TopicRequest[] = [
    { topic: 'canvas', canvas: CANVAS },
    { topic: 'needs', canvas: CANVAS },
    { topic: 'worktrees', canvas: CANVAS },
    { topic: 'canvases' },
  ];
  /** The read each topic is: its op and its arguments. */
  const READS: Readonly<Record<string, [OpName, unknown]>> = {
    canvas: ['canvas.get', { canvas: CANVAS }],
    needs: ['needs', { canvas: CANVAS }],
    worktrees: ['worktree.list', { canvas: CANVAS }],
    canvases: ['canvas.list', {}],
  };

  beforeAll(async () => {
    world = await startWorld();
    const served = new WindowPorts(world.core);
    const window = openWindow(served, 7);
    stops.push(window.close);
    const yours = new Map<TopicKey, Copy>();
    copies.set('you', yours);
    window.link.on('topic', (batch) => {
      sent.push(...legacy(batch).filter(({ topic }) => topic !== 'canvases'));
      for (const copy of yours.values()) copy.apply(legacy(batch));
    });
    for (const request of TOPICS) {
      const answer = await window.link.request('call', 'topics.subscribe', request);
      if (!answer.ok || !answer.value.ok) throw new Error(JSON.stringify(answer));
      const topic = topicKey(request);
      yours.set(topic, new Copy(topic, answer.value.value as TopicSnapshot));
    }
    for (const party of PARTIES.filter((one) => one !== 'you')) {
      const theirs = new Map<TopicKey, Copy>();
      copies.set(party, theirs);
      for (const request of TOPICS) {
        const [op] = READS[request.topic] ?? [];
        if (op === undefined || !audienceOf(op).includes(party)) continue;
        const topic = topicKey(request);
        // Its changes, once it has its snapshot (none comes before: nothing changes meanwhile).
        const box: { copy?: Copy } = {};
        const { snapshot, stop } = await world.core.topics.follow(CALLERS[party], topic, (batch) =>
          box.copy?.apply(legacy(batch)),
        );
        if ('kind' in snapshot) throw new Error('This fixture fits one frame.');
        box.copy = new Copy(topic, snapshot);
        theirs.set(topic, box.copy);
        stops.push(stop);
      }
    }
  });
  afterAll(async () => {
    for (const stop of stops) stop();
    await world.close();
  });

  /** Each party's copy of each topic, rebuilt where keyed, equals the topic's read as that party. */
  async function expectCopiesRead(): Promise<void> {
    await vi.waitFor(
      async () => {
        for (const [party, theirs] of copies) {
          for (const [topic, copy] of theirs) {
            const [op, args] = READS[topic.split(':')[0] ?? ''] ?? [];
            if (op === undefined) throw new Error(`No read for ${topic}`);
            const read = await world.core.call(op, args, CALLERS[party]);
            if (!read.ok) throw new Error(`${party}: ${read.error.sentence}`);
            const copied = topic.startsWith('canvas:')
              ? canvasStateOf(CANVAS, copy.rev, copy.state as Entities)
              : copy.state;
            expect(copied, `${party}’s ${topic}`).toEqual(read.value);
          }
        }
      },
      { timeout: 5000, interval: 25 },
    );
  }

  it('has every party’s copy as its read before any change', async () => {
    expect(copies.get('lead')?.has(`canvas:${CANVAS}`)).toBe(true);
    expect(copies.get('worker')?.has(`canvas:${CANVAS}`)).toBe(false);
    expect(copies.get('worker')?.has(`needs:${CANVAS}`)).toBe(true);
    await expectCopiesRead();
  });

  it.each(DOC_OPS)('keeps every copy its read after %s, by the commits’ diffs', async (name) => {
    const fixture = REAL_FIXTURES[name];
    for (const args of [...validFor(fixture, 'you'), ...Object.values(fixture.meetsRule ?? {})]) {
      const done = await world.core.call(name, args, CALLERS.you);
      expect(done.ok, `${name} ${JSON.stringify(args)}: ${JSON.stringify(done)}`).toBe(true);
      await expectCopiesRead();
    }
  });

  it('keeps every copy its read as a token’s delete comes to you as a proposal, and as you allow it', async () => {
    const proposed = await world.core.call(
      'canvas.delete',
      { canvas: CANVAS, nodes: ['stranger'] },
      CALLERS['outside-write'],
    );
    if (!proposed.ok || !('proposed' in proposed.value)) throw new Error(JSON.stringify(proposed));
    const { proposed: id } = proposed.value;
    await expectCopiesRead();
    const yours = () =>
      (copies.get('you')?.get(`needs:${CANVAS}`)?.state as { items: { id: string }[] }).items;
    expect(yours().map((item) => item.id)).toContain(id);
    const allowed = await world.core.call(
      'reply',
      { canvas: CANVAS, to: id, answer: { choice: 'allow' } },
      CALLERS.you,
    );
    expect(allowed).toMatchObject({ ok: true, value: { outcome: 'allowed' } });
    await expectCopiesRead();
    expect(yours().map((item) => item.id)).not.toContain(id);
  });

  it('keeps every party’s worktrees copy its read as a tree its agent leaves is kept, and says its revision', async () => {
    const yours = () => copies.get('you')?.get(`worktrees:${CANVAS}`)?.state as WorktreeListing;
    const theirs = () =>
      copies.get('outside-write')?.get(`worktrees:${CANVAS}`)?.state as WorktreeListing;
    expect(yours().items.map(({ agent }) => agent)).toContain('kept-work-batch');
    // The worker sees itself in its group's tree, never its apprentice, nor what is yours.
    const workers = copies.get('worker')?.get(`worktrees:${CANVAS}`)?.state as WorktreeListing;
    expect(workers.items.map(({ agent }) => agent)).not.toContain('apprentice');
    expect(workers.items.find(({ agent }) => agent === 'worker')).toMatchObject({
      workspace: WORKER_WORKTREE,
      mode: 'group',
      group: 'worker',
    });
    for (const item of workers.items) expect(item).not.toHaveProperty('location');
    const asked = await world.core.call(
      'canvas.delete',
      { canvas: CANVAS, nodes: ['kept-work-batch'] },
      CALLERS.you,
    );
    if (!asked.ok || !('proposed' in asked.value)) throw new Error(JSON.stringify(asked));
    const kept = await world.core.call(
      'reply',
      { canvas: CANVAS, to: asked.value.proposed, answer: { choice: 'allow' } },
      CALLERS.you,
    );
    expect(kept).toMatchObject({ ok: true, value: { outcome: 'allowed' } });
    // The reply's receipt names the revision your topic reached, which your copy then has.
    const rev = kept.ok ? kept.value.revs[`worktrees:${CANVAS}`] : 0;
    expect(rev).toBeGreaterThan(0);
    await expectCopiesRead();
    await vi.waitFor(() => {
      expect(copies.get('you')?.get(`worktrees:${CANVAS}`)?.rev).toBe(rev);
    });
    expect(yours().items.map(({ agent }) => agent)).not.toContain('kept-work-batch');
    expect(yours().kept.map(({ owner }) => owner)).toContain('agent/kept-work-batch');
    expect(theirs().items.map(({ agent }) => agent)).not.toContain('kept-work-batch');
    expect(theirs().kept).toEqual([]);
  });

  it('sends a canvas’s changes as what each commit changed, in order of its sequence', () => {
    const yours = copies.get('you')?.get(`canvas:${CANVAS}`);
    expect(yours?.changes.length).toBeGreaterThan(DOC_OPS.length);
    const before = { ...(yours?.initial as Entities) };
    for (const change of yours?.changes ?? []) {
      expect('replace' in change).toBe(false);
      if (!('set' in change)) continue;
      // Arrange can move most of the canvas after any structural edit. Check the actual diff,
      // not its size: unchanged entities must not be sent, and removed ones must have existed.
      for (const [key, entity] of Object.entries(change.set)) {
        expect(entity, `${key} sent unchanged at revision ${String(change.rev)}`).not.toEqual(
          before[key],
        );
        expect(entity.rev).toBeLessThanOrEqual(change.rev);
      }
      for (const key of change.remove ?? []) {
        expect(Object.hasOwn(before, key), `${key} removed twice`).toBe(true);
        Reflect.deleteProperty(before, key);
      }
      Object.assign(before, change.set);
    }
    // One sequence for the canvas's topics, shared by `canvas:<c>` and `needs:<c>`.
    const seqs = sent.map(({ seq }) => seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
