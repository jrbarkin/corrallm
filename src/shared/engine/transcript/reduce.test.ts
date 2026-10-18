import { describe, expect, it } from 'vitest';

import { answersOf, NEW_SESSION, pendingSessionQuestions } from '../../model/session';
import type { Entry, Session } from '../../model/session';
import { reduce } from './reduce';

const tool = (id: string, status: 'running' | 'done' = 'running'): Entry => ({
  id,
  kind: 'tool',
  tool: 'Bash',
  summary: 'npm test',
  status,
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

  it('waits on a permission prompt, and records the answer it was given', () => {
    const asked: Session = reduce(
      reduce(NEW_SESSION, { type: 'start', entry: { id: 'u', kind: 'user', text: 'Go' } }),
      { type: 'ask', entry: { id: 'p', kind: 'permission', tool: 'Bash', summary: 'npm test' } },
    );
    expect(asked.status).toBe('waiting');
    const always = reduce(asked, { type: 'answer', id: 'p', answer: 'always' });
    expect(always.status).toBe('working');
    expect(always.entries.at(-1)).toEqual({
      id: 'p',
      kind: 'permission',
      tool: 'Bash',
      summary: 'npm test',
      answer: 'always',
    });
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

describe('reduce, for connected sessions', () => {
  const started = reduce(NEW_SESSION, {
    type: 'start',
    entry: { id: 'u', kind: 'user', text: 'Go' },
  });

  it('takes the models and mode the session started with, and what it has used', () => {
    const models = [{ value: 'opus', label: 'Opus' }];
    const s = reduce(NEW_SESSION, { type: 'connected', models, model: 'opus', mode: 'plan' });
    expect(s).toMatchObject({ models, model: 'opus', mode: 'plan' });
    const usage = { costUsd: 0.5, contextTokens: 1000, contextWindow: 200_000 };
    expect(reduce(s, { type: 'usage', usage }).usage).toEqual(usage);
  });

  it('works or waits as the session says, until the turn ends', () => {
    const waiting = reduce(started, { type: 'status', status: 'waiting' });
    expect(waiting.status).toBe('waiting');
    expect(reduce(waiting, { type: 'status', status: 'working' }).status).toBe('working');
  });

  it('asks questions, and works on once every one is answered', () => {
    const asked = reduce(started, {
      type: 'ask',
      entry: {
        id: 'q',
        kind: 'question',
        questions: [
          { header: 'Branch', text: 'Which branch?', options: [], multiple: false },
          { header: 'Tests', text: 'Run the tests?', options: [], multiple: false },
        ],
      },
    });
    expect(asked.status).toBe('waiting');
    const one = reduce(asked, { type: 'answerQuestion', id: 'q', index: 1, answer: 'Yes' });
    expect(one.status).toBe('waiting');
    expect(pendingSessionQuestions(one).map((q) => q.question.text)).toEqual(['Which branch?']);
    const both = reduce(one, { type: 'answerQuestion', id: 'q', index: 0, answer: 'main' });
    expect(both.status).toBe('working');
    expect(answersOf(both, 'q')).toEqual(['main', 'Yes']);
  });

  it('asks to approve a plan, and keeps waiting while another prompt is open', () => {
    let s = reduce(started, {
      type: 'ask',
      entry: { id: 'p', kind: 'permission', tool: 'Bash', summary: 'ls' },
    });
    s = reduce(s, { type: 'ask', entry: { id: 'plan', kind: 'plan', plan: '1. Do it' } });
    s = reduce(s, { type: 'answerPlan', id: 'plan', answer: { approve: true, mode: 'auto' } });
    expect(s.status).toBe('waiting');
    s = reduce(s, { type: 'answer', id: 'p', answer: 'once' });
    expect(s.status).toBe('working');
    expect(s.entries.find((e) => e.id === 'plan')).toMatchObject({
      answer: { approve: true, mode: 'auto' },
    });
  });

  it('withdraws a prompt the session no longer waits on, and every prompt open when a turn ends', () => {
    let s = reduce(started, {
      type: 'ask',
      entry: { id: 'p', kind: 'permission', tool: 'Bash', summary: 'ls' },
    });
    s = reduce(s, { type: 'withdraw', id: 'p' });
    expect(s.status).toBe('working');
    expect(s.entries.at(-1)).toMatchObject({ id: 'p', withdrawn: true });

    s = reduce(s, { type: 'ask', entry: { id: 'p2', kind: 'plan', plan: 'Plan' } });
    s = reduce(s, { type: 'end', id: 'e', seconds: 2, interrupted: true });
    expect(s.entries.find((e) => e.id === 'p2')).toMatchObject({ withdrawn: true });
    expect(pendingSessionQuestions(s)).toEqual([]);
  });

  it('marks a turn that failed', () => {
    const ended = reduce(started, {
      type: 'end',
      id: 'e',
      seconds: 1,
      interrupted: false,
      failed: true,
    });
    expect(ended.entries.at(-1)).toEqual({
      id: 'e',
      kind: 'end',
      seconds: 1,
      interrupted: false,
      failed: true,
    });
  });

  it('empties for another conversation, with what the last one ran and predicted; choices stay', () => {
    let s = reduce(started, { type: 'mode', mode: 'plan' });
    s = reduce(s, { type: 'effort', effort: 'high' });
    s = reduce(s, {
      type: 'tasks',
      tasks: [{ id: 'b1', description: 'npm run dev', kind: 'command' }],
    });
    s = reduce(s, { type: 'suggestion', text: 'Run the tests' });
    s = reduce(s, {
      type: 'usage',
      usage: { costUsd: 0.5, contextTokens: 10, contextWindow: 100 },
    });
    const cleared = reduce(s, { type: 'clear' });
    expect(cleared).toMatchObject({ entries: [], status: 'idle', mode: 'plan', effort: 'high' });
    expect(cleared.tasks ?? []).toEqual([]);
    expect(cleared.suggestion).toBeUndefined();
    expect(cleared.usage).toBeUndefined();
  });
});
