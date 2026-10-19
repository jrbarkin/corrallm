import { describe, expect, it, vi } from 'vitest';

import type { Change, TopicKey, TopicSnapshot } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import { topicKey } from '../../shared/api/topics';
import { TopicMirror } from './topics';
import type { TopicSource } from './topics';

const empty = { readings: [], rules: {} };
const settings = { defaultAdapter: 'codex', consents: {} };
function source(connected = true) {
  let change: ((changes: Change[]) => void) | undefined;
  let epoch: ((epoch: string) => void) | undefined;
  const pending: { topic: TopicKey; resolve: (snapshot: TopicSnapshot) => void }[] = [];
  const api: TopicSource = {
    topicsSubscribe: vi.fn<TopicSource['topicsSubscribe']>(
      (request) =>
        new Promise<TopicSnapshot>((resolve) => {
          pending.push({ topic: topicKey(request), resolve });
        }),
    ),
    topicsUnsubscribe: vi.fn().mockResolvedValue({}),
    topicsOnChange: (listener) => {
      change = listener;
      return () => {
        change = undefined;
      };
    },
    topicsOnEpoch: (listener) => {
      epoch = listener;
      if (connected) listener('one');
      return () => {
        epoch = undefined;
      };
    },
  };
  return {
    api,
    pending,
    change: (batch: Change[]) => change?.(batch),
    epoch: (next: string) => epoch?.(next),
  };
}
function changed(rev: number, percent: number, epoch = 'one'): Extract<Change, { topic: 'usage' }> {
  return {
    topic: 'usage',
    epoch,
    rev,
    seq: rev,
    by: 'you',
    at: 1,
    replace: { readings: [], rules: { codex: { window: 'weekly', percent, action: 'ask' } } },
  };
}

