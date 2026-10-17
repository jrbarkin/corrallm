import { describe, expect, it, vi } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { groupControlText, groupPaused, individualPaused } from './controls';
import { RunStore } from './runner';
import type { RunIO, TurnEnd } from './runner';

const frame = (id: string, parentId?: string): GraphNode => ({
  id,
  type: 'frame',
  position: { x: 0, y: 0 },
  data: { label: id },
  ...(parentId ? { parentId } : {}),
});
const agent = (
  id: string,
  parentId?: string,
  queue: QueueItem[] = [
    { id: 'one', message: `${id}:one` },
    { id: 'two', message: `${id}:two` },
  ],
): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, connection: 'sdk', queue },
  ...(parentId ? { parentId } : {}),
});
const tree = () => [
  frame('outer'),
  agent('parent', 'outer'),
  frame('inner', 'parent'),
  agent('a', 'inner'),
  agent('b', 'parent'),
  agent('c', 'outer'),
  agent('outside'),
];
const moved = (node: GraphNode, parentId?: string): GraphNode => {
  const rest = { ...node };
  delete rest.parentId;
  return { ...rest, ...(parentId ? { parentId } : {}) };
};

function setup(nodes: GraphNode[], extra: Partial<RunIO> = {}) {
  const events: string[] = [];
  const sent: {
    agent: string;
    text: string;
    done?: (turn: TurnEnd) => void;
    withdrawn: boolean;
  }[] = [];
  const store = new RunStore({
    send: (node, text, done) => {
      const entry = { agent: node.id, text, done, withdrawn: false };
      sent.push(entry);
      return () => {
        events.push(`withdraw:${node.id}`);
        entry.withdrawn = true;
      };
    },
    hold: (id, held) => {
      events.push(`hold:${id}:${String(held)}`);
    },
    tell: () => undefined,
    connect: () => undefined,
    later: () => () => undefined,
    now: () => 1234,
    ...extra,
  });
  store.update(nodes);
  return {
    store,
    sent,
    events,
    texts: () => sent.map(({ text }) => text),
    reply: (id: string, reply = 'Done.') => {
      const entry = sent.find(({ agent, done }) => agent === id && done);
      if (!entry?.done) throw new Error(`No turn for ${id}`);
      const done = entry.done;
      delete entry.done;
      done({ failed: false, reply });
    },
  };
}

