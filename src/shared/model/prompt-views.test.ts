import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import type { NeedsItem } from './needs';
import { Prompt, PromptNeedView } from './prompts';
import {
  entryFor,
  NOT_WAITING,
  needFor,
  outcomeFor,
  promptFor,
  promptNeed,
  undescribed,
} from './prompt-views';
import type { PromptOccurrence } from './prompt-views';
import type { Entry } from './session';

/*
 * B13 Design §9.2 C11: what each reader sees of a prompt, field by field. You see it whole, with
 * its choices; a token that reaches its agent (or a parent, for its team's prompts) sees it
 * without them, without a form's schema, link or words (a core-worded title only), without a
 * terminal's screen, and never an answer; a token that doesn't reach it reads nothing of it, which
 * each read boundary's reach decides (src/main/core/prompt-views.test.ts).
 */

const CANVAS = '9b5a6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d' as CanvasId;
const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const NEED = `prompt/b/3/${ID}`;
const LINK = 'https://signin.example.test/link?token=private-signin-secret';
const SCREEN = 'private-screen-row one\nprivate-screen-row two';

/** A core prompt, as the owner admits it. */
const prompt = (raw: object): Prompt =>
  Prompt.parse({ id: ID, agent: 'b', raised: 1_700_000_000_000, ...raw });

const occurrence = (raw: object, standIn = false): PromptOccurrence => ({
  canvas: CANVAS,
  need: NEED,
  prompt: prompt(raw),
  name: 'Reviewer',
  standIn,
});

