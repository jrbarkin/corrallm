import { describe, expect, it } from 'vitest';
import { OPS } from '../registry';
import { MAX_TOPIC_FRAME } from '../limits';
import { MAX_NODE_ID } from '../../model/canvas';

const canvas = '00000000-0000-4000-8000-000000000001';
const request = '00000000-0000-4000-8000-000000000002';

describe('registered window topic schemas', () => {
  for (const name of ['topics.subscribe', 'topics.unsubscribe'] as const) {
    const input = OPS[name].input;
    it(`${name} accepts structured runtime requests through the write envelope`, () => {
      for (const topic of ['run', 'sessions', 'messages'])
        expect(input.safeParse({ topic, canvas, request }).success).toBe(true);
      expect(input.safeParse({ topic: 'session', canvas, agent: 'a:/%\n"', request }).success).toBe(
        true,
      );
      for (const args of [
        { topic: `run:${canvas}` },
        { topic: 'session', canvas },
        { topic: 'run', canvas, agent: 'a' },
        { topic: 'usage', agent: 'a' },
        { topic: 'session', canvas, agent: 'x'.repeat(MAX_NODE_ID + 1) },
        { topic: 'session', canvas, agent: '\ud800' },
        { topic: 'session', canvas, agent: 'a', caller: 'you' },
      ])
        expect(input.safeParse({ ...args, request }).success, JSON.stringify(args)).toBe(false);
    });
  }

  it('answers one bounded whole snapshot or a bounded begin, never a mixed envelope', () => {
    const output = OPS['topics.subscribe'].output;
    const whole = { epoch: request, rev: 0, state: {}, revs: {} };
    const begin = {
      epoch: request,
      kind: 'begin',
      topic: `run:${canvas}`,
      snapshot: canvas,
      summary: { running: false },
      count: 2,
      revs: {},
    };
    expect(output.safeParse(whole).success).toBe(true);
    expect(output.safeParse(begin).success).toBe(true);
    for (const value of [
      { ...begin, rev: 0 },
      { ...whole, summary: {} },
      { ...begin, count: -1 },
      { ...begin, summary: { text: 'x'.repeat(MAX_TOPIC_FRAME) } },
      { epoch: request, rev: 0 },
      { ...begin, snapshot: 'not-a-uuid' },
    ])
      expect(output.safeParse(value).success).toBe(false);
    const missingSummary = Object.fromEntries(
      Object.entries(begin).filter(([key]) => key !== 'summary'),
    );
    expect(output.safeParse(missingSummary).success).toBe(false);
  });
});
