import { afterEach, expect, it, vi } from 'vitest';
import { MAX_TOPIC_FRAME } from '../../shared/api/limits';
import { OPS } from '../../shared/api/registry';
import type { RuntimeSnapshotFrame, TopicUpdate } from '../../shared/api/topics';
import type { Entities, NodeEntity } from '../../shared/model/state';
import type { OpContext } from './call';
import { Topics } from './topics';
import { CALLERS, CANVAS } from './test-registry';

let topics: Topics | undefined;
afterEach(() => {
  topics?.close();
});

it('keeps an empty canonical Needs baseline at zero, then receipts changes without a subscriber', async () => {
  const topic = `needs:${CANVAS}` as const;
  let state: { items: unknown[] } = { items: [] };
  topics = new Topics({
    read: () => Promise.resolve({ ok: true, value: state }),
    canonical: {
      of: (key) => key === topic,
      initial: () => ({ items: [] }),
      read: () => Promise.resolve(state as never),
    },
  });
  const since = topics.mark();
  topics.changed(topic, 'corrallm');
  expect(await topics.receipts([topic], since)).toEqual({});
  state = { items: [{ id: 'a-workspace-card' }] };
  topics.changed(topic, 'you');
  expect(await topics.receipts([topic], since)).toEqual({ [topic]: 1 });
  const after = topics.mark();
  state = { items: [] };
  topics.changed(topic, 'you');
  expect(await topics.receipts([topic], after)).toEqual({ [topic]: 2 });
});

it('does not receipt the first read of an unchanged canonical source as a write’s change', async () => {
  const topic = `worktrees:${CANVAS}` as const;
  const state = { items: [], kept: [] };
  topics = new Topics({
    read: () => Promise.resolve({ ok: true, value: state }),
    canonical: { of: (key) => key === topic, read: () => Promise.resolve(state) },
  });
  const since = topics.mark();
  expect(await topics.receipts([topic], since)).toEqual({});
  expect(await topics.receipts([topic], since)).toEqual({});
  expect(
    await topics.subscribe(1, { topic: 'worktrees', canvas: CANVAS }, {
      caller: CALLERS.you,
      signal: new AbortController().signal,
    } as OpContext),
  ).toMatchObject({ state, rev: 1 });
});

it('moves your worktrees revision at each change, a window watching or not, and receipts it', async () => {
  const topic = `worktrees:${CANVAS}` as const;
  let state = { items: [{ agent: 'a', state: 'creating' }], kept: [] as unknown[] };
  const read = vi.fn(() => Promise.resolve({ ok: true as const, value: state }));
  topics = new Topics({
    read,
    canonical: {
      of: (key) => key.startsWith('worktrees:'),
      read: () => Promise.resolve(state as never),
    },
  });
  // No one subscribes: its revision moves with its source all the same, never on a no-op.
  let since = topics.mark();
  topics.changed(topic, 'corrallm');
  expect(await topics.receipts([topic], since)).toEqual({ [topic]: 1 });
  since = topics.mark();
  expect(await topics.receipts([topic], since)).toEqual({});
  state = { items: [{ agent: 'a', state: 'ready' }], kept: [] };
  // A write naming it reads it again before its receipts: what it changed, not what a window saw.
  expect(await topics.receipts([topic], since)).toEqual({ [topic]: 2 });
  expect(read).not.toHaveBeenCalled();
  // A window subscribing then is answered at that revision, then hears the next change.
  const batches: TopicUpdate[][] = [];
  topics.listen(1, (batch) => batches.push(batch));
  expect(
    await topics.subscribe(1, { topic: 'worktrees', canvas: CANVAS }, {
      caller: CALLERS.you,
      signal: new AbortController().signal,
    } as OpContext),
  ).toMatchObject({ rev: 2, state });
  state = { items: [], kept: [] };
  topics.changed(topic, 'you');
  await vi.waitFor(() => {
    expect(batches.flat()).toEqual([expect.objectContaining({ topic, rev: 3, replace: state })]);
  });
});

