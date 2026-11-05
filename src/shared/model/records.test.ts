import { describe, expect, expectTypeOf, it } from 'vitest';

import { TranscriptEntry } from '../api/ops/session';
import type { CanvasId } from '../canvas';
import type { SessionEvent } from '../session';
import { AskSettlement } from './asks';
import type { Message } from './messages';
import type { Entry } from './session';
import {
  MAX_RECORD_ENTRIES,
  RecordAbout,
  recordEntryFor,
  recordEntryId,
  recordsFor,
  recordWords,
  shownRecord,
  UNRESOLVED_ANSWER,
} from './records';
import type { RecordEntryView } from './records';
import { SettledDecision } from './settled';

/*
 * B19 C3's shared contract: a settled record, with the association the core wrote with it, as the
 * window shows it: a typed display entry, value-free, under a stable namespaced id, selected per
 * reader by one selector (yours alone: a token reaching the agent reads none).
 */

const CANVAS = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as CanvasId;
const PROMPT = '0f1e2d3c-4b5a-4968-8776-655443322110';

function record(fields: Partial<Message> = {}): Message {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    canvas: CANVAS,
    from: 'corrallm',
    to: 'you',
    kind: 'settled',
    body: 'You answered “private-hold-title”: private-choice-label.',
    state: 'delivered',
    by: 'you',
    at: 1_700_000_000_000,
    ...fields,
  };
}

const HOLD: RecordAbout = {
  v: 1,
  agent: 'a',
  need: 'hold/a/0a1b2c3d/ok',
  hold: { choice: 'approve' },
};
const NATIVE = SettledDecision.parse({
  v: 1,
  need: `prompt/a/1/${PROMPT}`,
  prompt: { id: PROMPT, kind: 'approval', subject: 'command' },
  outcome: { type: 'choice', value: 'yes', hint: 'allow_once' },
});
const ASKED = AskSettlement.parse({ v: 1, ask: { questions: 2 }, outcome: { type: 'expired' } });

/** A record no party decided: corrallm ended it (an ask's deadline). */
function unsigned(fields: Partial<Message>): Message {
  const message = record(fields);
  delete message.by;
  return message;
}