describe('group scheduler controls', () => {
  it.each(['moved-out', 'deleted'] as const)(
    'releases a ready checkpointed send when its group is %s',
    async (change) => {
      let release: (() => void) | undefined;
      let saved = false;
      const { store, texts } = setup([frame('g'), agent('a', 'g')], {
        beforeSend: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          saved = true;
        },
      });
      store.start();
      await Promise.resolve();
      store.pauseGroup('g');
      release?.();
      await vi.waitFor(() => {
        expect(saved).toBe(true);
      });
      expect(texts()).toEqual([]);
      store.update(change === 'moved-out' ? [frame('g'), agent('a')] : [agent('a')]);
      expect(texts()).toEqual(['a:one']);
      store.resumeGroup('g');
      expect(texts()).toEqual(['a:one']);
    },
  );

  it('keeps a moved-out agent’s individual hold without retaining the old group hold', () => {
    const { store, texts } = setup([frame('g'), agent('a', 'g')]);
    store.pauseGroup('g');
    store.pauseAgent('a');
    store.start();
    store.update([frame('g'), agent('a')]);
    expect(texts()).toEqual([]);
    expect(store.snapshot().groupPauses).toEqual(['g']);
    store.resumeAgent('a');
    expect(texts()).toEqual(['a:one']);
  });

  it('publishes a group control once after installing all aggregate flags', () => {
    const { store } = setup([frame('g'), agent('a', 'g'), agent('b', 'g')]);
    store.start();
    const snapshots: ReturnType<typeof store.snapshot>[] = [];
    store.subscribe(() => {
      snapshots.push(store.snapshot());
    });
    store.killGroup('g');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.agents.a?.paused).toBe(true);
    expect(snapshots[0]?.agents.b?.paused).toBe(true);
    expect(snapshots[0]?.groupPauses).toEqual(['g']);
  });

  it('finishes active nested members, including the parent agent, without interrupting them', () => {
    const nodes = tree();
    const { store, sent, reply, texts } = setup(nodes);
    store.start();
    store.pauseGroup('parent');
    expect(groupControlText(nodes, store.snapshot(), 'parent')).toBe('Pausing');
    expect(sent.every(({ withdrawn }) => !withdrawn)).toBe(true);
    for (const id of ['parent', 'a', 'b']) reply(id);
    expect(groupControlText(nodes, store.snapshot(), 'parent')).toBe('Paused');
    expect(store.snapshot().groupPauses).toEqual(['parent']);
    expect(store.snapshot().individualPauses).toEqual([]);
    reply('outside');
    reply('c');
    expect(texts().slice(-2)).toEqual(['outside:two', 'c:two']);
    for (const id of ['parent', 'a', 'b'])
      expect(store.snapshot().agents[id]?.outcomes).toEqual({ one: 'succeeded' });
    store.resumeGroup('parent');
    expect(texts().slice(-3)).toEqual(['parent:two', 'a:two', 'b:two']);
  });

  it('releases only its own group cause, preserving both individual and ancestor holds', () => {
    const { store, texts } = setup(tree());
    store.pauseAgent('a');
    store.pauseGroup('outer');
    store.pauseGroup('parent');
    store.start();
    expect(texts()).toEqual(['outside:one']);
    store.resumeGroup('parent');
    expect(texts()).toEqual(['outside:one']);
    expect(store.snapshot().agents.parent?.paused).toBe(true);
    store.resumeGroup('outer');
    expect(texts()).toEqual(['outside:one', 'parent:one', 'b:one', 'c:one']);
    expect(individualPaused(store.snapshot(), 'a')).toBe(true);
    expect(store.snapshot().agents.a?.paused).toBe(true);
    store.resumeAgent('a');
    expect(texts().at(-1)).toBe('a:one');
  });

  it('does not let individual Resume release a group hold, and can add a separate individual hold', () => {
    const { store, texts } = setup([frame('g'), agent('a', 'g'), agent('b', 'g')]);
    store.pauseGroup('g');
    store.start();
    store.resumeAgent('a');
    expect(texts()).toEqual([]);
    expect(individualPaused(store.snapshot(), 'a')).toBe(false);
    store.pauseAgent('a');
    store.resumeGroup('g');
    expect(texts()).toEqual(['b:one']);
    expect(store.snapshot().individualPauses).toEqual(['a']);
    store.resumeAgent('a');
    expect(texts()).toEqual(['b:one', 'a:one']);
  });

  it('persists an empty held frame and applies it to later descendants', () => {
    const first = setup([frame('g')]);
    first.store.pauseGroup('g');
    first.store.start();
    expect(first.store.snapshot().groupPauses).toEqual(['g']);
    const second = setup([frame('g')]);
    second.store.restore(first.store.checkpoint());
    second.store.update([frame('g'), agent('a', 'g')]);
    expect(groupPaused(second.store.snapshot(), 'g')).toBe(true);
    expect(second.store.snapshot().agents.a?.paused).toBe(true);
    second.store.start();
    expect(second.sent).toHaveLength(0);
    second.store.resumeGroup('g');
    expect(second.texts()).toEqual(['a:one']);
  });

  it('recomputes holds when agents move in and out, preserving another group and individual holds', () => {
    let nodes = [frame('g'), frame('h'), agent('a', 'g'), agent('b', 'h'), agent('c'), agent('d')];
    const { store, events, texts, reply } = setup(nodes);
    store.pauseGroup('g');
    store.pauseGroup('h');
    store.pauseAgent('c');
    store.start();
    expect(texts()).toEqual(['d:one']);
    nodes = nodes.map((node) =>
      node.id === 'a' ? moved(node) : node.id === 'd' ? moved(node, 'g') : node,
    );
    store.update(nodes);
    expect(texts().at(-1)).toBe('a:one');
    expect(store.snapshot().agents.d?.paused).toBe(true);
    reply('d');
    expect(texts()).not.toContain('d:two');
    const released = events.filter((event) => event === 'hold:d:false').length;
    nodes = nodes.map((node) => (node.id === 'd' ? moved(node, 'h') : node));
    store.update(nodes);
    store.resumeGroup('g');
    expect(store.snapshot().agents.d?.paused).toBe(true);
    expect(events.filter((event) => event === 'hold:d:false')).toHaveLength(released);
    store.resumeGroup('h');
    expect(texts()).toContain('d:two');
    expect(store.snapshot().agents.c?.paused).toBe(true);
  });

  it('releases deleted and ungrouped containers while retaining individual holds', () => {
    const { store, texts } = setup([agent('parent'), agent('a', 'parent')]);
    store.pauseGroup('parent');
    store.pauseAgent('parent');
    store.start();
    store.update([agent('parent'), agent('a')]);
    expect(store.snapshot().groupPauses).toEqual([]);
    expect(store.snapshot().agents.parent?.paused).toBe(true);
    expect(texts()).toEqual(['a:one']);
    const next = setup([frame('g'), agent('b', 'g')]);
    next.store.pauseGroup('g');
    next.store.start();
    next.store.update([agent('b')]);
    expect(next.store.snapshot().groupPauses).toEqual([]);
    expect(next.texts()).toEqual(['b:one']);
  });

  it('gates incoming handoffs to every held descendant until its aggregate hold clears', () => {
    const { store, texts } = setup([
      frame('g'),
      frame('inner', 'g'),
      agent('a', 'inner', []),
      agent('outside', undefined, [{ id: 'send', message: 'Review it', target: 'a' }]),
    ]);
    store.pauseGroup('g');
    store.pauseGroup('inner');
    store.start();
    expect(texts()).toEqual([]);
    expect(store.snapshot().agents.outside?.status).toBe('waiting');
    store.resumeGroup('g');
    expect(texts()).toEqual([]);
    store.resumeGroup('inner');
    expect(texts()).toEqual(['Review it']);
  });

  it('holds every member before selectively killing owned and incoming turns', () => {
    const { store, sent, events } = setup([
      agent('parent', undefined, [{ id: 'send', message: 'Outgoing', target: 'outside' }]),
      agent('a', 'parent'),
      agent('b', 'parent'),
      agent('outside', undefined, []),
      agent('incoming', undefined, [{ id: 'send', message: 'Incoming', target: 'a' }]),
      agent('other'),
    ]);
    store.start();
    store.killGroup('parent');
    expect(events.slice(0, 3)).toEqual(['hold:parent:true', 'hold:a:true', 'hold:b:true']);
    expect(sent.map(({ withdrawn }) => withdrawn)).toEqual([true, true, true, true, false]);
    expect(store.snapshot().groupPauses).toEqual(['parent']);
    expect(store.snapshot().individualPauses).toEqual([]);
    for (const id of ['parent', 'a', 'b', 'incoming'])
      expect(store.snapshot().agents[id]?.problem?.kind).toBe('cancelled');
    expect(store.snapshot().agents.incoming?.paused).not.toBe(true);
    expect(store.snapshot().agents.other?.status).toBe('running');
  });

  it('records native correction within a killed group, while its next work stays held', () => {
    const { store, texts } = setup([frame('g'), agent('a', 'g'), agent('b', 'g')]);
    store.start();
    store.killGroup('g');
    expect(store.observeSubmission('a', 'manual', 'Correct the same request')).toEqual({
      agent: 'a',
      item: 'one',
    });
    store.observeEnd('a', 'manual', 'Corrected.', { status: 'completed', reason: 'completed' });
    expect(store.snapshot().agents.a).toMatchObject({
      paused: true,
      outcomes: { one: 'succeeded' },
    });
    expect(texts()).toEqual(['a:one', 'b:one']);
    store.resumeGroup('g');
    expect(texts().at(-1)).toBe('a:two');
    expect(store.snapshot().agents.b?.problem?.kind).toBe('cancelled');
  });

  it.each(['pause', 'kill'] as const)(
    'rechecks a group %s after the asynchronous durable barrier',
    async (choice) => {
      const releases: (() => void)[] = [];
      const { store, texts } = setup(
        [frame('g'), agent('a', 'g'), agent('b', 'g'), agent('outside')],
        {
          beforeSend: () =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        },
      );
      store.start();
      await Promise.resolve();
      if (choice === 'pause') store.pauseGroup('g');
      else store.killGroup('g');
      releases.forEach((release) => {
        release();
      });
      await vi.waitFor(() => {
        expect(texts()).toEqual(['outside:one']);
      });
      store.resumeGroup('g');
      expect(texts()).toEqual(
        choice === 'pause' ? ['outside:one', 'a:one', 'b:one'] : ['outside:one'],
      );
    },
  );

  it('restores distinct causes without replay or turning group holds into individual ones', () => {
    const first = setup(tree());
    first.store.pauseAgent('a');
    first.store.pauseGroup('outer');
    first.store.pauseGroup('parent');
    const second = setup(tree());
    second.store.restore(first.store.checkpoint());
    expect(second.store.snapshot()).toMatchObject({
      running: false,
      paused: true,
      individualPauses: ['a'],
      groupPauses: ['outer', 'parent'],
    });
    second.store.resumeGroup('outer');
    second.store.resume();
    expect(second.texts()).toEqual(['c:one', 'outside:one']);
    second.store.resumeGroup('parent');
    expect(second.texts().slice(-2)).toEqual(['parent:one', 'b:one']);
    expect(individualPaused(second.store.snapshot(), 'parent')).toBe(false);
    second.store.resumeAgent('a');
    expect(second.texts().at(-1)).toBe('a:one');
  });

  it('recomputes membership during restore instead of trusting stale aggregate flags', () => {
    const first = setup([frame('g'), agent('a', 'g')]);
    first.store.pauseGroup('g');
    const second = setup([frame('g'), agent('a')]);
    second.store.restore(first.store.checkpoint());
    expect(second.store.snapshot().agents.a?.paused).not.toBe(true);
    expect(individualPaused(second.store.snapshot(), 'a')).toBe(false);
    second.store.resume();
    expect(second.texts()).toEqual(['a:one']);
  });

  it('migrates legacy paused flags to individual causes and clears all causes on reset', () => {
    const first = setup([frame('g'), agent('a', 'g')]);
    first.store.pauseAgent('a');
    const saved = JSON.parse(first.store.checkpoint()) as {
      run: { individualPauses?: string[]; groupPauses?: string[] };
    };
    delete saved.run.individualPauses;
    delete saved.run.groupPauses;
    const second = setup([frame('g'), agent('a', 'g')]);
    second.store.restore(JSON.stringify(saved));
    expect(second.store.snapshot().individualPauses).toEqual(['a']);
    second.store.resumeGroup('g');
    second.store.resume();
    expect(second.texts()).toEqual([]);
    second.store.resumeAgent('a');
    expect(second.texts()).toEqual(['a:one']);
    second.store.pauseGroup('g');
    second.store.reset();
    expect(second.store.snapshot()).toEqual({ running: false, agents: {} });
    second.store.start();
    expect(second.texts().at(-1)).toBe('a:one');
  });

  it.each(['individualPauses', 'groupPauses'] as const)(
    'rejects invalid %s without discarding current state',
    (field) => {
      const { store } = setup(tree());
      store.start();
      const saved = JSON.parse(store.checkpoint()) as { run: Record<string, unknown> };
      saved.run[field] = ['parent', 123];
      const before = store.checkpoint();
      expect(() => {
        store.restore(JSON.stringify(saved));
      }).toThrow('invalid or unsupported');
      expect(store.checkpoint()).toBe(before);
    },
  );
});
