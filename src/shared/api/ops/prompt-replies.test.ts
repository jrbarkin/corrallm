import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { idsIn } from '../ids';
import { MAX_ANSWER_LENGTH, MAX_PROMPT_OPTIONS, MAX_PROMPT_QUESTIONS } from '../limits';
import { OPS } from '../registry';
import { PromptNeedView } from '../../model/prompts';

const canvas = '00000000-0000-4000-8000-000000000001';
const to = 'prompt/worker/1/00000000-0000-4000-8000-000000000002';
const input = (answer: unknown) => ({ canvas, to, answer });

describe('registered prompt replies', () => {
  it('publishes the owner’s question-count bound in its transport schema', () => {
    expect(JSON.stringify(z.toJSONSchema(OPS.reply.input))).toContain(
      `"maxProperties":${String(MAX_PROMPT_QUESTIONS)}`,
    );
  });

  it.each([
    { choice: 'keep-planning', feedback: 'Cover the empty case too' },
    { choice: 'strict' },
    { choice: 'always' },
    { choice: 'deny-network' },
    { choice: 'not-waiting' },
    { answers: { branch: { picked: ['main'] }, checks: { text: 'Use the full suite' } } },
    { form: { action: 'accept', values: { count: 3, enabled: true, picks: ['one'] } } },
    { form: { action: 'cancel' } },
  ])('takes the owner reply unchanged: %j', (answer) => {
    const given = input(answer);
    expect(OPS.reply.input.parse(given)).toEqual(given);
    expect(idsIn(OPS.reply.input, given)).toEqual([
      { brand: 'CanvasId', id: canvas, path: '.canvas' },
      { brand: 'NeedId', id: to, path: '.to' },
    ]);
  });

  it('admits the full bounded set of id-keyed answers', () => {
    const answers = Object.fromEntries(
      Array.from({ length: MAX_PROMPT_QUESTIONS }, (_, i) => [
        `q${String(i)}`,
        { picked: ['Yes'] },
      ]),
    );
    expect(OPS.reply.input.safeParse(input({ answers })).success).toBe(true);
    expect(
      OPS.reply.input.safeParse(input({ answers: { ...answers, extra: { text: 'Yes' } } })).success,
    ).toBe(false);
  });

  it.each([
    { choice: 'no', feedback: 'x'.repeat(MAX_ANSWER_LENGTH + 1) },
    { choice: 'no', feedback: 'why', text: 'hold text' },
    { choice: 'no', feedback: 'why', images: [] },
    { answers: { q: { picked: ['Yes'], text: 'Also' } } },
    { answers: { q: { picked: [] } } },
    { answers: { q: { picked: ['Yes', 'Yes'] } } },
    {
      answers: {
        q: { picked: Array.from({ length: MAX_PROMPT_OPTIONS + 1 }, (_, i) => String(i)) },
      },
    },
    { answers: { q: { text: '   ' } } },
    { answers: { q: { text: 'x'.repeat(MAX_ANSWER_LENGTH + 1) } } },
    { answers: { q: { text: 'Yes' }, old: 'Yes' } },
    { form: { action: 'accept', values: { nested: { value: 'Yes' } } } },
    { choice: 'yes', decider: { party: 'you', name: 'You' } },
  ])('refuses an answer outside the registered shapes: %#', (answer) => {
    expect(OPS.reply.input.safeParse(input(answer)).success).toBe(false);
  });

  it('reports a terminal wait dismissed by you through the ordinary receipt', () => {
    expect(OPS.reply.output.parse({ outcome: 'dismissed', revs: {} })).toEqual({
      outcome: 'dismissed',
      revs: {},
    });
  });

  it('carries a form server in its strict Needs prompt metadata', () => {
    const view = {
      id: '00000000-0000-4000-8000-000000000002',
      kind: 'form',
      raised: 1,
      server: 'fixture-server',
    };
    expect(PromptNeedView.parse(view)).toEqual(view);
  });

  it.each([
    { permission: 'deny', feedback: 'Use a safer command' },
    { plan: { approve: false, feedback: 'Keep planning' } },
    { answers: { '0': 'main', '1': ['unit', 'lint'] } },
  ])('keeps the renderer bridge answer until its consumers convert: %j', (answer) => {
    expect(OPS.reply.input.parse(input(answer))).toEqual(input(answer));
  });
});