describe('a settled record in the window', () => {
  it('is a typed entry under its record’s id, namespaced, with what it settled and who decided, never its words', () => {
    const entry = recordEntryFor(record(), HOLD);
    expect(entry).toEqual({
      id: 'record/11111111-2222-4333-8444-555555555555',
      kind: 'record',
      message: '11111111-2222-4333-8444-555555555555',
      need: 'hold/a/0a1b2c3d/ok',
      at: 1_700_000_000_000,
      by: 'you',
      state: 'settled',
      record: { type: 'hold', choice: 'approve' },
    });
    expect(entry.id).toBe(recordEntryId(entry.message));
    expect(JSON.stringify(entry)).not.toMatch(/private-/);
    // The wire takes it as a transcript entry.
    expect(TranscriptEntry.parse(entry)).toEqual(entry);
  });

  it('says a native decision corrallm was cut off answering is unresolved, typed and value-free', () => {
    const entry = recordEntryFor(
      record({
        state: 'unresolved',
        body: 'You allowed Builder’s command once: private-unresolved-words',
        settled: NATIVE,
      }),
      { v: 1, agent: 'a', need: NATIVE.need },
    );
    expect(entry).toMatchObject({
      state: 'unresolved',
      need: NATIVE.need,
      record: {
        type: 'prompt',
        prompt: { kind: 'approval', subject: 'command' },
        outcome: { type: 'choice', value: 'yes', hint: 'allow_once' },
      },
    });
    expect(JSON.stringify(entry)).not.toMatch(/private-|Builder/);
    expect(TranscriptEntry.parse(entry)).toEqual(entry);
  });

  it('says how an ask ended, and whose it was, counting its questions alone', () => {
    const entry = recordEntryFor(
      unsigned({
        to: 'agent:p',
        body: 'Your question private-ask-id expired',
        settled: ASKED,
      }),
      { v: 1, agent: 'b', need: 'ask/11111111-2222-4333-8444-555555555555' },
    );
    expect(entry).toMatchObject({
      state: 'settled',
      record: { type: 'ask', asker: 'agent:p', questions: 2, outcome: { type: 'expired' } },
    });
    expect(entry).not.toHaveProperty('by');
    expect(TranscriptEntry.parse(entry)).toEqual(entry);
  });

  it('shows a native decision no owner entry of this core’s shows: never one its owner made while it runs, any other once it took effect or a crash cut it off', () => {
    const about = { v: 1 as const, agent: 'a', need: NATIVE.need };
    // Its owner made it while this core runs: its owner entry shows it, settled in place, or open
    // again after its CLI refused it; and B13's cap dropping that entry brings back nothing.
    for (const state of ['delivering', 'delivered', 'withdrawn', 'unresolved'] as const)
      expect(shownRecord(record({ state, settled: NATIVE }), about, true), state).toBe(false);
    // Kept from before (a restart, its canvas opened again): no owner entry is left to show it.
    for (const state of ['delivered', 'unresolved'] as const)
      expect(shownRecord(record({ state, settled: NATIVE }), about), state).toBe(true);
    // One that changed nothing is no way its prompt ended; one being made is no record yet.
    for (const state of ['delivering', 'withdrawn'] as const)
      expect(shownRecord(record({ state, settled: NATIVE }), about), state).toBe(false);
    expect(recordEntryFor(record({ settled: NATIVE }), about).state).toBe('settled');
    expect(recordWords(recordEntryFor(record({ settled: NATIVE }), about), (party) => party)).toBe(
      'Allowed once by you.',
    );
    // A hold's decision, made in the write that kept it; an ask's end, whatever its asker is sent.
    expect(shownRecord(record(), HOLD)).toBe(true);
    for (const state of ['pending', 'delivered', 'replied', 'withdrawn'] as const)
      expect(shownRecord(record({ state, settled: ASKED }), about), state).toBe(true);
    // Nothing without the core's association; nothing but a record.
    expect(shownRecord(record(), undefined)).toBe(false);
    expect(shownRecord(record({ kind: 'text' }), HOLD)).toBe(false);
    expect(shownRecord(record({ kind: 'notice' }), HOLD)).toBe(false);
  });

  it('is yours alone: one selector gives you the window, in its order, and a token none', () => {
    const rows = ['1', '2', '3'].map((n) => ({
      message: record({ id: `11111111-2222-4333-8444-55555555555${n}` }),
      about: HOLD,
    }));
    const yours = recordsFor(rows, 'you');
    expect(yours.map(({ message }) => message)).toEqual(rows.map(({ message }) => message.id));
    expect(recordsFor(rows, 'token')).toEqual([]);
    expect(MAX_RECORD_ENTRIES).toBe(100);
  });

  it('is worded in the core’s words, never as applied where corrallm can’t tell', () => {
    const name = (party: string) =>
      party === 'you' ? 'you' : party === 'agent:p' ? 'Planner' : party;
    expect(recordWords(recordEntryFor(record(), HOLD), name)).toBe('Approved by you.');
    expect(
      recordWords(
        recordEntryFor(record(), { ...HOLD, hold: { choice: 'retry', words: true } }),
        name,
      ),
    ).toBe('Retried by you, with words.');
    const cut = recordEntryFor(record({ state: 'unresolved', settled: NATIVE }), {
      v: 1,
      agent: 'a',
      need: NATIVE.need,
    });
    expect(recordWords(cut, name)).toBe(`Allowed once by you, but ${UNRESOLVED_ANSWER}`);
    const asked = recordEntryFor(record({ to: 'agent:p', settled: ASKED }), {
      v: 1,
      agent: 'b',
      need: 'ask/x',
    });
    expect(recordWords(asked, name)).toBe('Planner’s question expired unanswered.');
  });
});

