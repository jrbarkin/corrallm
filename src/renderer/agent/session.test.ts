import { describe, expect, it } from 'vitest';

import { NEW_SESSION, reduce, threadTitle } from './session';
import type { Entry, Session } from './session';

const tool = (id: string, status: 'running' | 'done' = 'running'): Entry => ({
  id,
  kind: 'tool',
  tool: 'Bash',
  summary: 'npm test',
  status,
});

describe('threadTitle', () => {
  it('names a chat by the start of its first message, cut at a word', () => {
    expect(threadTitle('Fix the flaky test')).toBe('Fix the flaky test');
    expect(threadTitle('Fix\n\n  the   flaky test')).toBe('Fix the flaky test');
    expect(threadTitle('Add rate limiting to the public API and document every endpoint')).toBe(
      'Add rate limiting to the public API…',
    );
  });
});

describe('reduce', () => {
  it('starts a turn with the user’s message, and streams text into the reply', () => {
    let s = reduce(NEW_SESSION, { type: 'start', entry: { id: 'u', kind: 'user', text: 'Hi' } });
    expect(s.status).toBe('working');
    s = reduce(s, { type: 'add', entry: { id: 't', kind: 'text', text: '' } });
    s = reduce(s, { type: 'stream', id: 't', text: 'Hello' });
    s = reduce(s, { type: 'stream', id: 't', text: ' there' });
    expect(s.entries).toEqual([
      { id: 'u', kind: 'user', text: 'Hi' },
      { id: 't', kind: 'text', text: 'Hello there' },
    ]);
  });

  it('waits on a permission prompt, and remembers tools the user always allows', () => {
    const asked: Session = reduce(
      reduce(NEW_SESSION, { type: 'start', entry: { id: 'u', kind: 'user', text: 'Go' } }),
      { type: 'ask', entry: { id: 'p', kind: 'permission', tool: 'Bash', summary: 'npm test' } },
    );
    expect(asked.status).toBe('waiting');
    const always = reduce(asked, { type: 'answer', id: 'p', answer: 'always' });
    expect(always.status).toBe('working');
    expect(always.allowed).toEqual(['Bash']);
    expect(always.entries.at(-1)).toEqual({
      id: 'p',
      kind: 'permission',
      tool: 'Bash',
      summary: 'npm test',
      answer: 'always',
    });
    expect(reduce(asked, { type: 'answer', id: 'p', answer: 'once' }).allowed).toEqual([]);
  });

  it('ends a turn; an interrupted one stops its running tools', () => {
    const running: Session = {
      ...NEW_SESSION,
      status: 'working',
      entries: [tool('a', 'done'), tool('b')],
    };
    const ended = reduce(running, { type: 'end', id: 'e', seconds: 3, interrupted: true });
    expect(ended.status).toBe('idle');
    expect(ended.entries.map((e) => (e.kind === 'tool' ? e.status : e.kind))).toEqual([
      'done',
      'interrupted',
      'end',
    ]);
  });

  it('switches mode and model', () => {
    expect(reduce(NEW_SESSION, { type: 'mode', mode: 'plan' }).mode).toBe('plan');
    expect(reduce(NEW_SESSION, { type: 'model', model: 'Haiku 5.5' }).model).toBe('Haiku 5.5');
  });

  it('queues messages sent while it works, in order, and can take one back', () => {
    let s = reduce(NEW_SESSION, { type: 'queue', id: 'q1', text: 'Also add docs' });
    s = reduce(s, { type: 'queue', id: 'q2', text: 'And a changelog' });
    expect(s.queued.map((q) => q.text)).toEqual(['Also add docs', 'And a changelog']);
    expect(reduce(s, { type: 'unqueue', id: 'q1' }).queued.map((q) => q.id)).toEqual(['q2']);
  });
});
