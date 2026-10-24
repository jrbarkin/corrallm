import { describe, expect, it } from 'vitest';

import { AgentId } from '../api/ids';
import { newCanvasId } from '../canvas';
import { NEW_SESSION } from './session';
import type { Entry } from './session';
import type { Run } from './run';
import { messageView, queueRows, runView, sessionView } from './views';
import { agentStatus, queueControlText, taskState } from './run-display';

const agent = AgentId.parse('a');

describe('read-only runtime projections', () => {
  it('caps a summary reply at 4 KiB of UTF-8 without cutting a character or its transcript', () => {
    const text = `${'€'.repeat(1365)}🙂tail`;
    const view = sessionView(agent, 'test.connection', {
      ...NEW_SESSION,
      entries: [
        { id: 'u', kind: 'user', text: 'Hi' },
        { id: 't', kind: 'text', text },
      ],
    });
    expect(view.summary.reply).toBe('€'.repeat(1365));
    expect(view.summary).toHaveProperty('replyCut', true);
    expect(view.entries.t).toHaveProperty('text', text);
    const short = sessionView(agent, 'test.connection', {
      ...NEW_SESSION,
      entries: [
        { id: 'u', kind: 'user', text: 'Hi' },
        { id: 't', kind: 'text', text: 'x'.repeat(4096) },
      ],
    });
    expect(short.summary.reply).toHaveLength(4096);
    expect(short.summary).not.toHaveProperty('replyCut');
  });

  it('puts pause causes in keyed agent and group entries, keeping them out of the run summary', () => {
    const view = runView({
      running: true,
      individualPauses: [{ id: 'a', by: 'you' }],
      groupPauses: [{ id: '__proto__', by: 'outside:lead' }],
      agents: { a: { status: 'waiting', paused: true, outcomes: {} } },
    });
    expect(view).not.toHaveProperty('individualPauses');
    expect(view).not.toHaveProperty('groupPauses');
    expect(view.agents[agent]).toHaveProperty('pauses', ['you']);
    expect(Object.hasOwn(view.groups, '__proto__')).toBe(true);
    expect(view.groups.__proto__).toEqual({ pauses: ['outside:lead'] });
  });

  it('shares unchanged agents and nested attempts without exposing mutable engine data', () => {
    const run: Run = {
      running: true,
      agents: {
        a: {
          status: 'running',
          current: 'one',
          outcomes: {},
          attempts: { one: [{ id: 'try', startedAt: 1, status: 'running' }] },
        },
        b: { status: 'waiting', outcomes: {} },
      },
    };
    const first = runView(run);
    expect(runView(run, first)).toBe(first);
    const next = runView(
      { ...run, agents: { ...run.agents, b: { status: 'done', outcomes: {} } } },
      first,
    );
    expect(next.agents[agent]).toBe(first.agents[agent]);
    expect(next.agents[AgentId.parse('b')]).not.toBe(first.agents[AgentId.parse('b')]);
    expect(Object.isFrozen(first.agents[agent]?.attempts?.one)).toBe(true);
    expect(Object.isFrozen(run.agents.a)).toBe(false);
    if (run.agents.a) run.agents.a.status = 'done';
    expect(first.agents[agent]?.status).toBe('running');
    expect(runView(run, first).agents[agent]?.status).toBe('done');
  });

  it('shares entries and summaries, strips image bytes, and respects authoritative history order', () => {
    const user: Entry = {
      id: 'user',
      kind: 'user',
      text: 'Hi',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    };
    const entries: Entry[] = [user, { id: 'text', kind: 'text', text: 'Hello' }];
    const session = { ...NEW_SESSION, entries };
    const first = sessionView(agent, 'test.connection', session);
    expect(first.entries.user).toMatchObject({ images: 1 });
    expect(JSON.stringify(first)).not.toContain('AAAA');
    expect(sessionView(agent, 'test.connection', session, false, first)).toBe(first);
    const next = sessionView(
      agent,
      'test.connection',
      { ...session, entries: [user, { id: 'text', kind: 'text', text: 'Hello again' }] },
      false,
      first,
    );
    expect(next.entries.user).toBe(first.entries.user);
    expect(next.entries.text).not.toBe(first.entries.text);
    const reordered = sessionView(
      agent,
      'test.connection',
      { ...session, entries: entries.slice(1) },
      false,
      next,
    );
    expect(reordered.order).toEqual(['text']);
    expect(reordered.entries.user).toBeUndefined();
    expect(Object.isFrozen(entries[0])).toBe(false);
  });

  it('keeps a summary object when only a thinking entry changes', () => {
    const first = sessionView(agent, 'test.connection', {
      ...NEW_SESSION,
      status: 'working',
      entries: [{ id: 'thinking', kind: 'thinking', text: 'a', seconds: 1 }],
    });
    const next = sessionView(
      agent,
      'test.connection',
      {
        ...NEW_SESSION,
        status: 'working',
        entries: [{ id: 'thinking', kind: 'thinking', text: 'ab', seconds: 2 }],
      },
      false,
      first,
    );
    expect(next.summary).toBe(first.summary);
    expect(next.entries.thinking).not.toBe(first.entries.thinking);
  });

  it('projects prompts, native terminal asks and last reply like session.get', () => {
    const view = sessionView(
      agent,
      'test.connection',
      {
        ...NEW_SESSION,
        entries: [
          { id: 'u', kind: 'user', text: 'hi' },
          { id: 't', kind: 'text', text: 'reply' },
          {
            id: 'q',
            kind: 'question',
            questions: [{ header: 'Question', text: '?', options: [], multiple: false }],
          },
        ],
        asking: [{ kind: 'trust', id: 'trust' }],
      },
      true,
    );
    expect(view.summary).toMatchObject({
      agent,
      paused: true,
      prompts: 2,
      reply: 'reply',
      queued: 0,
    });
  });

  it('never puts message rows into authored queue items and does not guess origin from sender', () => {
    const message = messageView(
      {
        id: '00000000-0000-4000-8000-000000000001',
        canvas: newCanvasId(),
        from: 'you',
        to: 'agent:a',
        kind: 'text',
        body: 'manual',
        state: 'pending',
        at: 1,
      },
      'resend',
      { after: 'authored' },
    );
    const queue = [{ id: 'authored', message: 'work' }];
    const rows = queueRows(queue, [message]);
    expect(rows.map((row) => row.kind)).toEqual(['authored', 'message']);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(queue).toEqual([{ id: 'authored', message: 'work' }]);
    expect(message.origin).toBe('resend');
    expect(Object.isFrozen(message)).toBe(true);
  });

  it('uses the same pure statuses for engine snapshots and views', () => {
    const run: Run = {
      running: true,
      agents: { a: { status: 'running', current: 'work', outcomes: {}, paused: true } },
    };
    const view = runView(run);
    expect(queueControlText(view, agent)).toBe('Pausing');
    expect(taskState(view, agent, 'work')).toBe('running');
    expect(agentStatus(agent, { a: { status: 'working' } }, view, new Set())).toBe('Pausing');
    expect(agentStatus(agent, {}, view, new Set([agent]))).toBe('Needs you');
  });
});
