import { expect, it } from 'vitest';

import { Sequence } from './sequence';

it('orders safe-integer sequences across both 32-bit words and the largest supported bit', () => {
  const sequence = new Sequence();
  const keys = [0, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 52, Number.MAX_SAFE_INTEGER];
  for (const key of keys.toReversed()) sequence.set(key, String(key));
  expect(keys.map((_, i) => sequence.newest(i))).toEqual(keys.toReversed().map(String));
  keys.forEach((key, index) => {
    expect(sequence.newer(key)).toBe(keys.length - index - 1);
  });
  for (const key of keys) {
    expect(sequence.first()).toBe(String(key));
    sequence.delete(key);
  }
  expect(sequence.weight).toBe(0);
});

it('keeps weighted order through seeded inserts, replacements and removals', () => {
  const sequence = new Sequence();
  const expected = new Map<number, number>();
  let seed = 0x54b;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let step = 0; step < 1500; step++) {
    const seq = Math.floor(random() * 300) + 2 ** 40;
    if (random() < 0.4) {
      sequence.delete(seq);
      expected.delete(seq);
    } else {
      const weight = random() < 0.3 ? 2 : 1;
      sequence.set(seq, String(seq), weight);
      expected.set(seq, weight);
    }
    const ordered = [...expected].sort(([a], [b]) => b - a);
    const weighted = ordered.flatMap(([seq, count]) => Array<string>(count).fill(String(seq)));
    expect(sequence.weight).toBe(weighted.length);
    expect(sequence.first()).toBe(weighted.at(-1));
    for (const index of [0, 1, 99, 100, 101, weighted.length - 1, weighted.length]) {
      expect(sequence.newest(index)).toBe(weighted[index]);
    }
    expect(sequence.newer(seq)).toBe(
      ordered.reduce((sum, [key, weight]) => sum + (key > seq ? weight : 0), 0),
    );
  }
  for (const seq of expected.keys()) sequence.delete(seq);
  expect(sequence.weight).toBe(0);
  expect(sequence.first()).toBeUndefined();
});
