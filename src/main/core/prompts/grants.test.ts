import { describe, expect, it } from 'vitest';

import type { CoreChoice, Prompt } from '../../../shared/model/prompts';
import { allowance, HAND_BACK } from './grants';
import type { Answerer } from './grants';

/*
 * B24 C4: the one allowance. What each party may answer of a prompt, by its kind, its choices'
 * hints and marks, and whether its connection reports why only a person may answer (`signals`).
 */

const ALL = { questions: true, plans: true, approvals: true };
const LEAD: Answerer = { kind: 'lead', grants: ALL };
const OUTSIDE: Answerer = { kind: 'outside' };

function choice(
  value: string,
  hint: CoreChoice['hint'],
  more: Partial<CoreChoice> = {},
): CoreChoice {
  return { value, label: value, hint, ...more };
}

function approval(choices: CoreChoice[], more: Partial<Prompt> = {}): Prompt {
  return {
    id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    agent: 'worker',
    raised: 1,
    kind: 'approval',
    title: 'Run it',
    answerIn: 'api',
    choices,
    ...more,
  } as Prompt;
}

const CHOICES = [
  choice('yes', 'allow_once'),
  choice('no', 'reject_once'),
  choice('always', 'allow_always', {
    humanOnly: 'Only you decide for more than this one request.',
  }),
  choice('never', 'reject_always', {
    humanOnly: 'Only you decide for more than this one request.',
  }),
  choice('rules', 'allow_once', { humanOnly: 'Only you change the rules its CLI keeps.' }),
  choice('say', 'reject_once', { feedback: 'required' }),
];

describe('a lead’s allowance', () => {
  it('gives once-only choices that are not yours, with Hand back, on a signalling connection', () => {
    const may = allowance(approval(CHOICES), true, LEAD);
    expect(may.choices).toEqual(['yes', 'no']);
    expect(may.handBack).toBe(true);
    expect(may.allows({ choice: 'yes' })).toBe(true);
    expect(may.allows({ choice: HAND_BACK })).toBe(true);
  });

  it('refuses always, rules, feedback, own words and a choice the prompt does not offer', () => {
    const may = allowance(approval(CHOICES), true, LEAD);
    for (const answer of [
      { choice: 'always' },
      { choice: 'never' },
      { choice: 'rules' },
      { choice: 'say' },
      { choice: 'yes', feedback: 'also this' },
      { choice: 'other' },
      { answers: {} },
      { form: { action: 'cancel' } },
      { choice: 'yes', text: 'x' },
    ]) {
      expect(may.allows(answer), JSON.stringify(answer)).toBe(false);
    }
  });

  it('may only reject or hand back where the connection reports no signals', () => {
    const may = allowance(approval(CHOICES), false, LEAD);
    expect(may.choices).toEqual(['no']);
    expect(may.allows({ choice: 'yes' })).toBe(false);
    expect(may.allows({ choice: HAND_BACK })).toBe(true);
  });

  it('follows the grant of the prompt’s kind', () => {
    const none = {
      kind: 'lead',
      grants: { questions: true, plans: true, approvals: false },
    } as const;
    const may = allowance(approval(CHOICES), true, none);
    expect(may.choices).toEqual([]);
    expect(may.handBack).toBe(false);
    expect(may.allows({ choice: 'yes' })).toBe(false);
  });

  it('answers a question by its offered labels only, and only on a signalling connection', () => {
    const question = {
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      agent: 'worker',
      raised: 1,
      kind: 'question',
      title: 'Which',
      answerIn: 'api',
      questions: [
        {
          id: 'q',
          header: 'Q',
          text: 'Which?',
          options: [{ label: 'A' }],
          multiple: false,
          other: true,
        },
      ],
    } as unknown as Prompt;
    const signalled = allowance(question, true, LEAD);
    expect(signalled.allows({ answers: { q: { picked: ['A'] } } })).toBe(true);
    expect(signalled.allows({ answers: { q: { text: 'mine' } } })).toBe(false);
    const quiet = allowance(question, false, LEAD);
    expect(quiet.allows({ answers: { q: { picked: ['A'] } } })).toBe(false);
    expect(quiet.allows({ choice: HAND_BACK })).toBe(true);
    expect(quiet.answers).toBe(false);
  });

  it('never answers a form or a prompt only you may answer whole', () => {
    const form = { ...approval([]), kind: 'form', form: { schema: {} } } as unknown as Prompt;
    expect(allowance(form, true, LEAD).handBack).toBe(false);
    const trust = approval(
      CHOICES.map((one) => ({ ...one, humanOnly: 'Only you decide whether to trust a folder.' })),
      { humanOnly: 'Only you decide whether to trust a folder.' },
    );
    const may = allowance(trust, true, LEAD);
    expect(may.choices).toEqual([]);
  });

  it('gives nothing in a terminal', () => {
    const may = allowance(approval(CHOICES, { answerIn: 'terminal' }), true, LEAD);
    expect(may.choices).toEqual([]);
    expect(may.handBack).toBe(false);
  });
});

describe('an outside grantee’s allowance', () => {
  it('covers approvals once only, with no Hand back', () => {
    const may = allowance(approval(CHOICES), true, OUTSIDE);
    expect(may.choices).toEqual(['yes', 'no']);
    expect(may.handBack).toBe(false);
    expect(may.allows({ choice: HAND_BACK })).toBe(false);
  });

  it('may only reject where the connection reports no signals', () => {
    expect(allowance(approval(CHOICES), false, OUTSIDE).choices).toEqual(['no']);
  });

  it('answers neither plans nor questions', () => {
    const plan = { ...approval(CHOICES), kind: 'plan', plan: 'Do it' } as unknown as Prompt;
    expect(allowance(plan, true, OUTSIDE).choices).toEqual([]);
  });
});

describe('your allowance', () => {
  it('is everything', () => {
    expect(allowance(approval(CHOICES), false, { kind: 'you' }).allows({ choice: 'always' })).toBe(
      true,
    );
  });
});
