import type { AdapterPrompt } from '../../shared/model/prompts';

/** Owner prompts shared by the in-memory connector and its tests. */
export function fakeApproval(): AdapterPrompt {
  return {
    kind: 'approval',
    answerIn: 'api',
    signals: { requiresUser: true },
    title: 'Run this command?',
    summary: 'echo hello',
    subject: { type: 'tool', tool: 'Bash', input: { command: 'echo hello' } },
    choices: [
      { value: 'allow', label: 'Yes', hint: 'allow_once', effects: {} },
      {
        value: 'always',
        label: 'Yes, and don’t ask again for echo commands in this folder',
        hint: 'allow_always',
        effects: {},
      },
      { value: 'deny', label: 'No', hint: 'reject_once', effects: {}, feedback: 'optional' },
    ],
  };
}
export function fakeQuestions(): AdapterPrompt {
  return {
    kind: 'question',
    answerIn: 'api',
    signals: { requiresUser: true },
    title: 'Shall I go on?',
    questions: [
      {
        id: 'q1',
        header: 'Go on?',
        text: 'Shall I go on?',
        options: [
          { label: 'Yes', description: 'Carry on' },
          { label: 'No', description: 'Stop here' },
        ],
        multiple: false,
        other: true,
      },
    ],
  };
}
export function fakePlan(): AdapterPrompt {
  return {
    kind: 'plan',
    answerIn: 'api',
    signals: { requiresUser: true },
    title: 'Approve this plan?',
    plan: '1. Read the code\n2. Change it',
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
  };
}

/**
 * A connection's consent (B22a C4), asked before a turn that would use what it covers: Yes for
 * the session, Yes for good, or No.
 */
export function fakeConsent(key: string): AdapterPrompt {
  return {
    kind: 'approval',
    answerIn: 'api',
    signals: { requiresUser: true },
    title: 'Use your made-up plan here?',
    summary: 'The fake’s plan',
    subject: { type: 'consent', key, text: 'The fake asks before a turn uses its plan.' },
    choices: [
      {
        value: 'once',
        label: 'Yes',
        hint: 'allow_once',
        effects: {},
        feedback: 'none',
        endsTurn: false,
      },
      {
        value: 'always',
        label: "Yes, and don't ask again on this computer",
        hint: 'allow_always',
        feedback: 'none',
        endsTurn: false,
      },
      {
        value: 'no',
        label: 'No',
        hint: 'reject_once',
        effects: {},
        feedback: 'none',
        endsTurn: true,
      },
    ],
  };
}
