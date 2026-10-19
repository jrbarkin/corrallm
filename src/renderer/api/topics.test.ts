import { describe, expect, it, vi } from 'vitest';

import type { Change, TopicKey, TopicSnapshot } from '../../shared/api/topics';
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
      ({ topic }) =>
        new Promise((resolve) => {
          pending.push({
            topic,
            resolve: (snapshot) => {
              resolve({ ...snapshot, revs: {} });
            },
          });
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
function changed(rev: number, percent: number, epoch = 'one'): Change {
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
