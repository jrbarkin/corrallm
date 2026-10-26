import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { boundedPromptJson, promptJsonBytes } from './prompt-data';
import { PromptReplyAnswer, QuestionAnswers } from './prompts';

describe('bounded prompt data', () => {
  it('counts JSON escapes, keys and UTF-8 and handles the exact depth boundary', () => {
    const value = { é: ['😀', '\n'] };
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(boundedPromptJson(value, bytes, 2)).toBe(true);
    expect(boundedPromptJson(value, bytes - 1, 2)).toBe(false);
    expect(boundedPromptJson(value, bytes, 1)).toBe(false);
    expect(promptJsonBytes(value)).toBe(bytes);
  });

  it('rejects cycles, non-JSON values, sparse arrays and accessors without executing them', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads++;
        return 'secret';
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      getter,
      cycle,
      undefined,
      Number.NaN,
      BigInt(1),
      new Date(),
      new Array(100_000),
      { value: () => 'code' },
    ])
      expect(boundedPromptJson(value, 1024, 16)).toBe(false);
    expect(reads).toBe(0);
    expect(promptJsonBytes(cycle)).toBe(Infinity);
  });

  it('preserves bounded record keys while publishing bounded JSON schemas for future reply consumers', () => {
    expect(QuestionAnswers.parse(Object.fromEntries([['__proto__', { text: 'a value' }]]))).toEqual(
      Object.fromEntries([['__proto__', { text: 'a value' }]]),
    );
    const schema = z.toJSONSchema(QuestionAnswers);
    expect(schema).toMatchObject({
      type: 'object',
      maxProperties: 16,
      propertyNames: { minLength: 1, maxLength: 200 },
    });
    expect(() => z.toJSONSchema(PromptReplyAnswer)).not.toThrow();
  });
});
