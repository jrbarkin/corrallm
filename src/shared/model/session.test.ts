import { describe, expect, it } from 'vitest';

import { chatStart, rewindPointsOf, threadTitle } from './session';
import type { Conversation, Entry } from './session';

describe('threadTitle', () => {
  it('names a chat by the start of its first message, cut at a word', () => {
    expect(threadTitle('Fix the flaky test')).toBe('Fix the flaky test');
    expect(threadTitle('Fix\n\n  the   flaky test')).toBe('Fix the flaky test');
    expect(threadTitle('Add rate limiting to the public API and document every endpoint')).toBe(
      'Add rate limiting to the public API…',
    );
  });
});

describe('the conversations a transcript holds', () => {
  const said = (id: string, conversation: Conversation): Entry => ({
    id,
    kind: 'user',
    text: id,
    reached: true,
    conversation,
  });
  // A Codex thread's history (put ahead), a unsupported submission, then Claude Code's, cleared once.
  const entries: Entry[] = [
    said('Review it', 'codex'),
    said('Sketch it', 'unavailable'),
    said('Fix it', 'claude-code'),
    { id: 'c1', kind: 'cleared', conversation: 'claude-code' },
    said('Document it', 'claude-code'),
    said('Ship it', 'claude-code'),
  ];

  it('names a chat by the first message of its conversation since its last /clear', () => {
    expect(chatStart(entries, 'claude-code')?.text).toBe('Document it');
    expect(chatStart(entries, 'codex')?.text).toBe('Review it');
    expect(chatStart(entries, 'unavailable')?.text).toBe('Sketch it');
    expect(chatStart(entries.slice(0, 4), 'claude-code')).toBeUndefined();
  });

  it('rewinds only within Claude Code’s conversation now', () => {
    expect(rewindPointsOf(entries, 'claude-code').map((point) => point.text)).toEqual([
      'Document it',
      'Ship it',
    ]);
  });
});

describe('rewindPointsOf (B16 C4)', () => {
  const user = (id: string, conversation?: string, reached = true): Entry => ({
    id,
    kind: 'user',
    text: id,
    ...(reached ? { reached: true } : {}),
    ...(conversation === undefined ? {} : { conversation }),
  });

  it('proves an unfamiliar owner’s points: reached, marked as its own, since its last clear', () => {
    const entries: Entry[] = [
      user('before', 'zed'),
      { id: 'clear', kind: 'cleared', conversation: 'zed' },
      user('one', 'zed'),
      user('theirs', 'yak'),
      user('unmarked'),
      user('unsent', 'zed', false),
      { id: 'end', kind: 'end', seconds: 1, interrupted: false },
      user('two', 'zed'),
    ];
    expect(rewindPointsOf(entries, 'zed').map(({ id }) => id)).toEqual(['one', 'two']);
    expect(rewindPointsOf(entries, 'yak').map(({ id }) => id)).toEqual(['theirs']);
  });

  it('takes an unmarked clear as every conversation’s, and another’s clear as none of its own', () => {
    const entries: Entry[] = [
      user('one', 'zed'),
      { id: 'theirs', kind: 'cleared', conversation: 'yak' },
      user('two', 'zed'),
      { id: 'old', kind: 'cleared' },
      user('three', 'zed'),
    ];
    expect(rewindPointsOf(entries, 'zed').map(({ id }) => id)).toEqual(['three']);
    expect(rewindPointsOf(entries.slice(0, 3), 'zed').map(({ id }) => id)).toEqual(['one', 'two']);
  });
});
