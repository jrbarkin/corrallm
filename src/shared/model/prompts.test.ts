import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MAX_PROMPT_BYTES,
  MAX_PROMPT_CHOICES,
  MAX_PROMPT_COMMAND_BYTES,
  MAX_PROMPT_DIFF_BYTES,
  MAX_PROMPT_INPUT_DEPTH,
  MAX_PROMPT_QUESTIONS,
} from '../api/limits';
import {
  AdapterPrompt,
  ChoiceEffects,
  Prompt,
  PromptAnswer,
  PromptEnded,
  PromptEvent,
  PromptReplyAnswer,
  PromptSubject,
  PromptNeedView,
  Questions,
  checkPromptAnswer,
  checkPromptReply,
  checkQuestionAnswers,
} from './prompts';

const key = '11111111-1111-4111-8111-111111111111';
const yes = { value: 'yes', label: 'Do it once', hint: 'allow_once', effects: {} };
const no = { value: 'no', label: 'Do not do it', hint: 'reject_once', effects: {} };
const approval = { kind: 'approval', title: 'Run command?', answerIn: 'api', choices: [yes, no] };
const question = {
  id: 'q1',
  header: 'Pick',
  text: 'Which?',
  multiple: false,
  other: true,
  options: [
    { label: 'a, b', description: 'One label with a comma', preview: 'Preview' },
    { label: 'second' },
  ],
};
const questions = [question, { ...question, id: 'q2', multiple: true, other: false }];

