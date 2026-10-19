import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPS, opsFor } from '../../shared/api/registry';
import { GUI_OPS, SURFACE } from '../../shared/api/surface';
import type { Change } from '../../shared/api/topics';
import type { Settings } from '../settings';
import { createCore } from './core';
import type { Core } from './core';
import { WindowPorts } from './gui';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { openWindow } from './test-window';

let profile: string;
let core: Core;
const closing: (() => void)[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-topics-'));
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1' },
      check: true,
      distribution: 'local',
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

/** T3c: topic state is the corresponding read's, and only subscribed windows hear it. */
describe('T3c: usage and settings topics', () => {
  function connect(served: WindowPorts, id: number) {
    const window = openWindow(served, id);
    closing.push(window.close);
    const changes: Change[] = [];
    const epochs: string[] = [];
    window.link.on('topic', (batch) => changes.push(...batch));
    window.link.on('epoch', (epoch) => epochs.push(epoch));
    return { ...window, changes, epochs };
  }

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
    window.link.on('topic', (batch) => batches.push(batch));
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
