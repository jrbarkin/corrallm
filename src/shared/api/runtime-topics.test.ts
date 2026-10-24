import { describe, expect, it } from 'vitest';

import { newCanvasId } from '../canvas';
import { MAX_NODE_ID } from '../model/canvas';
import { RuntimeTopic, snapshotFrameFits, topicKey, topicRequest } from './topics';
import { MAX_TOPIC_FRAME } from './limits';
import type { RuntimeSnapshotFrame } from './topics';

describe('unserved B11 topic contracts', () => {
  it('round-trips agents exactly once, never mixing an encoded separator with a canvas', () => {
    const canvas = newCanvasId();
    const other = newCanvasId();
    const agents = ['a:b/c', '%2F', '%252F', '"quoted"\nline', '🌊', 'x'.repeat(MAX_NODE_ID)];
    let seed = 71;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const alphabet = ['a', ':', '/', '%', '"', '\n', '\\', 'é', '🌊', ' ', '\u0000'];
    for (let i = 0; i < 200; i++) {
      let id = `${String(i)}/`;
      const length = next() % 100;
      for (let j = 0; j < length; j++) id += alphabet[next() % alphabet.length] ?? '';
      agents.push(id);
    }
    const keys = new Set<string>();
    for (const agent of agents) {
      const request = RuntimeTopic.parse({ topic: 'session', canvas, agent });
      const key = topicKey(request);
      expect(topicRequest(key)).toEqual(request);
      expect(key).not.toBe(
        topicKey(RuntimeTopic.parse({ topic: 'session', canvas: other, agent })),
      );
      keys.add(key);
    }
    expect(keys.size).toBe(agents.length);
  });

  it('bounds structured subscriptions and refuses unknown fields and malformed keys', () => {
    const canvas = newCanvasId();
    expect(RuntimeTopic.safeParse({ topic: 'session', canvas }).success).toBe(false);
    expect(
      RuntimeTopic.safeParse({ topic: 'session', canvas, agent: 'x'.repeat(MAX_NODE_ID + 1) })
        .success,
    ).toBe(false);
    expect(RuntimeTopic.safeParse({ topic: 'run', canvas, agent: 'a' }).success).toBe(false);
    expect(RuntimeTopic.safeParse({ topic: 'session', canvas, agent: '\uD800' }).success).toBe(
      false,
    );
    expect(() => topicRequest(`session:${canvas}:%GG`)).toThrow();
    expect(() => topicRequest(`session:${canvas}:a:b`)).toThrow();
    expect(() => topicRequest(`session:${canvas}:%2f`)).toThrow();
  });

  it('uses a chunk count and indexed chunks without an unbounded order header', () => {
    expect(MAX_TOPIC_FRAME).toBe(1024 * 1024);
    const topic = `session:${newCanvasId()}:a` as const;
    const begin: RuntimeSnapshotFrame = {
      kind: 'begin',
      topic,
      epoch: 'epoch',
      snapshot: 'snapshot',
      summary: {},
      count: 2,
    };
    const end: RuntimeSnapshotFrame = {
      kind: 'end',
      topic,
      epoch: 'epoch',
      snapshot: 'snapshot',
      rev: 5,
    };
    expect(snapshotFrameFits(begin)).toBe(true);
    expect(snapshotFrameFits(end)).toBe(true);
    expect(snapshotFrameFits({ ...begin, summary: { large: 'x'.repeat(MAX_TOPIC_FRAME) } })).toBe(
      false,
    );
    const chunk: RuntimeSnapshotFrame = {
      kind: 'chunk',
      index: 0,
      topic,
      epoch: 'epoch',
      snapshot: 'snapshot',
      entries: [{ key: 'large', value: 'x'.repeat(MAX_TOPIC_FRAME) }],
    };
    expect(snapshotFrameFits(chunk)).toBe(true);
    expect(
      snapshotFrameFits({ ...chunk, entries: [...chunk.entries, { key: 'small', value: 'y' }] }),
    ).toBe(false);
  });
  it('requires a nonnegative safe integer chunk index, even for an oversized entry', () => {
    const chunk = {
      kind: 'chunk' as const,
      topic: `session:${newCanvasId()}:a` as const,
      epoch: 'one',
      snapshot: 's',
      index: 0,
      entries: [{ key: 'huge', value: 'x'.repeat(MAX_TOPIC_FRAME + 1) }],
    };
    expect(snapshotFrameFits(chunk)).toBe(true);
    for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(snapshotFrameFits({ ...chunk, index })).toBe(false);
    Reflect.deleteProperty(chunk, 'index');
    expect(snapshotFrameFits(chunk)).toBe(false);
  });
});