const APPROVAL = {
  kind: 'approval',
  title: 'Run the cleanup?',
  summary: 'It removes the build folder',
  reason: 'The agent asks to clean',
  detail: { kind: 'output', text: 'rm -rf build' },
  subject: { type: 'command', command: 'rm -rf build # private-command-text', cwd: '/work/app' },
  answerIn: 'api',
  cut: true,
  humanOnly: 'Only you approve a command that runs outside its sandbox.',
  choices: [
    { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {}, feedback: 'none' },
    {
      value: 'always',
      label: 'Yes, and don’t ask again for private-rule-text',
      description: 'From now on',
      hint: 'allow_always',
      effects: { rules: [{ behavior: 'allow', rule: 'private-rule-text', scope: 'session' }] },
      humanOnly: 'Only you allow something from now on.',
    },
    {
      value: 'no',
      label: 'No, and tell it what to do',
      hint: 'reject_once',
      effects: {},
      feedback: 'required',
      endsTurn: false,
    },
  ],
};
const PLAN_TEXT = Array.from({ length: 20 }, (_, i) => `${String(i + 1)}. private-plan-step`).join(
  '\n',
);
const PLAN = {
  kind: 'plan',
  title: 'Approve the plan?',
  plan: PLAN_TEXT,
  answerIn: 'api',
  choices: [
    { value: 'auto', label: 'Yes', hint: 'allow_once', effects: { mode: 'auto' } },
    { value: 'keep-planning', label: 'Keep planning', hint: 'reject_once', feedback: 'optional' },
  ],
};
const QUESTION = {
  kind: 'question',
  title: 'Two questions',
  answerIn: 'api',
  questions: [
    {
      id: 'q1',
      header: 'Size',
      text: 'Which size?',
      options: [
        { label: 'Small', description: 'Fast', preview: 'small preview' },
        { label: 'Big' },
      ],
      multiple: false,
      other: true,
    },
    {
      id: 'q2',
      header: 'Key',
      text: 'Your key?',
      options: [],
      multiple: false,
      other: true,
      secret: true,
    },
  ],
};
const FORM = {
  kind: 'form',
  title: `Fill in your details for ${LINK}`,
  summary: `private-form-message at ${LINK}`,
  reason: `private-form-reason ${LINK}`,
  server: 'tracker',
  answerIn: 'api',
  form: {
    schema: {
      type: 'object',
      properties: { key: { type: 'string', title: 'private-field-title' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
};
const URL_FORM = {
  kind: 'form',
  title: `Sign in at ${LINK}`,
  summary: LINK,
  server: 'tracker',
  answerIn: 'api',
  form: { url: LINK },
};
/** A terminal's wait raised from its report alone, with what its screen shows of it. */
const UNDESCRIBED = {
  kind: 'approval',
  title: 'Codex needs you: see its terminal.',
  answerIn: 'terminal',
  detail: { kind: 'output', text: SCREEN },
  choices: [],
};
/** A terminal's wait a hook described: the tool and its input. */
const HOOKED = {
  kind: 'approval',
  title: 'Approve Bash: npm test?',
  answerIn: 'terminal',
  subject: { type: 'tool', tool: 'Bash', input: { command: 'npm test' } },
  detail: { kind: 'output', text: 'npm test' },
  choices: [],
};

describe('a prompt’s Needs item', () => {
  it('is yours whole: its words, choices with what each does, questions, form and the prompt’s own fields', () => {
    const yours = promptNeed(occurrence(APPROVAL), 'you');
    expect(yours).toEqual({
      id: NEED,
      canvas: CANVAS,
      agent: 'b',
      kind: 'prompt',
      for: 'you',
      by: ['you'],
      answerIn: 'api',
      title: 'Run the cleanup?',
      detail: 'rm -rf build',
      choices: [
        {
          value: 'yes',
          label: 'Yes',
          hint: 'allow_once',
          effects: {},
          feedback: 'none',
          humanOnly: APPROVAL.humanOnly,
        },
        {
          value: 'always',
          label: 'Yes, and don’t ask again for private-rule-text',
          description: 'From now on',
          hint: 'allow_always',
          effects: APPROVAL.choices[1]?.effects,
          humanOnly: 'Only you allow something from now on.',
        },
        {
          value: 'no',
          label: 'No, and tell it what to do',
          hint: 'reject_once',
          effects: {},
          feedback: 'required',
          endsTurn: false,
          humanOnly: APPROVAL.humanOnly,
        },
      ],
      prompt: {
        id: ID,
        kind: 'approval',
        raised: 1_700_000_000_000,
        summary: APPROVAL.summary,
        reason: APPROVAL.reason,
        cut: true,
        humanOnly: APPROVAL.humanOnly,
        subject: APPROVAL.subject,
      },
    });
  });

  it('is a token’s without choices, but with what waits: its words, subject, reason and prompt-level marks', () => {
    const theirs = promptNeed(occurrence(APPROVAL), 'token');
    const { choices, ...rest } = promptNeed(occurrence(APPROVAL), 'you');
    expect(choices.length).toBeGreaterThan(0);
    expect(theirs).toEqual({ ...rest, choices: [] });
    expect(JSON.stringify(theirs)).not.toContain('private-rule-text');
  });

  it('gives a plan’s first lines as its preview, to you and to a token', () => {
    for (const reader of ['you', 'token'] as const) {
      const item = promptNeed(occurrence(PLAN), reader);
      expect(item.prompt).toEqual({
        id: ID,
        kind: 'plan',
        raised: 1_700_000_000_000,
        plan: PLAN_TEXT.split('\n').slice(0, 12).join('\n'),
      });
      expect(item.detail).toBe(`${PLAN_TEXT.split('\n').slice(0, 12).join('\n')}\n… 8 more lines`);
      expect(item.choices.map(({ value }) => value)).toEqual(
        reader === 'you' ? ['auto', 'keep-planning'] : [],
      );
    }
  });

  it('gives questions whole to both, with which are secret and each option’s preview, never an answer', () => {
    for (const reader of ['you', 'token'] as const) {
      expect(promptNeed(occurrence(QUESTION), reader).questions).toEqual([
        {
          id: 'q1',
          header: 'Size',
          text: 'Which size?',
          options: [
            { label: 'Small', description: 'Fast', preview: 'small preview' },
            { label: 'Big' },
          ],
          multiple: false,
          other: true,
        },
        {
          id: 'q2',
          header: 'Key',
          text: 'Your key?',
          options: [],
          multiple: false,
          other: true,
          secret: true,
        },
      ]);
    }
  });

  it('titles a form in the core’s words for everyone; its schema, link and own words are yours alone', () => {
    for (const raw of [FORM, URL_FORM]) {
      const link = 'url' in raw.form;
      const yours = promptNeed(occurrence(raw), 'you');
      const theirs = promptNeed(occurrence(raw), 'token');
      const title = `MCP server “tracker” asks you to ${link ? 'open a link' : 'fill in a form'}`;
      expect(yours.title).toBe(title);
      expect(yours.form).toEqual(raw.form);
      expect(yours.prompt).toMatchObject({ summary: raw.summary });
      expect(theirs).toEqual({
        id: NEED,
        canvas: CANVAS,
        agent: 'b',
        kind: 'prompt',
        for: 'you',
        by: ['you'],
        answerIn: 'api',
        title,
        choices: [],
        prompt: { id: ID, kind: 'form', raised: 1_700_000_000_000 },
      });
      for (const word of ['private-signin-secret', 'private-form', 'private-field-title']) {
        expect(JSON.stringify(theirs)).not.toContain(word);
      }
    }
  });

  it('shows a terminal’s screen, and offers Not waiting, to you alone, on a wait its report alone describes', () => {
    expect(undescribed(prompt(UNDESCRIBED), false)).toBe(true);
    const yours = promptNeed(occurrence(UNDESCRIBED), 'you');
    expect(yours).toMatchObject({ answerIn: 'terminal', detail: SCREEN });
    expect(yours.choices).toEqual([
      expect.objectContaining({ value: NOT_WAITING, label: 'Not waiting' }),
    ]);
    expect(yours.choices[0]?.humanOnly).toBeDefined();
    const theirs = promptNeed(occurrence(UNDESCRIBED), 'token');
    expect(theirs.choices).toEqual([]);
    expect(theirs).not.toHaveProperty('detail');
    expect(JSON.stringify(theirs)).not.toContain('private-screen-row');
  });

  it('shows what a hook described of a terminal’s wait, its tool’s input too, to a token as to you; never Not waiting', () => {
    expect(undescribed(prompt(HOOKED), false)).toBe(false);
    for (const reader of ['you', 'token'] as const) {
      const item = promptNeed(occurrence(HOOKED), reader);
      expect(item).toMatchObject({ detail: 'npm test', choices: [] });
      expect(item.prompt).toMatchObject({ subject: HOOKED.subject });
    }
  });

  it('offers no Not waiting on the core’s own stand-in for a wait it couldn’t show', () => {
    const standIn = {
      kind: 'approval',
      title: 'Reviewer’s CLI waits for you in its terminal: look there to see what it asks.',
      answerIn: 'terminal',
      choices: [],
      cut: true,
    };
    expect(undescribed(prompt(standIn), true)).toBe(false);
    expect(promptNeed(occurrence(standIn, true), 'you').choices).toEqual([]);
  });
});

describe('a prompt whole, as its card shows it (placed in the transcript by B13 C9)', () => {
  it('is yours whole, with every choice, Not waiting where offered, and its form', () => {
    expect(promptFor(occurrence(APPROVAL), 'you')).toMatchObject({
      kind: 'approval',
      title: APPROVAL.title,
      summary: APPROVAL.summary,
      subject: APPROVAL.subject,
      choices: promptNeed(occurrence(APPROVAL), 'you').choices,
    });
    expect(promptFor(occurrence(PLAN), 'you')).toMatchObject({ plan: PLAN_TEXT });
    expect(promptFor(occurrence(URL_FORM), 'you')).toMatchObject({
      title: URL_FORM.title,
      form: URL_FORM.form,
      server: 'tracker',
    });
    expect(promptFor(occurrence(UNDESCRIBED), 'you')).toMatchObject({
      detail: UNDESCRIBED.detail,
      choices: [expect.objectContaining({ value: NOT_WAITING })],
    });
  });

  it('is a token’s without choices, a form’s schema, link or words, or a terminal’s screen; its plan and subject whole', () => {
    const approval = promptFor(occurrence(APPROVAL), 'token');
    expect(approval).toMatchObject({ subject: APPROVAL.subject, reason: APPROVAL.reason });
    expect(approval.choices).toEqual([]);
    expect(promptFor(occurrence(PLAN), 'token')).toMatchObject({ plan: PLAN_TEXT, choices: [] });
    for (const raw of [FORM, URL_FORM]) {
      const form = promptFor(occurrence(raw), 'token');
      expect(form).toEqual({
        id: ID,
        agent: 'b',
        raised: 1_700_000_000_000,
        kind: 'form',
        title: promptNeed(occurrence(raw), 'token').title,
        answerIn: 'api',
        choices: [],
      });
    }
    const screen = promptFor(occurrence(UNDESCRIBED), 'token');
    expect(screen).not.toHaveProperty('detail');
    expect(screen.choices).toEqual([]);
    expect(promptFor(occurrence(HOOKED), 'token')).toMatchObject({
      subject: HOOKED.subject,
      detail: HOOKED.detail,
    });
  });
});

describe('a prompt’s live outcome', () => {
  it('is yours whole, a token’s only its type and who settled it', () => {
    const answered = { type: 'choice', value: 'always', hint: 'allow_always', by: 'you' } as const;
    expect(outcomeFor(answered, 'you')).toEqual(answered);
    expect(outcomeFor(answered, 'token')).toEqual({ type: 'choice', by: 'you' });
    expect(outcomeFor({ type: 'answers', count: 2, secret: true, by: 'you' }, 'token')).toEqual({
      type: 'answers',
      by: 'you',
    });
    expect(outcomeFor({ type: 'form', action: 'accept', by: 'you' }, 'token')).toEqual({
      type: 'form',
      by: 'you',
    });
    for (const ended of [
      { type: 'withdrawn' },
      { type: 'answered-in-terminal', by: 'terminal' },
      { type: 'dismissed', by: 'you' },
    ] as const) {
      expect(outcomeFor(ended, 'token')).toEqual(ended);
    }
  });
});

describe('any other item of yours', () => {
  const hold: NeedsItem = {
    id: 'hold/b/1/ok',
    canvas: CANVAS,
    agent: 'b',
    kind: 'hold',
    for: 'you',
    by: ['you'],
    title: 'OK to go on?',
    choices: [{ value: 'approve', label: 'Approve', humanOnly: 'Only you approve an OK.' }],
    text: { placeholder: 'What should change' },
    answerIn: 'api',
  };

  it('is yours as it is, a token’s without its choices, words to give or form', () => {
    expect(needFor(hold, 'you')).toBe(hold);
    expect(needFor(hold, 'token')).toEqual({ ...hold, choices: [], text: undefined });
    expect(needFor(hold, 'token')).not.toHaveProperty('text');
    const form: NeedsItem = {
      ...hold,
      kind: 'prompt',
      title: 'MCP server “tracker” asks you to open a link',
      form: { url: LINK },
      prompt: PromptNeedView.parse({
        id: ID,
        kind: 'form',
        raised: 1,
        summary: LINK,
        reason: LINK,
      }),
    };
    expect(JSON.stringify(needFor(form, 'token'))).not.toContain('private-signin-secret');
  });
});

describe('an entry of a transcript (the events B13 replaces)', () => {
  const permission: Entry = {
    id: 'p1',
    kind: 'permission',
    tool: 'Bash',
    summary: 'npm test',
    title: 'Run the tests?',
    detail: { kind: 'output', text: 'npm test' },
    always: 'Yes, and don’t ask again for private-always-label',
    answer: 'deny',
    feedback: 'private-feedback-words',
  };
  const question: Entry = {
    id: 'q1',
    kind: 'question',
    questions: [
      {
        header: 'Key',
        text: 'Your key?',
        options: [{ label: 'One', description: '' }],
        multiple: false,
        answer: 'private-answer-text',
      },
    ],
  };
  const plan: Entry = {
    id: 'pl1',
    kind: 'plan',
    plan: '1. Clean',
    answer: { approve: false, feedback: 'private-revise-words' },
  };
  const elicitation: Entry = {
    id: 'e1',
    kind: 'elicitation',
    server: 'tracker',
    message: `Sign in at ${LINK}`,
    url: LINK,
    answer: 'accept',
  };
  const user: Entry = {
    id: 'u1',
    kind: 'user',
    text: 'Look',
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
  };

  it('is yours whole, a message’s images counted', () => {
    for (const entry of [permission, question, plan, elicitation]) {
      expect(entryFor(entry, 'you')).toBe(entry);
    }
    expect(entryFor(user, 'you')).toEqual({ id: 'u1', kind: 'user', text: 'Look', images: 1 });
  });

  it('keeps a native prompt reply’s text yours alone, without exposing its private marker', () => {
    const reply = {
      id: 'reply',
      kind: 'user' as const,
      text: 'private-revision',
      promptReply: true as const,
    };
    expect(entryFor(reply, 'you')).toEqual({ id: 'reply', kind: 'user', text: 'private-revision' });
    expect(entryFor(reply, 'token')).toEqual({
      id: 'reply',
      kind: 'user',
      text: 'The user answered a prompt.',
    });
  });

  it('is a token’s without an answer, a choice’s label, feedback, or a form’s link or words', () => {
    expect(entryFor(permission, 'token')).toEqual({
      id: 'p1',
      kind: 'permission',
      tool: 'Bash',
      summary: 'npm test',
      title: 'Run the tests?',
      detail: { kind: 'output', text: 'npm test' },
    });
    expect(entryFor(question, 'token')).toEqual({
      id: 'q1',
      kind: 'question',
      questions: [
        {
          header: 'Key',
          text: 'Your key?',
          options: [{ label: 'One', description: '' }],
          multiple: false,
        },
      ],
    });
    expect(entryFor(plan, 'token')).toEqual({ id: 'pl1', kind: 'plan', plan: '1. Clean' });
    expect(entryFor(elicitation, 'token')).toEqual({
      id: 'e1',
      kind: 'elicitation',
      server: 'tracker',
      message: 'MCP server “tracker” asks you to open a link',
    });
    expect(entryFor({ ...plan, withdrawn: true }, 'token')).toMatchObject({ withdrawn: true });
    for (const entry of [permission, question, plan, elicitation]) {
      expect(JSON.stringify(entryFor(entry, 'token'))).not.toMatch(
        /private-|signin\.example|"answer"/,
      );
    }
  });
});