describe('the prepared prompt protocol', () => {
  it('keeps extension subjects distinct from known subjects in both types and validation', () => {
    const subject = PromptSubject.parse({ type: 'command', command: 'echo hi', cwd: '/repo' });
    if (subject.type === 'command') expectTypeOf(subject.command).toEqualTypeOf<string>();
    expect(PromptSubject.safeParse({ type: '_extension', value: true }).success).toBe(true);
    expect(PromptSubject.safeParse({ type: '_', value: true }).success).toBe(false);
    expect(PromptSubject.safeParse({ type: '_' + 'x'.repeat(200) }).success).toBe(false);
  });

  it('has one strict envelope per kind, a private UUID event key and no session-level capability', () => {
    for (const prompt of [
      approval,
      { kind: 'plan', title: 'Plan', plan: '# Whole plan', answerIn: 'both', choices: [yes, no] },
      { kind: 'question', title: 'Questions', questions, answerIn: 'api' },
      {
        kind: 'form',
        title: 'Sign in',
        form: { url: 'https://example.test/sign-in' },
        answerIn: 'api',
      },
    ]) {
      expect(AdapterPrompt.safeParse(prompt).success).toBe(true);
      expect(PromptEvent.safeParse({ type: 'prompt', key, prompt }).success).toBe(true);
    }
    for (const invalid of [
      { ...approval, questions },
      { ...approval, plan: 'a plan' },
      { ...approval, choices: [yes] },
      { ...approval, choices: [no, no] },
      {
        ...approval,
        choices: Array.from({ length: MAX_PROMPT_CHOICES + 1 }, (_, i) => ({
          ...no,
          value: String(i),
        })),
      },
      { ...approval, signals: { askRule: false } },
      { ...approval, answerIn: 'unknown' },
      { ...approval, choices: [{ ...no, nativeDecision: 'deny' }] },
    ])
      expect(AdapterPrompt.safeParse(invalid).success).toBe(false);
    expect(
      AdapterPrompt.safeParse({ ...approval, choices: [], answerIn: 'terminal' }).success,
    ).toBe(true);
    expect(
      AdapterPrompt.safeParse({
        kind: 'question',
        title: 'Check terminal',
        answerIn: 'terminal',
        questions: [],
      }).success,
    ).toBe(true);
    expect(
      PromptEvent.safeParse({ type: 'prompt', key: 'native-id', prompt: approval }).success,
    ).toBe(false);
    expect(PromptEnded.parse({ type: 'prompt-ended', key, reason: 'answered-natively' })).toEqual({
      type: 'prompt-ended',
      key,
      reason: 'answered-natively',
    });
    expect(PromptEnded.safeParse({ type: 'prompt-ended', key, reason: 'accepted' }).success).toBe(
      false,
    );
  });

  it('keeps private adapter evidence out of the core/view prompt and carries human-only reasons', () => {
    const prompt = {
      ...approval,
      id: key,
      agent: 'builder',
      raised: 123,
      humanOnly: 'A person decides',
      choices: [{ ...yes, humanOnly: 'Changes a mode' }, no],
    };
    expect(Prompt.safeParse(prompt).success).toBe(true);
    for (const extra of [{ signals: { safetyCheck: true } }, { key }, { nativeRequest: 1 }])
      expect(Prompt.safeParse({ ...prompt, ...extra }).success).toBe(false);
    expect(AdapterPrompt.safeParse({ ...approval, humanOnly: 'not adapter-owned' }).success).toBe(
      false,
    );
  });

  it('prepares the nested Needs preview without private keys or signals', () => {
    const view = {
      id: key,
      kind: 'plan',
      raised: 123,
      plan: 'A short preview',
      cut: true,
      humanOnly: 'A person decides',
    };
    expect(PromptNeedView.safeParse(view).success).toBe(true);
    expect(PromptNeedView.safeParse({ ...view, plan: 'line\n'.repeat(13) }).success).toBe(false);
    expect(PromptNeedView.safeParse({ ...view, signals: {} }).success).toBe(false);
    expect(PromptNeedView.safeParse({ ...view, key }).success).toBe(false);
  });

  it('distinguishes unknown effects from known empty effects without classifying authority', () => {
    expect(ChoiceEffects.parse({})).toEqual({});
    const unknown = AdapterPrompt.parse({ ...approval, choices: [{ ...no, effects: undefined }] });
    if (unknown.kind !== 'approval') throw new Error('The fixture is an approval.');
    expect(unknown.choices[0]?.effects).toBeUndefined();
    expect(
      ChoiceEffects.safeParse({
        mode: 'other-mode',
        directories: ['/repo'],
        rules: [{ behavior: 'allow', rule: 'Read', scope: 'session' }],
        network: { host: '*', allow: true, scope: 'turn' },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { rules: [{ behavior: 'allow', rule: 'Read', scope: 'forever' }] },
      { directories: Array.from({ length: 201 }, () => '/a') },
      {
        rules: Array.from({ length: 33 }, () => ({
          behavior: 'deny',
          rule: 'Read',
          scope: 'user',
        })),
      },
      { native: {} },
      { network: { host: '*', allow: true } },
    ])
      expect(ChoiceEffects.safeParse(invalid).success).toBe(false);
  });

  it('bounds whole identities, aggregate diff bytes, JSON depth and the entire normalized prompt', () => {
    const command = (value: string) => ({
      ...approval,
      subject: { type: 'command', command: value, cwd: '/repo' },
    });
    expect(AdapterPrompt.safeParse(command('x'.repeat(MAX_PROMPT_COMMAND_BYTES))).success).toBe(
      true,
    );
    expect(
      AdapterPrompt.safeParse(command('é'.repeat(MAX_PROMPT_COMMAND_BYTES / 2 + 1))).success,
    ).toBe(false);
    expect(
      AdapterPrompt.safeParse({
        ...approval,
        subject: { type: 'consent', key: 'account', text: 'x'.repeat(200_001) },
      }).success,
    ).toBe(false);
    const files = [
      { path: 'a', diff: 'é'.repeat(MAX_PROMPT_DIFF_BYTES / 4) },
      { path: 'b', diff: 'é'.repeat(MAX_PROMPT_DIFF_BYTES / 4) },
    ];
    expect(
      AdapterPrompt.safeParse({ ...approval, subject: { type: 'fileChange', files } }).success,
    ).toBe(true);
    expect(
      AdapterPrompt.safeParse({
        ...approval,
        subject: { type: 'fileChange', files: [...files, { path: 'c', diff: '+' }] },
      }).success,
    ).toBe(false);
    let input: unknown = null;
    for (let i = 0; i < MAX_PROMPT_INPUT_DEPTH + 1; i++) input = { nested: input };
    expect(PromptSubject.safeParse({ type: 'tool', tool: 'a-tool', input }).success).toBe(false);
    expect(PromptSubject.safeParse({ type: '_extension', data: { safe: true } }).success).toBe(
      true,
    );
    expect(
      PromptSubject.safeParse({ type: '_extension', data: 'x'.repeat(16 * 1024) }).success,
    ).toBe(false);
    expect(
      PromptSubject.safeParse({ type: 'tool', tool: 'a-tool', input: { value: Number.NaN } })
        .success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(PromptSubject.safeParse({ type: 'tool', tool: 'a-tool', input: cyclic }).success).toBe(
      false,
    );
    expect(
      AdapterPrompt.safeParse({
        ...approval,
        subject: { type: 'tool', tool: 'a-tool', input: cyclic },
      }).success,
    ).toBe(false);
    const plan = {
      kind: 'plan',
      title: 'Review',
      answerIn: 'api',
      choices: [yes, no],
      plan: 'x'.repeat(200_000),
    };
    expect(AdapterPrompt.safeParse(plan).success).toBe(true);
    expect(
      AdapterPrompt.safeParse({ ...plan, plan: '😀'.repeat(MAX_PROMPT_BYTES / 4) }).success,
    ).toBe(false);
    expect(
      AdapterPrompt.safeParse({ ...approval, title: 'x'.repeat(4001), cut: true }).success,
    ).toBe(false);
  });

  it('refuses an accessor in tool input before the aggregate check can serialize it', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads++;
        return 'not data';
      },
    });
    expect(
      AdapterPrompt.safeParse({ ...approval, subject: { type: 'tool', tool: 'a-tool', input } })
        .success,
    ).toBe(false);
    expect(reads).toBe(0);
  });
});

