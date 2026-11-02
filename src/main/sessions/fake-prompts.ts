import type { AdapterPrompt, PromptAnswer } from '../../shared/model/prompts';
import type { SessionAnswer, SessionEvent } from '../../shared/session';

/** The in-memory app fake speaks the owner protocol, just as the native adapter fakes do. */
export function fakePrompt(
  event: Extract<SessionEvent, { type: 'permission' | 'question' | 'plan' }>,
): { prompt: AdapterPrompt; answer: (answer: PromptAnswer) => SessionAnswer } {
  const common = { answerIn: 'api' as const, signals: { requiresUser: true as const } };
  if (event.type === 'question')
    return {
      prompt: {
        ...common,
        kind: 'question',
        title: 'Shall I go on?',
        questions: event.questions.map((question, index) => ({
          ...question,
          id: `q${String(index + 1)}`,
          other: true,
        })),
      },
      answer: (answer) => {
        if (answer.kind !== 'questions') throw new Error('Answer the questions.');
        return {
          kind: 'question',
          answers: event.questions.map((_, index) => {
            const value = answer.answers[`q${String(index + 1)}`];
            return value ? ('text' in value ? value.text : value.picked.join(', ')) : '';
          }),
        };
      },
    };
  if (event.type === 'plan')
    return {
      prompt: {
        ...common,
        kind: 'plan',
        title: 'Approve this plan?',
        plan: event.plan,
        choices: [
          {
            value: 'accept-edits',
            label: 'Yes, and auto-accept edits',
            hint: 'allow_once',
            effects: { mode: 'acceptEdits' },
          },
          {
            value: 'manual',
            label: 'Yes, manually approve edits',
            hint: 'allow_once',
            effects: { mode: 'manual' },
          },
          {
            value: 'keep-planning',
            label: 'No, keep planning',
            hint: 'reject_once',
            effects: {},
            feedback: 'optional',
          },
        ],
      },
      answer: (answer) => {
        if (answer.kind !== 'choice') throw new Error('Choose a decision.');
        return {
          kind: 'plan',
          answer:
            answer.value === 'keep-planning'
              ? { approve: false, feedback: answer.feedback ?? '' }
              : { approve: true, mode: answer.value === 'accept-edits' ? 'acceptEdits' : 'manual' },
        };
      },
    };
  return {
    prompt: {
      ...common,
      kind: 'approval',
      title: 'Run this command?',
      summary: event.summary,
      subject: { type: 'tool', tool: event.tool, input: { command: event.summary } },
      choices: [
        { value: 'allow', label: 'Yes', hint: 'allow_once', effects: {} },
        ...(event.always
          ? [{ value: 'always', label: event.always, hint: 'allow_always' as const, effects: {} }]
          : []),
        { value: 'deny', label: 'No', hint: 'reject_once', effects: {} },
      ],
    },
    answer: (answer) => {
      if (answer.kind !== 'choice') throw new Error('Choose a decision.');
      return {
        kind: 'permission',
        answer: answer.value === 'allow' ? 'once' : answer.value === 'always' ? 'always' : 'deny',
      };
    },
  };
}