it('bounds a large canvas subscription and live replacement using indexed transfers', async () => {
  let rev = 1;
  let entities: Entities = Object.fromEntries(
    Array.from({ length: 600 }, (_, place) => {
      const id = `a${String(place)}`;
      return [
        `node/${id}`,
        {
          id,
          kind: 'agent',
          place,
          label: id,
          x: 0,
          y: 0,
          role: 'x'.repeat(2048),
          rev,
          by: 'you',
        } satisfies NodeEntity,
      ];
    }),
  );
  topics = new Topics({
    read: () => Promise.resolve({ ok: true, value: entities }),
    view: () => ({ rev, entities, all: true }),
  });
  const batches: TopicUpdate[][] = [];
  topics.listen(1, (batch) => batches.push(batch));
  const first = await topics.subscribe(1, { topic: 'canvas', canvas: CANVAS }, {
    caller: CALLERS.you,
    signal: new AbortController().signal,
  } as OpContext);
  expect(first).toMatchObject({ kind: 'begin', topic: `canvas:${CANVAS}`, count: 2 });
  expect(OPS['topics.subscribe'].output.safeParse({ ...first, revs: {} }).success).toBe(true);
  await vi.waitFor(() => {
    expect(batches.flat().at(-1)).toMatchObject({ kind: 'end', rev: 1 });
  });
  const frames = [first as RuntimeSnapshotFrame, ...batches.flat()] as RuntimeSnapshotFrame[];
  expect(
    frames.filter((frame) => frame.kind === 'chunk').flatMap((frame) => frame.entries),
  ).toEqual(Object.entries(entities).map(([key, value]) => ({ key, value })));
  batches.length = 0;
  rev = 2;
  entities = Object.fromEntries(
    Object.entries(entities).map(([key, value]) => [key, { ...value, rev }]),
  );
  topics.publish(CANVAS, { rev, by: 'you', set: entities });
  await vi.waitFor(() => {
    expect(batches.flat().at(-1)).toMatchObject({ kind: 'end', rev: 2 });
  });
  expect(batches.flat()[0]).toMatchObject({ kind: 'begin' });
  for (const batch of batches)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(MAX_TOPIC_FRAME);
});

it('keeps the settings’ default agent and api in a chunked snapshot’s summary (B12 C2)', async () => {
  // Enough consents that the settings can't go in one frame.
  const consents = Object.fromEntries(
    Array.from({ length: 30_000 }, (_, n) => [
      `adapter-${String(n).padStart(8, '0')}`,
      { [`key-${'k'.repeat(20)}`]: true },
    ]),
  );
  const api = { state: 'listening', port: 4242, url: 'http://127.0.0.1:4242/mcp' } as const;
  const settings = { defaultAdapter: 'codex', consents, api };
  topics = new Topics({ read: () => Promise.resolve({ ok: true, value: settings }) });
  const batches: TopicUpdate[][] = [];
  topics.listen(1, (batch) => batches.push(batch));
  const ctx = { caller: CALLERS.you, signal: new AbortController().signal } as OpContext;
  const first = await topics.subscribe(1, { topic: 'settings' }, ctx);
  expect(first).toMatchObject({
    kind: 'begin',
    topic: 'settings',
    summary: { defaultAdapter: 'codex', api },
  });
  await vi.waitFor(() => {
    expect(batches.flat().at(-1)).toMatchObject({ kind: 'end' });
  });
  const frames = batches.flat() as RuntimeSnapshotFrame[];
  expect(
    frames.filter((frame) => frame.kind === 'chunk').flatMap((frame) => frame.entries),
  ).toEqual(Object.entries(consents).map(([key, value]) => ({ key, value })));
  // None is said as none.
  topics.close();
  topics = new Topics({
    read: () => Promise.resolve({ ok: true, value: { ...settings, defaultAdapter: null } }),
  });
  expect(await topics.subscribe(1, { topic: 'settings' }, ctx)).toMatchObject({
    kind: 'begin',
    summary: { defaultAdapter: null, api },
  });
});
