import { describe, expect, it } from 'vitest';

import { keystrokes, typeable } from './typing';

describe('keystrokes', () => {
  it('types a short message in one go', () => {
    expect(keystrokes('Fix the failing test')).toEqual(['Fix the failing test']);
  });

  it('types a long line a few characters at a time', () => {
    const writes = keystrokes('x'.repeat(70));
    expect(writes).toEqual(['x'.repeat(32), 'x'.repeat(32), 'x'.repeat(6)]);
  });

  it('types each line break on its own (Ctrl+J), never Enter', () => {
    expect(keystrokes('First\r\nsecond\rthird\n\nfourth\n')).toEqual([
      'First',
      '\n',
      'second',
      '\n',
      'third',
      '\n',
      '\n',
      'fourth',
    ]);
  });

  it('never splits a character between writes', () => {
    const writes = keystrokes('é'.repeat(31) + '😀' + 'a');
    expect(writes).toEqual(['é'.repeat(31) + '😀', 'a']);
  });
});

describe('typeable', () => {
  it('drops control characters, which would act as keys', () => {
    expect(typeable('stop\x1b[A here\x03 and\x7f there\u009b')).toBe('stop[A here and there');
  });

  it('turns tabs into spaces', () => {
    expect(typeable('if x:\n\treturn')).toBe('if x:\n    return');
  });
});