describe('questions and answers by id', () => {
  it('accepts sixteen whole questions, including duplicate wording that a CLI can key by id', () => {
    const sixteen = Array.from({ length: MAX_PROMPT_QUESTIONS }, (_, i) => ({
      ...question,
      id: `q${String(i)}`,
    }));
    expect(Questions.safeParse(sixteen).success).toBe(true);
    expect(Questions.safeParse([...sixteen, { ...question, id: 'extra' }]).success).toBe(false);
    expect(Questions.safeParse([question, question]).success).toBe(false);
    expect(
      Questions.safeParse([{ ...question, options: [question.options[0], question.options[0]] }])
        .success,
    ).toBe(false);
    expect(Questions.safeParse([{ ...question, options: [], other: false }]).success).toBe(false);
  });

  it('answers every exact id once with distinct offered labels, preserving commas and ordering', () => {
    const answers = { q1: { picked: ['a, b'] }, q2: { picked: ['second', 'a, b'] } };
    expect(checkQuestionAnswers(questions, answers)).toEqual(answers);
    expect(
      checkQuestionAnswers(questions, { q1: { text: '  my words  ' }, q2: { picked: ['second'] } }),
    ).toEqual({ q1: { text: '  my words  ' }, q2: { picked: ['second'] } });
    for (const invalid of [
      { q1: { picked: ['a, b'] } },
      { ...answers, unknown: { text: 'x' } },
      { ...answers, q1: { picked: ['a', 'b'] } },
      { ...answers, q1: { picked: ['a, b'], text: 'also words' } },
      { ...answers, q2: { text: 'not offered' } },
      { ...answers, q1: { text: '   ' } },
      { ...answers, q1: { picked: [] } },
      { ...answers, q2: { picked: ['second', 'second'] } },
      { ...answers, q1: { text: 'x'.repeat(20_001) } },
    ])
      expect(() => checkQuestionAnswers(questions, invalid)).toThrow();
  });

  it('treats prototype-looking native question ids as exact data keys', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const answers = Object.fromEntries([[id, { picked: ['second'] }]]);
      expect(checkQuestionAnswers([{ ...question, id }], answers)).toEqual(answers);
    }
  });
});

describe('answers checked against the immutable prompt', () => {
  it('takes only an offered choice and its declared feedback, without inventing a default', () => {
    const prompt = AdapterPrompt.parse({
      ...approval,
      choices: [yes, { ...no, feedback: 'required', endsTurn: false }],
    });
    expect(checkPromptAnswer(prompt, { kind: 'choice', value: 'yes' })).toEqual({
      kind: 'choice',
      value: 'yes',
    });
    expect(
      checkPromptAnswer(prompt, {
        kind: 'choice',
        value: 'no',
        feedback: 'Try this instead',
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    ).toMatchObject({
      value: 'no',
      feedback: 'Try this instead',
      decider: { party: 'agent:lead', name: 'Lead' },
    });
    for (const answer of [
      { kind: 'choice', value: 'yes', feedback: 'not offered' },
      { kind: 'choice', value: 'no' },
      { kind: 'choice', value: 'no', feedback: '  ' },
      { kind: 'choice', value: 'unknown' },
      { kind: 'choice', value: 'yes', text: 'hold text' },
      { kind: 'questions', answers: {} },
    ])
      expect(() => checkPromptAnswer(prompt, answer)).toThrow();
    expect(() =>
      checkPromptAnswer(AdapterPrompt.parse({ ...approval, answerIn: 'terminal' }), {
        kind: 'choice',
        value: 'yes',
      }),
    ).toThrow(/terminal/i);
  });

  it('keeps reply shapes separate from adapter answers and accepts no old permission or plan shape', () => {
    for (const invalid of [
      { permission: 'allow' },
      { plan: { approve: true } },
      { choice: 'yes', text: 'instead' },
      { answers: { q1: { picked: ['a'], text: 'x' } } },
    ])
      expect(PromptReplyAnswer.safeParse(invalid).success).toBe(false);
    expect(checkPromptReply(AdapterPrompt.parse(approval), { choice: 'yes' })).toEqual({
      kind: 'choice',
      value: 'yes',
    });
    expect(PromptAnswer.safeParse({ kind: 'choice', choice: 'yes' }).success).toBe(false);
  });
});
