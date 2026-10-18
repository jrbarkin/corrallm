import { describe, expect, it } from 'vitest';

import { MAX_RUN_BYTES, parseRunCheckpoint } from './run';

const valid = { version: 2, workflow: '{}', state: '{}', messages: '[]', updatedAt: 1 };
describe('run checkpoint boundary', () => {
  it('accepts bounded workflow/run/message JSON only', () => {
    expect(parseRunCheckpoint(valid)).toEqual(valid);
  });
  it.each([
    { ...valid, version: 1 },
    { ...valid, version: 3 },
    { ...valid, state: '{' },
    { ...valid, messages: 'null' },
    { ...valid, updatedAt: Infinity },
    { ...valid, path: '/private/file' },
    { ...valid, state: '['.repeat(70) + '{}' + ']'.repeat(70) },
    { ...valid, messages: ' '.repeat(MAX_RUN_BYTES + 1) },
  ])('rejects invalid or excessive data', (checkpoint) => {
    expect(() => parseRunCheckpoint(checkpoint)).toThrow();
  });
});
