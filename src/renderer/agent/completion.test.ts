import { describe, expect, it } from 'vitest';

import { complete, completing, matchCommands } from './completion';

describe('completing', () => {
  it('completes a slash command typed at the start of the message', () => {
    expect(completing('/comp', 5)).toEqual({ kind: 'command', query: 'comp', start: 0, end: 5 });
    expect(completing('/', 1)).toEqual({ kind: 'command', query: '', start: 0, end: 1 });
    // Not once its arguments are being typed, nor elsewhere in the message.
    expect(completing('/compact keep', 13)).toBeUndefined();
    expect(completing('use /compact', 12)).toBeUndefined();
  });

  it('completes a file mention anywhere, the word at the caret', () => {
    expect(completing('look at @src/ma', 15)).toEqual({
      kind: 'file',
      query: 'src/ma',
      start: 8,
      end: 15,
    });
    expect(completing('@', 1)).toEqual({ kind: 'file', query: '', start: 0, end: 1 });
    // The rest of the word after the caret is replaced too.
    expect(completing('see @src/main please', 7)).toMatchObject({ query: 'sr', end: 13 });
    expect(completing('mail me@example.com', 19)).toBeUndefined();
  });
});

describe('matchCommands', () => {
  const commands = ['clear', 'compact', 'context', 'code-review', 'model'].map((name) => ({
    name,
    description: '',
    argumentHint: '',
  }));

  it('offers the commands starting with what was typed, then those containing it', () => {
    expect(matchCommands(commands, 'co').map((c) => c.name)).toEqual([
      'compact',
      'context',
      'code-review',
    ]);
    expect(matchCommands(commands, 'de').map((c) => c.name)).toEqual(['code-review', 'model']);
    expect(matchCommands(commands, '', 2).map((c) => c.name)).toEqual(['clear', 'compact']);
  });
});

describe('complete', () => {
  it('puts the command in, ready for what it takes', () => {
    const at = completing('/comp', 5);
    if (!at) throw new Error('nothing to complete');
    expect(complete('/comp', at, 'compact')).toEqual({ text: '/compact ', caret: 9 });
  });

  it('puts a file in where it was typed; a folder stays open to go on', () => {
    const file = completing('see @src/ma and', 11);
    if (!file) throw new Error('nothing to complete');
    expect(complete('see @src/ma and', file, 'src/main/ipc.ts')).toEqual({
      text: 'see @src/main/ipc.ts and',
      caret: 21,
    });
    const folder = completing('@sr', 3);
    if (!folder) throw new Error('nothing to complete');
    expect(complete('@sr', folder, 'src/')).toEqual({ text: '@src/', caret: 5 });
  });
});