describe('the topic mirror', () => {
  it('does not mistake a revision in a restarted core for an old write’s revision', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const waiting = mirror.whenAt('usage', 2);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    remote.epoch('two');
    await rejected;
    mirror.dispose();
  });
  it('applies keyed canvas changes without replacing unchanged entities, including equal sets', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const canvas = 'a' as CanvasId;
    const topic = `canvas:${canvas}` as const;
    mirror.subscribe(topic, vi.fn());
    expect(remote.api.topicsSubscribe).toHaveBeenCalledExactlyOnceWith({ topic: 'canvas', canvas });
    const one = { id: 'one', label: 'Builder', rev: 1 };
    const two = { id: 'two', label: 'Reviewer', rev: 1 };
    const initial = { meta: { name: 'Work' }, 'node/one': one, 'node/two': two };
    remote.pending[0]?.resolve({ epoch: 'one', rev: 0, state: initial });
    await vi.waitFor(() => {
      expect(mirror.snapshot(topic)).toBe(initial);
    });
    remote.change([
      {
        topic,
        epoch: 'one',
        rev: 1,
        seq: 1,
        by: 'you',
        at: 1,
        set: { 'node/one': { ...one }, 'node/three': { id: 'three', rev: 1 } },
        remove: ['node/two'],
      },
    ]);
    expect(mirror.snapshot(topic)).toEqual({
      meta: initial.meta,
      'node/one': one,
      'node/three': { id: 'three', rev: 1 },
    });
    expect(mirror.snapshot(topic)?.['node/one']).toBe(one);
    expect(mirror.snapshot(topic)?.meta).toBe(initial.meta);
    expect(initial['node/two']).toBe(two);
    const latest = mirror.snapshot(topic);
    remote.change([
      { topic, epoch: 'one', rev: 2, seq: 2, by: 'you', at: 2, set: { 'node/one': { ...one } } },
    ]);
    expect(mirror.snapshot(topic)).toBe(latest);
    remote.change([
      {
        topic,
        epoch: 'one',
        rev: 3,
        seq: 3,
        by: 'you',
        at: 3,
        replace: { ...latest, 'node/one': { ...one } },
      },
    ]);
    expect(mirror.snapshot(topic)).toBe(latest);
    mirror.dispose();
  });

  it('keeps canvas subscriptions separate and resubscribes a keyed revision gap', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const canvas = 'a' as CanvasId;
    const other = 'b' as CanvasId;
    const topic = `canvas:${canvas}` as const;
    mirror.subscribe(topic, vi.fn());
    mirror.subscribe(`needs:${other}`, vi.fn());
    expect(remote.api.topicsSubscribe).toHaveBeenLastCalledWith({ topic: 'needs', canvas: other });
    remote.pending[0]?.resolve({ epoch: 'one', rev: 1, state: { meta: { name: 'Old' } } });
    remote.pending[1]?.resolve({ epoch: 'one', rev: 1, state: { items: [] } });
    await vi.waitFor(() => {
      expect(mirror.snapshot(topic)).toBeDefined();
    });
    remote.change([
      { topic, epoch: 'one', rev: 3, seq: 7, by: 'you', at: 1, set: { meta: { name: 'New' } } },
    ]);
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(3);
    expect(mirror.snapshot(topic)).toEqual({ meta: { name: 'Old' } });
    remote.pending[2]?.resolve({ epoch: 'one', rev: 3, state: { meta: { name: 'New' } } });
    await vi.waitFor(() => {
      expect(mirror.snapshot(topic)).toEqual({ meta: { name: 'New' } });
    });
    expect(mirror.snapshot(`needs:${other}`)).toEqual({ items: [] });
    mirror.dispose();
  });

  it('waits for a revision with its own subscription, including a change before the snapshot', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const arrived = vi.fn();
    const waiting = mirror.whenAt('usage', 2).then(arrived);
    const stop = mirror.subscribe('usage', vi.fn());
    remote.change([changed(2, 90)]);
    remote.pending[0]?.resolve({ epoch: 'one', rev: 1, state: empty });
    await waiting;
    expect(arrived).toHaveBeenCalledOnce();
    expect(mirror.snapshot('usage')?.rules.codex?.percent).toBe(90);
    await expect(mirror.whenAt('usage', 1)).resolves.toBeUndefined();
    stop();
    mirror.dispose();
  });

  it('rejects revision waiters when subscribing fails or the mirror is disposed', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const waiting = mirror.whenAt('usage', 1);
    const rejected = expect(waiting).rejects.toThrow(/closed/i);
    mirror.dispose();
    await rejected;
    const error = new Error('No such canvas');
    remote.api.topicsSubscribe = vi.fn().mockRejectedValue(error);
    const failed = new TopicMirror(remote.api);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(failed.whenAt('usage', 1)).rejects.toBe(error);
    failed.dispose();
    log.mockRestore();
  });

  it('subscribes once per topic, keeps a stable latest snapshot, and unsubscribes after its last listener', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const heard = vi.fn();
    const stop = mirror.subscribe('usage', heard);
    const other = mirror.subscribe('usage', vi.fn());
    mirror.subscribe('settings', vi.fn());
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(2);
    expect(mirror.snapshot('usage')).toBeUndefined();
    remote.pending[0]?.resolve({ epoch: 'one', rev: 0, state: empty });
    remote.pending[1]?.resolve({ epoch: 'one', rev: 0, state: settings });
    await vi.waitFor(() => {
      expect(mirror.snapshot('usage')).toBe(empty);
    });
    expect(mirror.snapshot('settings')).toBe(settings);
    const change = changed(1, 80);
    remote.change([change]);
    expect(mirror.snapshot('usage')).toBe(change.replace);
    expect(mirror.snapshot('usage')).toBe(mirror.snapshot('usage'));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    await Promise.resolve();
    expect(remote.api.topicsUnsubscribe).not.toHaveBeenCalled();
    other();
    await vi.waitFor(() => {
      expect(remote.api.topicsUnsubscribe).toHaveBeenCalledWith({ topic: 'usage' });
    });
    mirror.dispose();
  });

  it('re-subscribes every active topic on a new epoch, ignoring an old answer and old changes', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    mirror.subscribe('usage', vi.fn());
    mirror.subscribe('settings', vi.fn());
    remote.epoch('two');
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(4);
    remote.pending[0]?.resolve({ epoch: 'one', rev: 9, state: empty });
    remote.pending[2]?.resolve({ epoch: 'two', rev: 0, state: changed(1, 20).replace });
    remote.pending[3]?.resolve({ epoch: 'two', rev: 0, state: settings });
    await vi.waitFor(() => {
      expect(mirror.snapshot('usage')?.rules.codex?.percent).toBe(20);
    });
    remote.change([changed(10, 90)]);
    expect(mirror.snapshot('usage')?.rules.codex?.percent).toBe(20);
    remote.epoch('two');
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(4);
    mirror.dispose();
  });

  it('keeps changes arriving ahead of a subscribe answer and re-reads a revision gap', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    mirror.subscribe('usage', vi.fn());
    remote.change([changed(1, 20)]);
    remote.pending[0]?.resolve({ epoch: 'one', rev: 0, state: empty });
    await vi.waitFor(() => {
      expect(mirror.snapshot('usage')?.rules.codex?.percent).toBe(20);
    });
    remote.change([changed(3, 30), changed(4, 40)]);
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(2);
    remote.pending[1]?.resolve({ epoch: 'one', rev: 4, state: changed(4, 40).replace });
    await vi.waitFor(() => {
      expect(mirror.snapshot('usage')?.rules.codex?.percent).toBe(40);
    });
    remote.change([changed(2, 10)]);
    expect(mirror.snapshot('usage')?.rules.codex?.percent).toBe(40);
    mirror.dispose();
  });

  it('waits for the first core epoch instead of subscribing twice while its port arrives', () => {
    const remote = source(false);
    const mirror = new TopicMirror(remote.api);
    mirror.subscribe('usage', vi.fn());
    expect(remote.api.topicsSubscribe).not.toHaveBeenCalled();
    remote.epoch('one');
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(1);
    mirror.dispose();
  });

  it('keeps one subscription through immediate cleanup and re-subscription', async () => {
    const remote = source();
    const mirror = new TopicMirror(remote.api);
    const stop = mirror.subscribe('usage', vi.fn());
    stop();
    mirror.subscribe('usage', vi.fn());
    await Promise.resolve();
    expect(remote.api.topicsSubscribe).toHaveBeenCalledTimes(1);
    expect(remote.api.topicsUnsubscribe).not.toHaveBeenCalled();
    mirror.dispose();
  });
});
