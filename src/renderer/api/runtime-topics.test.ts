import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MAX_TOPIC_FRAME } from '../../shared/api/limits';
import type { RuntimeChange, RuntimeSnapshotFrame } from '../../shared/api/topics';
import { snapshotFrameFits } from '../../shared/api/topics';
import { AgentId } from '../../shared/api/ids';
import { runtimeCore, runtimeWorld, sessionFrames } from '../test-runtime-core';
import { TopicMirror } from './topics';
import type { MirrorUpdate } from './topic-wire';
import {
  messagesForAgent,
  orderedEntries,
  useAgentMessages,
  useRunView,
  useSessionSummaries,
  useSessionView,
  useSessionEntries,
} from './runtime';

const mirrors: TopicMirror[] = [];
afterEach(() => {
  for (const mirror of mirrors.splice(0)) mirror.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(history = 0) {
  const world = runtimeWorld(history);
  const core = runtimeCore();
  const mirror = new TopicMirror(core.source);
  mirrors.push(mirror);
  return { ...world, core, mirror };
}
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function frame(frames: readonly RuntimeSnapshotFrame[], at: number): RuntimeSnapshotFrame {
  const value = frames.at(at);
  if (!value) throw new Error('The fixture is missing a snapshot frame.');
  return value;
}
type DeltaInput = RuntimeChange extends infer T
  ? T extends RuntimeChange
    ? Omit<T, 'epoch' | 'by' | 'at' | 'seq'>
    : never
  : never;
function delta(change: DeltaInput): RuntimeChange {
  return { epoch: 'one', seq: 100, by: 'cli', at: 1, ...change };
}

describe('runtime topic mirrors', () => {
  it('reads each structured subscription, waits for each revision and retains equal snapshot entities', async () => {
    const w = setup();
    const states = [w.run, w.sessions, w.session, w.messages];
    const keys = Object.values(w.keys);
    const waits = keys.map((key) => w.mirror.whenAt(key, 1));
    keys.forEach((key) => w.mirror.subscribe(key, vi.fn()));
    expect(w.core.requests).toEqual([
      { topic: 'run', canvas: w.canvas },
      { topic: 'sessions', canvas: w.canvas },
      { topic: 'session', canvas: w.canvas, agent: w.agent },
      { topic: 'messages', canvas: w.canvas },
    ]);
    states.forEach((state, i) => w.core.answer(i, state, 1));
    await Promise.all(waits);
    keys.forEach((key, i) => {
      expect(w.mirror.snapshot(key)).toEqual(states[i]);
    });
    const before = w.mirror.snapshot(w.keys.run);
    w.core.send(delta({ topic: w.keys.run, rev: 3, top: { running: false } }));
    w.core.answer(4, structuredClone(w.run), 3);
    await tick();
    expect(w.mirror.snapshot(w.keys.run)).toBe(before);
  });

  it('patches run tops and agent sets/removals without replacing an untouched agent', async () => {
    const w = setup();
    w.mirror.subscribe(w.keys.run, vi.fn());
    w.core.answer(0, { ...w.run, paused: true, saveError: 'full' });
    await tick();
    const first = w.mirror.snapshot(w.keys.run);
    w.core.send(
      delta({
        topic: w.keys.run,
        rev: 1,
        top: { paused: null, saveError: null },
        agents: { set: { [w.agent]: { ...w.run.agents[w.agent], status: 'done', outcomes: {} } } },
      }),
    );
    const next = w.mirror.snapshot(w.keys.run);
    expect(next).not.toHaveProperty('paused');
    expect(next).not.toHaveProperty('saveError');
    expect(next?.agents[w.other]).toBe(first?.agents[w.other]);
    expect(next?.agents[w.agent]?.status).toBe('done');
    w.core.send(delta({ topic: w.keys.run, rev: 2, agents: { set: {}, remove: [w.other] } }));
    expect(w.mirror.snapshot(w.keys.run)?.agents).not.toHaveProperty(w.other);
  });

  it('sets and removes summaries with prototype-shaped agent ids safely', async () => {
    const w = setup();
    w.mirror.subscribe(w.keys.sessions, vi.fn());
    w.core.answer(0, w.sessions);
    await tick();
    const first = w.mirror.snapshot(w.keys.sessions)?.agents[w.agent];
    w.core.send(
      delta({
        topic: w.keys.sessions,
        rev: 1,
        agents: {
          set: {
            [w.agent]: { ...w.session.summary },
            [w.other]: { ...w.session.summary, agent: w.other },
          },
        },
      }),
    );
    expect(w.mirror.snapshot(w.keys.sessions)?.agents[w.agent]).toBe(first);
    expect(Object.hasOwn(w.mirror.snapshot(w.keys.sessions)?.agents ?? {}, w.other)).toBe(true);
    w.core.send(delta({ topic: w.keys.sessions, rev: 2, agents: { set: {}, remove: [w.other] } }));
    expect(Object.hasOwn(w.mirror.snapshot(w.keys.sessions)?.agents ?? {}, w.other)).toBe(false);
  });

  it('appends once, upserts and applies authoritative history order, preserving untouched entries and summary', async () => {
    const w = setup();
    w.mirror.subscribe(w.keys.session, vi.fn());
    w.core.answer(0, w.session);
    await tick();
    const first = w.mirror.snapshot(w.keys.session);
    const change = delta({
      topic: w.keys.session,
      rev: 1,
      entries: {
        append: [{ id: 'child', text: ' again' }],
        upsert: [{ id: 'new', kind: 'text', text: 'new' }],
      },
    });
    w.core.send(change, change);
    const next = w.mirror.snapshot(w.keys.session);
    expect(next?.entries.user).toBe(first?.entries.user);
    expect(next?.summary).toBe(first?.summary); // No renderer reconstruction of summary.reply.
    expect(next?.entries.child).toMatchObject({ text: 'Working again' });
    expect(next?.order).toEqual(['user', 'tool', 'child', 'new']);
    w.core.send(
      delta({
        topic: w.keys.session,
        rev: 2,
        summary: { ...w.session.summary, status: 'idle' },
        entries: { order: ['user', 'new'] },
      }),
    );
    expect(Object.keys(w.mirror.snapshot(w.keys.session)?.entries ?? {})).toEqual(['user', 'new']);
    expect(w.mirror.snapshot(w.keys.session)?.summary.status).toBe('idle');
    expect(first?.entries.child).toMatchObject({ text: 'Working' });
  });

  it('patches message order/cursor and pruning without changing equal message objects', async () => {
    const w = setup();
    w.mirror.subscribe(w.keys.messages, vi.fn());
    w.core.answer(0, w.messages);
    await tick();
    const first = w.mirror.snapshot(w.keys.messages)?.items[w.id];
    w.core.send(
      delta({ topic: w.keys.messages, rev: 1, set: { [w.id]: { ...w.message } }, next: 'next' }),
    );
    expect(w.mirror.snapshot(w.keys.messages)?.items[w.id]).toBe(first);
    expect(w.mirror.snapshot(w.keys.messages)?.next).toBe('next');
    w.core.send(delta({ topic: w.keys.messages, rev: 2, set: {}, remove: [w.id], order: [] }));
    expect(w.mirror.snapshot(w.keys.messages)).toEqual({ items: {}, order: [], next: 'next' });
  });

  it('atomically assembles large history, including chunks arriving before the subscribe answer', async () => {
    const w = setup(1100);
    const frames = sessionFrames(w.keys.session, w, 7);
    expect(new TextEncoder().encode(JSON.stringify(w.session)).length).toBeGreaterThan(
      MAX_TOPIC_FRAME,
    );
    expect(frames.every(snapshotFrameFits)).toBe(true);
    const done = vi.fn();
    const waiting = w.mirror.whenAt(w.keys.session, 7).then(done);
    w.mirror.subscribe(w.keys.session, vi.fn());
    w.core.send(...frames.slice(1, -1));
    w.core.pending[0]?.resolve(frame(frames, 0));
    await tick();
    expect(w.mirror.snapshot(w.keys.session)).toBeUndefined();
    expect(done).not.toHaveBeenCalled();
    w.core.send(frame(frames, -1));
    await waiting;
    expect(w.mirror.snapshot(w.keys.session)).toEqual(w.session);
    w.mirror.subscribe(w.keys.run, vi.fn());
    w.mirror.subscribe(w.keys.messages, vi.fn());
    w.core.answer(1, w.run);
    w.core.answer(2, w.messages);
    await tick();
    const attempt = w.mirror.snapshot(w.keys.run)?.agents[w.agent]?.attempts?.work?.[0];
    const message = w.mirror.snapshot(w.keys.messages)?.items[w.id];
    expect(message?.id).toBe(attempt?.messageId);
    const session = w.mirror.snapshot(w.keys.session);
    expect(session?.entries[message?.delivery?.as ?? '']).toMatchObject({ kind: 'user' });
    const child = session?.entries.child;
    expect(session?.entries[child?.kind === 'text' ? (child.parent ?? '') : '']).toMatchObject({
      kind: 'tool',
    });
  });

  it('accepts one intrinsically oversized entry alone', async () => {
    const w = setup();
    const session = {
      ...w.session,
      entries: {
        huge: { id: 'huge', kind: 'text' as const, text: 'x'.repeat(MAX_TOPIC_FRAME + 1) },
      },
      order: ['huge'],
    };
    const frames = sessionFrames(w.keys.session, { ...w, session });
    w.mirror.subscribe(w.keys.session, vi.fn());
    w.core.pending[0]?.resolve(frame(frames, 0));
    w.core.send(...frames.slice(1));
    await tick();
    expect(w.mirror.snapshot(w.keys.session)).toEqual(session);
  });

  it.each(['run', 'sessions', 'messages'] as const)(
    'assembles keyed %s snapshots by the same protocol',
    async (kind) => {
      const w = setup();
      const topic = w.keys[kind];
      const base = { topic, epoch: 'one', snapshot: 's' };
      const pairs =
        kind === 'run'
          ? Object.entries(w.run.agents)
          : kind === 'sessions'
            ? Object.entries(w.sessions.agents)
            : Object.entries(w.messages.items);
      const top = { running: w.run.running, notices: w.run.notices };
      const summary = kind === 'run' ? top : kind === 'sessions' ? {} : { next: w.messages.next };
      w.mirror.subscribe(topic, vi.fn());
      w.core.pending[0]?.resolve({ ...base, kind: 'begin', summary, count: 1 });
      w.core.send(
        {
          ...base,
          kind: 'chunk',
          index: 0,
          entries: pairs.map(([key, value]) => ({ key, value })),
        },
        { ...base, kind: 'end', rev: 1 },
      );
      await tick();
      expect(w.mirror.snapshot(topic)).toEqual(w[kind]);
    },
  );

  it.each([
    'duplicate',
    'wrong-transfer',
    'early-end',
    'delta',
    'bad-append',
    'bad-order',
    'oversized-summary',
    'chunk-before-begin',
  ] as const)('resubscribes after %s without publishing partial state', async (fault) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = setup();
    const topic = w.keys.session;
    w.mirror.subscribe(topic, vi.fn());
    w.core.answer(0, w.session);
    await tick();
    const first = w.mirror.snapshot(topic);
    const waiter = w.mirror.whenAt(topic, 9);
    const rejected = expect(waiter).rejects.toMatchObject({ code: 'unavailable' });
    if (fault === 'bad-append' || fault === 'bad-order') {
      w.core.send(
        delta({
          topic,
          rev: 1,
          entries:
            fault === 'bad-append'
              ? { append: [{ id: 'absent', text: 'x' }] }
              : { order: ['absent'] },
        }),
      );
    } else {
      w.core.send(delta({ topic, rev: 2, entries: {} })); // request a fresh snapshot
      const frames = sessionFrames(topic, w, 2);
      const begin = frame(frames, 0);
      if (fault === 'chunk-before-begin') w.core.pending[1]?.resolve(frame(frames, 1));
      else {
        w.core.pending[1]?.resolve(
          fault === 'oversized-summary'
            ? {
                ...begin,
                kind: 'begin',
                count: 3,
                summary: { ...w.session.summary, reply: 'x'.repeat(MAX_TOPIC_FRAME) },
              }
            : begin,
        );
        await tick();
        const chunk = frame(frames, 1);
        const base = { topic, epoch: 'one', snapshot: 'transfer' };
        const updates: MirrorUpdate[] =
          fault === 'duplicate'
            ? [chunk, chunk]
            : fault === 'wrong-transfer'
              ? [{ ...chunk, snapshot: 'other' }]
              : fault === 'delta'
                ? [delta({ topic, rev: 3, entries: {} })]
                : fault === 'early-end'
                  ? [{ ...base, kind: 'end', rev: 2 }]
                  : [];
        w.core.send(...updates);
      }
    }
    await rejected;
    expect(w.mirror.snapshot(topic)).toBe(first);
    const count = w.core.requests.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.core.requests.length).toBe(count + 1);
  });

  it.each(['swap', 'repeat', 'gap'] as const)(
    'discards a %s in chunk indices and keeps the previous snapshot until a fresh one ends',
    async (fault) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const w = setup();
      const topic = w.keys.session;
      w.mirror.subscribe(topic, vi.fn());
      w.core.answer(0, w.session, 1);
      await tick();
      const first = w.mirror.snapshot(topic);
      w.core.send(delta({ topic, rev: 3, entries: {} }));
      const base = { topic, epoch: 'one', snapshot: 'indexed' };
      const chunks = w.session.order.map((key, index) => ({
        ...base,
        kind: 'chunk' as const,
        index,
        entries: [{ key, value: w.session.entries[key] }],
      }));
      const firstChunk = chunks[0];
      const second = chunks[1];
      const third = chunks[2];
      if (!firstChunk || !second || !third)
        throw new Error('The fixture has three distinct entries.');
      const updates =
        fault === 'swap'
          ? [firstChunk, third, second]
          : fault === 'repeat'
            ? [firstChunk, { ...second, index: 0 }, third]
            : [firstChunk, { ...second, index: 2 }, { ...third, index: 3 }];
      const settled = w.mirror.whenAt(topic, 3).then(
        () => 'resolved',
        () => 'rejected',
      );
      w.core.pending[1]?.resolve({ ...base, kind: 'begin', summary: w.session.summary, count: 3 });
      await tick();
      w.core.send(...updates, { ...base, kind: 'end', rev: 3 });
      expect(w.mirror.snapshot(topic)).toBe(first);
      expect(w.mirror.revision(topic)).toBe(1);
      expect(await settled).toBe('rejected');
      await vi.advanceTimersByTimeAsync(100);
      expect(w.core.requests).toHaveLength(3);
      const frames = sessionFrames(topic, w, 3);
      w.core.pending[2]?.resolve(frame(frames, 0));
      w.core.send(...frames.slice(1, -1));
      await tick();
      expect(w.mirror.revision(topic)).toBe(1);
      w.core.send(frame(frames, -1));
      expect(w.mirror.revision(topic)).toBe(3);
      expect(w.mirror.snapshot(topic)).toBe(first);
    },
  );

  it('counts chunks rather than entries and installs only at end', async () => {
    const w = setup();
    const topic = w.keys.session;
    const base = { topic, epoch: 'one', snapshot: 'one-chunk' };
    w.mirror.subscribe(topic, vi.fn());
    w.core.pending[0]?.resolve({ ...base, kind: 'begin', summary: w.session.summary, count: 1 });
    await tick();
    const chunk = {
      ...base,
      kind: 'chunk' as const,
      index: 0,
      entries: w.session.order.map((key) => ({ key, value: w.session.entries[key] })),
    };
    w.core.send(chunk);
    expect(w.mirror.snapshot(topic)).toBeUndefined();
    w.core.send({ ...base, kind: 'end', rev: 1 });
    expect(w.mirror.snapshot(topic)).toEqual(w.session);
  });

  it('publishes contiguous indices and a chunk count, with an empty history using no chunks', () => {
    const w = setup(1100);
    const frames = sessionFrames(w.keys.session, w);
    const chunks = frames.filter((part) => part.kind === 'chunk');
    expect(chunks.length).toBeGreaterThan(1);
    expect(frame(frames, 0)).toMatchObject({ kind: 'begin', count: chunks.length });
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(frames.every(snapshotFrameFits)).toBe(true);
    const empty = sessionFrames(w.keys.session, {
      ...w,
      session: { ...w.session, entries: {}, order: [] },
    });
    expect(empty.map(({ kind }) => kind)).toEqual(['begin', 'end']);
    expect(frame(empty, 0)).toMatchObject({ count: 0 });
  });

  it.each([0, 600])(
    'the fake publisher delivers %s retained turns through the indexed subscription',
    async (history) => {
      const w = setup(history);
      const world = history ? w : { ...w, session: { ...w.session, entries: {}, order: [] } };
      const waiting = w.mirror.whenAt(w.keys.session, 5);
      w.core.publishSession(0, world, 5);
      await waiting;
      expect(w.mirror.snapshot(w.keys.session)).toEqual(world.session);
    },
  );

  it('refuses an oversized summary at the publisher, exposing its error without publishing a partial snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = setup();
    const topic = w.keys.session;
    w.mirror.subscribe(topic, vi.fn());
    w.core.answer(0, w.session, 1);
    await tick();
    const first = w.mirror.snapshot(topic);
    w.core.send(delta({ topic, rev: 3, entries: {} }));
    const oversized = {
      ...w,
      session: {
        ...w.session,
        summary: { ...w.session.summary, reply: 'x'.repeat(MAX_TOPIC_FRAME) },
      },
    };
    expect(() => sessionFrames(topic, oversized)).toThrow(/summary.*frame/i);
    const refused = expect(w.mirror.whenAt(topic, 3)).rejects.toThrow(/summary.*frame/i);
    w.core.publishSession(1, oversized, 3);
    await refused;
    expect(w.mirror.snapshot(topic)).toBe(first);
    expect(w.mirror.revision(topic)).toBe(1);
    expect(w.core.requests).toHaveLength(2);
  });

  it('times out a missing end and cancels its timer on disposal', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = setup();
    w.mirror.subscribe(w.keys.session, vi.fn());
    w.core.answer(0, w.session, 1);
    await tick();
    const previous = w.mirror.snapshot(w.keys.session);
    w.core.send(delta({ topic: w.keys.session, rev: 3, entries: {} }));
    const frames = sessionFrames(w.keys.session, w, 3);
    w.core.pending[1]?.resolve(frame(frames, 0));
    w.core.send(...frames.slice(1, -1));
    await tick();
    expect(w.mirror.snapshot(w.keys.session)).toBe(previous);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.core.requests).toHaveLength(3);
    expect(w.mirror.snapshot(w.keys.session)).toBe(previous);
    expect(w.mirror.revision(w.keys.session)).toBe(1);
    w.mirror.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects old-epoch waiters and transfers, permits seq jumps and resnapshots a revision gap', async () => {
    const w = setup();
    w.mirror.subscribe(w.keys.session, vi.fn());
    const waiting = w.mirror.whenAt(w.keys.session, 10);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    const old = sessionFrames(w.keys.session, w, 20);
    w.core.pending[0]?.resolve(frame(old, 0));
    await tick();
    w.core.epoch('two');
    await rejected;
    w.core.send(...old.slice(1));
    w.core.answer(1, w.session);
    await tick();
    w.core.send({
      ...delta({
        topic: w.keys.session,
        rev: 1,
        entries: { append: [{ id: 'child', text: '!' }] },
      }),
      epoch: 'two',
      seq: 999,
    });
    expect(w.mirror.snapshot(w.keys.session)?.entries.child).toMatchObject({ text: 'Working!' });
    w.core.send({ ...delta({ topic: w.keys.session, rev: 3, entries: {} }), epoch: 'two' });
    expect(w.core.requests).toHaveLength(3);
    w.core.answer(2, w.session, 3);
    await tick();
    expect(w.mirror.revision(w.keys.session)).toBe(3);
  });

  it('keeps the last complete snapshot through a reconnect and then applies the first post-end delta', async () => {
    const w = setup();
    w.mirror.subscribe(w.keys.session, vi.fn());
    w.core.answer(0, w.session, 1);
    await tick();
    const first = w.mirror.snapshot(w.keys.session);
    w.core.send(delta({ topic: w.keys.session, rev: 3, entries: {} }));
    const frames = sessionFrames(w.keys.session, w, 3);
    w.core.pending[1]?.resolve(frame(frames, 0));
    await tick();
    w.core.send(...frames.slice(1, -1));
    expect(w.mirror.snapshot(w.keys.session)).toBe(first);
    expect(w.mirror.revision(w.keys.session)).toBe(1);
    const waiting = w.mirror.whenAt(w.keys.session, 4);
    w.core.send(
      frame(frames, -1),
      delta({ topic: w.keys.session, rev: 4, entries: { append: [{ id: 'child', text: '!' }] } }),
    );
    await waiting;
    expect(w.mirror.snapshot(w.keys.session)?.entries.user).toBe(first?.entries.user);
    expect(w.mirror.snapshot(w.keys.session)?.entries.child).toMatchObject({ text: 'Working!' });
  });

  it('requires chunking an oversized whole snapshot and recovers from a malformed transfer', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = setup(600);
    w.mirror.subscribe(w.keys.session, vi.fn());
    const waiting = w.mirror.whenAt(w.keys.session, 1);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    w.core.answer(0, w.session, 1);
    await rejected;
    expect(w.mirror.snapshot(w.keys.session)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    const frames = sessionFrames(w.keys.session, w, 1);
    w.core.pending[1]?.resolve(frame(frames, 0));
    w.core.send(...frames.slice(1));
    await tick();
    expect(w.mirror.snapshot(w.keys.session)).toEqual(w.session);
  });

  it('shares entries across summary-only changes and exposes their ordered hook', async () => {
    const w = setup();
    const hook = renderHook(() => useSessionEntries(w.canvas, w.agent, w.mirror));
    await act(async () => {
      w.core.answer(0, w.session);
      await tick();
    });
    const entries = hook.result.current;
    await act(async () => {
      w.core.send(
        delta({
          topic: w.keys.session,
          rev: 1,
          summary: { ...w.session.summary, status: 'idle' },
          entries: {},
        }),
      );
      await tick();
    });
    expect(hook.result.current).toBe(entries);
    expect(entries.map(({ id }) => id)).toEqual(w.session.order);
    hook.unmount();
  });

  it('holds one runtime subscription through StrictMode cleanup, then releases it and its timers', async () => {
    vi.useFakeTimers();
    const w = setup();
    const stop = w.mirror.subscribe(w.keys.session, vi.fn());
    stop();
    const again = w.mirror.subscribe(w.keys.session, vi.fn());
    await tick();
    expect(w.core.requests).toHaveLength(1);
    w.core.pending[0]?.resolve(frame(sessionFrames(w.keys.session, w), 0));
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    again();
    await tick();
    expect(w.core.unsubscriptions).toEqual([
      { topic: 'session', canvas: w.canvas, agent: w.agent },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes view-only hooks and stable ordered selectors without a renderer engine', async () => {
    const w = setup();
    const hook = renderHook(() => ({
      run: useRunView(w.canvas, w.mirror),
      summaries: useSessionSummaries(w.canvas, w.mirror),
      session: useSessionView(w.canvas, w.agent, w.mirror),
      messages: useAgentMessages(w.canvas, w.agent, w.mirror),
    }));
    await act(async () => {
      w.core.answer(0, w.run);
      w.core.answer(1, w.sessions);
      w.core.answer(2, w.session);
      w.core.answer(3, w.messages);
      await tick();
    });
    expect(hook.result.current.run).toEqual(w.run);
    expect(hook.result.current.summaries).toEqual(w.sessions.agents);
    expect(orderedEntries(hook.result.current.session)).toBe(
      orderedEntries(hook.result.current.session),
    );
    expect(hook.result.current.messages).toEqual([w.message]);
    expect(messagesForAgent(w.messages, AgentId.parse('absent'))).toEqual([]);
    const messages = hook.result.current.messages;
    await act(async () => {
      w.core.send(delta({ topic: w.keys.run, rev: 1, top: { running: false } }));
      await tick();
    });
    expect(hook.result.current.messages).toBe(messages);
    hook.unmount();
  });
});
