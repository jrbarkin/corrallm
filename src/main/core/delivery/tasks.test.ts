import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { Message } from '../../../shared/model/messages';
import type { TaskMessage } from '../../../shared/session';
import type { MessageStore } from './messages';
import { recoveredOf, reportedOf, resultKey, waitsOn } from './tasks';

/*
 * B21 C5 (Design §9.2 C7, C8): what a canvas's mailbox says of a task's attempt, from its rows
 * alone: whether it waits on its asks, what its agent reported, and, held or restored, whether it
 * waits still or an answer had reached its agent.
 */

const CANVAS = '8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a' as CanvasId;
const TASK: TaskMessage = {
  agent: 'planner',
  item: 'build',
  attempt: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
};
const QUESTION = {
  id: 'scope',
  header: 'Scope',
  text: 'How much?',
  options: [],
  multiple: false,
  other: true,
};

/** A store holding `rows` alone, the result kept by its told key. */
function storeOf(rows: Message[], told: Record<string, Message> = {}): MessageStore {
  return { all: () => rows, toldAs: (key: string) => told[key] } as unknown as MessageStore;
}

const row = (id: string, more: Partial<Message>): Message => ({
  id,
  canvas: CANVAS,
  from: 'corrallm',
  to: 'agent:planner',
  kind: 'text',
  body: id,
  state: 'pending',
  at: 1,
  ...more,
});
const send = (state: Message['state']) => row('send', { task: TASK, state });
const ask = row('ask', {
  from: 'agent:planner',
  to: 'you',
  kind: 'prompt',
  state: 'delivered',
  ask: {
    v: 1,
    type: 'question',
    questions: [QUESTION],
    deadline: 90_000,
    task: { owner: TASK.agent, item: TASK.item, attempt: TASK.attempt },
  },
});
const answer = (state: Message['state']) =>
  row('answer', {
    from: 'you',
    task: TASK,
    state,
    replyTo: 'ask',
    ask: { v: 1, type: 'answer', of: 'ask', text: 'All of it' },
  });

describe('a task’s attempt in its mailbox', () => {
  it('waits on an open ask of its, or a continuation of it not yet ended', () => {
    expect(waitsOn(storeOf([send('replied'), ask]), TASK)).toBe(true);
    expect(waitsOn(storeOf([send('replied'), answer('pending')]), TASK)).toBe(true);
    expect(waitsOn(storeOf([send('replied'), answer('delivered')]), TASK)).toBe(true);
    expect(waitsOn(storeOf([send('replied'), answer('replied')]), TASK)).toBe(false);
    // Another attempt's ask is no wait of this one's.
    expect(
      waitsOn(storeOf([{ ...ask, ask: { ...ask.ask, task: undefined } } as Message]), TASK),
    ).toBe(false);
  });

  it('waits still, held or restored, once its own turn is over, its send replied or pruned since', () => {
    expect(recoveredOf(storeOf([send('replied'), ask]), TASK)).toEqual({ waiting: true });
    expect(recoveredOf(storeOf([ask]), TASK)).toEqual({ waiting: true });
    expect(recoveredOf(storeOf([send('replied'), answer('pending')]), TASK)).toEqual({
      waiting: true,
    });
    // Its own turn in flight, or cut off: not waiting, and no answer had reached it.
    for (const state of ['delivering', 'delivered', 'unresolved'] as const)
      expect(recoveredOf(storeOf([send(state), ask]), TASK)).toEqual({
        waiting: false,
        answered: false,
      });
  });

  it('says an answer had reached its agent when a continuation was in flight or cut off', () => {
    for (const state of ['delivering', 'delivered', 'unresolved'] as const)
      expect(recoveredOf(storeOf([send('replied'), answer(state)]), TASK)).toEqual({
        waiting: false,
        answered: true,
      });
  });

  it('reads what its agent reported from its result record, by its attempt', () => {
    const result = row('result', {
      from: 'agent:planner',
      to: 'corrallm',
      kind: 'result',
      task: TASK,
      state: 'delivered',
      verdict: { v: 1, outcome: 'failed', summary: 'Two fail.' },
    });
    expect(reportedOf(storeOf([], { [resultKey(TASK.attempt)]: result }), TASK)).toEqual({
      v: 1,
      outcome: 'failed',
      summary: 'Two fail.',
    });
    expect(reportedOf(storeOf([]), TASK)).toBeUndefined();
  });
});
