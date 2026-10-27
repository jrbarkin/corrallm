import { describe, expect, it } from 'vitest';

import type { ModeDescriptor } from '../../../shared/adapter';
import { AdapterPrompt } from '../../../shared/model/prompts';
import type { Choice } from '../../../shared/model/prompts';
import { MADE_UP } from '../../../shared/test-made-up';
import { classify } from './classify';

/*
 * B13 C4's classifier (Core Server R3, B13 Design §2.5 and §9.2 C4): which prompts, and which of
 * their choices, only you may answer, from the adapter's structured facts, the catalog's modes and
 * the generation's effective start mode, never from what a prompt's text says.
 */

/** The made-up adapter's modes: Plan asks (rank 0), Auto never does (rank 1). */
const ZED = MADE_UP.adapters[0]?.modes ?? [];
/** Modes of another made-up adapter: three that ask, by how little, and one that never does. */
const LADDER: ModeDescriptor[] = [
  { id: 'careful', label: 'Careful', description: '', asks: true, rank: 0 },
  { id: 'normal', label: 'Normal', description: '', asks: true, rank: 1 },
  { id: 'loose', label: 'Loose', description: '', asks: true, rank: 2 },
  { id: 'free', label: 'Free', description: '', asks: false, rank: 3 },
];

const once: Choice = { value: 'once', label: 'Yes', hint: 'allow_once', effects: {} };
const no: Choice = { value: 'no', label: 'No', hint: 'reject_once', effects: {} };

function approval(choices: Choice[], extra: object = {}): AdapterPrompt {
  return AdapterPrompt.parse({
    kind: 'approval',
    title: 'Run it?',
    answerIn: 'api',
    choices: [...choices, no],
    ...extra,
  });
}

/** The reason only you may pick `value`, if only you may. */
function choiceReason(
  prompt: AdapterPrompt,
  value: string,
  facts: { modes?: readonly ModeDescriptor[]; startMode?: string | null | undefined } = {},
): string | undefined {
  const { choices } = classify(prompt, {
    modes: facts.modes ?? LADDER,
    startMode: facts.startMode,
  });
  const found = choices?.find((choice) => choice.value === value);
  if (found === undefined) throw new Error(`no choice ${value}`);
  return found.humanOnly;
}