describe('a run hold’s record', () => {
  const name = (party: string) => (party === 'you' ? 'you' : party);
  const words = (hold: RecordAbout['hold']) =>
    recordWords(
      recordEntryFor(record(), {
        v: 1,
        agent: HOLD.agent,
        need: HOLD.need,
        ...(hold === undefined ? {} : { hold }),
      }),
      name,
    );

  it('says what each of the run’s fixed choices did, by its key, in the core’s fixed words', () => {
    expect(
      Object.fromEntries(
        [
          'approve',
          'stop',
          'more',
          'goOn',
          'retry',
          'yes',
          'no',
          'wait',
          'resolve',
          'continue',
          'skip',
          'switch',
        ].map((choice) => [choice, words({ choice })]),
      ),
    ).toEqual({
      approve: 'Approved by you.',
      stop: 'Stopped here by you.',
      more: 'Given one more round by you.',
      goOn: 'Told to go on by you.',
      retry: 'Retried by you.',
      yes: 'Judged to hold by you.',
      no: 'Judged not to hold by you.',
      wait: 'Told to wait for the reset by you.',
      resolve: 'Marked resolved by you.',
      continue: 'Continued by you.',
      skip: 'Skipped by you.',
      switch: 'Switched by you.',
    });
  });

  it('says words went with it, never which, and answers a key it doesn’t know in general words', () => {
    expect(words({ words: true })).toBe('Changes asked for by you.');
    expect(words({ choice: 'more', words: true })).toBe('Given one more round by you, with words.');
    expect(words({ choice: 'somethingNew' })).toBe('Answered by you.');
    expect(words(undefined)).toBe('Answered by you.');
  });
});

describe('an ask’s record', () => {
  it('is settled whatever became of its own row: the ask ended, as its words say', () => {
    // Its asker's turn of it was cut off by a restart: the ask had ended all the same.
    const entry = recordEntryFor(record({ to: 'agent:p', state: 'unresolved', settled: ASKED }), {
      v: 1,
      agent: 'b',
      need: 'ask/x',
    });
    expect(entry.state).toBe('settled');
    expect(recordWords(entry, (party) => (party === 'agent:p' ? 'Planner' : party))).toBe(
      'Planner’s question expired unanswered.',
    );
    // So is a hold's: decided in the write that kept it.
    expect(recordEntryFor(record({ state: 'unresolved' }), HOLD).state).toBe('settled');
  });
});

describe('a record’s association', () => {
  it('names an agent and what it settled, and a hold’s choice by its key alone: never words, a title or a label', () => {
    expect(RecordAbout.safeParse(HOLD).success).toBe(true);
    expect(RecordAbout.safeParse({ v: 1, agent: 'a', need: 'ask/x' }).success).toBe(true);
    for (const wrong of [
      { ...HOLD, title: 'Your OK on the spec?' },
      { ...HOLD, hold: { choice: 'approve', text: 'Make it shorter' } },
      { ...HOLD, hold: { choice: 'Approve the private plan, please' } },
      { v: 1, agent: 'a', need: 'ask/x', hold: { choice: 'approve' } },
      { v: 2, agent: 'a', need: HOLD.need },
      { v: 1, agent: '', need: HOLD.need },
    ])
      expect(RecordAbout.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });

  it('is never a session’s event or a native entry: only the core projects one, from its record', () => {
    expectTypeOf<Extract<SessionEvent['type'], 'settled' | 'record'>>().toBeNever();
    expectTypeOf<Extract<Entry['kind'], 'settled' | 'record'>>().toBeNever();
  });

  it('keeps an entry no reader can mistake for a native one', () => {
    const entry: RecordEntryView = recordEntryFor(record(), HOLD);
    expect(entry.kind).toBe('record');
    expect(entry.id.startsWith('record/')).toBe(true);
  });
});