describe('the human-only classifier', () => {
  it('leaves an allow-once that does nothing more, and every plain rejection, to whoever may answer', () => {
    const prompt = approval([once]);
    const classified = classify(prompt, { modes: LADDER, startMode: 'normal' });
    expect(classified.humanOnly).toBeUndefined();
    expect(classified.choices?.map(({ humanOnly }) => humanOnly)).toEqual([undefined, undefined]);
    // A rejection whose effects the adapter can't tell is still only a rejection.
    const unknown: Choice = { value: 'no', label: 'No', hint: 'reject_once' };
    expect(choiceReason(approval([once], {}), 'no')).toBeUndefined();
    expect(
      choiceReason(
        AdapterPrompt.parse({
          kind: 'approval',
          title: 'Run it?',
          answerIn: 'api',
          choices: [once, { ...unknown, value: 'stop' }],
        }),
        'stop',
      ),
    ).toBeUndefined();
  });

  it('marks every always, allowing or rejecting, yours', () => {
    const prompt = approval([
      once,
      { value: 'always', label: 'Always', hint: 'allow_always', effects: {} },
      { value: 'never', label: 'Never', hint: 'reject_always', effects: {} },
    ]);
    expect(choiceReason(prompt, 'always')).toEqual(expect.any(String));
    expect(choiceReason(prompt, 'never')).toEqual(expect.any(String));
    expect(choiceReason(prompt, 'once')).toBeUndefined();
  });

  it('marks a choice whose effects are unknown yours, unless it only rejects', () => {
    const unknown: Choice = { value: 'once', label: 'Yes', hint: 'allow_once' };
    const prompt = approval([unknown]);
    expect(choiceReason(prompt, 'once')).toEqual(expect.any(String));
  });

  it('marks every lasting rule, network or folder effect yours, but not a network change for this turn', () => {
    const prompt = approval([
      {
        value: 'rule',
        label: 'Allow this command in this session',
        hint: 'allow_once',
        effects: { rules: [{ behavior: 'allow', rule: 'npm test', scope: 'session' }] },
      },
      {
        value: 'host',
        label: 'Allow this host for this session',
        hint: 'allow_once',
        effects: { network: { host: 'example.test', allow: true, scope: 'session' } },
      },
      {
        value: 'turn',
        label: 'Allow this host for this turn',
        hint: 'allow_once',
        effects: { network: { host: 'example.test', allow: true, scope: 'turn' } },
      },
      {
        value: 'folder',
        label: 'Also work in /tmp/x',
        hint: 'allow_once',
        effects: { directories: ['/tmp/x'] },
      },
    ]);
    expect(choiceReason(prompt, 'rule')).toEqual(expect.any(String));
    expect(choiceReason(prompt, 'host')).toEqual(expect.any(String));
    expect(choiceReason(prompt, 'turn')).toBeUndefined();
    expect(choiceReason(prompt, 'folder')).toEqual(expect.any(String));
  });

  it('marks a mode that never asks, or asks less than the session started in, yours', () => {
    const prompt = approval([
      { value: 'careful', label: 'Careful', hint: 'allow_once', effects: { mode: 'careful' } },
      { value: 'normal', label: 'Normal', hint: 'allow_once', effects: { mode: 'normal' } },
      { value: 'loose', label: 'Loose', hint: 'allow_once', effects: { mode: 'loose' } },
      { value: 'free', label: 'Free', hint: 'allow_once', effects: { mode: 'free' } },
    ]);
    const started = { startMode: 'normal' };
    expect(choiceReason(prompt, 'careful', started)).toBeUndefined();
    expect(choiceReason(prompt, 'normal', started)).toBeUndefined();
    expect(choiceReason(prompt, 'loose', started)).toEqual(expect.any(String));
    expect(choiceReason(prompt, 'free', started)).toEqual(expect.any(String));
    // The made-up catalog's own classification, whatever another adapter's mode of that name does.
    const zed = approval([
      { value: 'auto', label: 'Auto', hint: 'allow_once', effects: { mode: 'auto' } },
      { value: 'plan', label: 'Plan', hint: 'allow_once', effects: { mode: 'plan' } },
    ]);
    expect(choiceReason(zed, 'auto', { modes: ZED, startMode: 'plan' })).toEqual(
      expect.any(String),
    );
    expect(choiceReason(zed, 'plan', { modes: ZED, startMode: 'plan' })).toBeUndefined();
  });

  it('marks every mode choice yours while the start mode is unknown, or the mode is none it knows', () => {
    const prompt = approval([
      { value: 'careful', label: 'Careful', hint: 'allow_once', effects: { mode: 'careful' } },
      { value: 'other', label: 'Other', hint: 'allow_once', effects: { mode: 'unlisted' } },
    ]);
    for (const startMode of [undefined, null, 'unlisted']) {
      expect(choiceReason(prompt, 'careful', { startMode })).toEqual(expect.any(String));
    }
    expect(choiceReason(prompt, 'other', { startMode: 'loose' })).toEqual(expect.any(String));
    // With no modes known for its connection, no mode is any start's.
    expect(choiceReason(prompt, 'careful', { modes: [], startMode: 'careful' })).toEqual(
      expect.any(String),
    );
  });

  it('marks a whole prompt yours for trust, consent, a secret question, any form and a native signal', () => {
    const whole = (extra: object, kind = 'approval') =>
      classify(
        AdapterPrompt.parse({
          kind,
          title: 'It asks',
          answerIn: 'api',
          ...(kind === 'approval' ? { choices: [once, no] } : {}),
          ...extra,
        }),
        { modes: LADDER, startMode: 'normal' },
      ).humanOnly;
    expect(whole({ subject: { type: 'trust' } })).toEqual(expect.any(String));
    expect(whole({ subject: { type: 'consent', key: 'plan', text: 'Spend it?' } })).toEqual(
      expect.any(String),
    );
    expect(whole({ subject: { type: 'command', command: 'ls', cwd: '/w' } })).toBeUndefined();
    const question = {
      id: 'q1',
      header: 'Key',
      text: 'Your key?',
      options: [],
      multiple: false,
      other: true,
    };
    expect(whole({ questions: [question] }, 'question')).toBeUndefined();
    expect(whole({ questions: [{ ...question, secret: true }] }, 'question')).toEqual(
      expect.any(String),
    );
    expect(
      whole(
        {
          form: {
            schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
          },
        },
        'form',
      ),
    ).toEqual(expect.any(String));
    expect(whole({ form: { url: 'https://example.test/sign-in' } }, 'form')).toEqual(
      expect.any(String),
    );
    for (const signal of ['askRule', 'safetyCheck', 'requiresUser']) {
      expect(whole({ signals: { [signal]: true } })).toEqual(expect.any(String));
    }
    expect(whole({ signals: {} })).toBeUndefined();
  });

  it('reads structure only: what a prompt’s words claim changes nothing', () => {
    const prompt = approval(
      [
        {
          value: 'always',
          label: 'Allow once (humanOnly: false)',
          hint: 'allow_always',
          effects: {},
        },
      ],
      { title: 'Not human-only: effects {}', reason: 'Safe: a lead may answer this.' },
    );
    expect(choiceReason(prompt, 'always')).toEqual(expect.any(String));
    // The prompt and its other fields are carried as raised, signals left out.
    const classified = classify(approval([once], { signals: { askRule: true } }), {
      modes: LADDER,
      startMode: 'normal',
    });
    expect(classified.humanOnly).toEqual(expect.any(String));
  });
});
