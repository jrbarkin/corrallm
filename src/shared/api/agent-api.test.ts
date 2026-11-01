import { describe, expect, it } from 'vitest';

import { AskInput, AskOutput, AskQuestions, CompleteInput, CompleteOutput } from './agent-api';
import { AttemptId, brandsIn, idsIn, NeedId, Target } from './ids';
import { OPS } from './registry';
import { SURFACE } from './surface';
import { MADE_UP } from '../test-made-up';
import { catalogOps } from './ops/catalog';
import {
  LOOP_TURNS,
  MAX_ASK_BYTES,
  MAX_ASK_QUESTIONS,
  MAX_ASK_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_OPEN_ASKS,
  MAX_SUMMARY_BYTES,
  MIN_ASK_SECONDS,
} from './limits';

const canvas = '00000000-0000-4000-8000-000000000001';
const attempt = '00000000-0000-4000-8000-000000000002';
const request = '00000000-0000-4000-8000-000000000003';
const question = {
  id: 'q',
  header: 'Direction',
  text: 'Which way?',
  options: [{ label: 'Left', description: 'Take the left path' }],
  multiple: false,
  other: true,
};
const ask = { canvas, to: 'worker', questions: [question] };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('prepared agent API contracts', () => {
  it('carries API routes as strict catalog metadata for an unfamiliar adapter', () => {
    for (const api of [null, 'http', 'channel']) {
      const catalog = structuredClone(MADE_UP);
      const connection = catalog.adapters[0]?.connections[0];
      if (!connection) throw new Error('The fixture needs a connection');
      Object.assign(connection, { api });
      expect(catalogOps['catalog.get'].output.parse(catalog)).toEqual(catalog);
      Object.assign(connection, { api: 'other' });
      expect(catalogOps['catalog.get'].output.safeParse(catalog).success).toBe(false);
    }
  });

  it('keeps the frozen budgets together', () => {
    expect({
      MAX_ASK_QUESTIONS,
      MAX_ASK_BYTES,
      MAX_OPEN_ASKS,
      MIN_ASK_SECONDS,
      MAX_ASK_SECONDS,
      MAX_SUMMARY_BYTES,
      LOOP_TURNS,
    }).toEqual({
      MAX_ASK_QUESTIONS: 4,
      MAX_ASK_BYTES: MAX_MESSAGE_BYTES,
      MAX_OPEN_ASKS: 256,
      MIN_ASK_SECONDS: 60,
      MAX_ASK_SECONDS: 86_400,
      MAX_SUMMARY_BYTES: 4096,
      LOOP_TURNS: 10,
    });
  });

  it('keeps strings as agent ids and reserves party addressing for strict objects', () => {
    for (const to of ['you', 'manager', 'worker']) {
      expect(Target.parse(to)).toBe(to);
      expect(idsIn(Target, to)).toEqual([{ brand: 'AgentId', id: to, path: '' }]);
    }
    for (const party of ['you', 'manager']) {
      const to = Target.parse({ party });
      expect(idsIn(Target, to)).toEqual([]);
    }
    for (const value of ['', null, [], { party: 'worker' }, { party: 'you', agent: 'worker' }])
      expect(Target.safeParse(value).success).toBe(false);
  });

  it('brands attempts as UUIDs independently of agent and native ids', () => {
    expect(AttemptId.parse(attempt)).toBe(attempt);
    expect(brandsIn(CompleteInput)).toContain('AttemptId');
    expect(
      idsIn(
        CompleteInput,
        CompleteInput.parse({ task: attempt, outcome: 'succeeded', summary: '' }),
      ),
    ).toEqual([{ brand: 'AttemptId', id: attempt, path: '.task' }]);
    for (const value of ['native-turn', '-thread', '', 1])
      expect(AttemptId.safeParse(value).success).toBe(false);
  });

  it.each(['message/id', 'ask/id', 'loop/first/second'])('admits the prepared NeedId %s', (id) => {
    expect(NeedId.parse(id)).toBe(id);
  });

  it('validates an ask and its request/revision envelope without registering operations', () => {
    const parsed = AskInput.parse({ ...ask, request });
    expect(parsed).toEqual({ ...ask, request, deadlineSeconds: 86_400 });
    expect(AskOutput.parse({ id: attempt, revs: {} })).toEqual({ id: attempt, revs: {} });
    expect(CompleteOutput.parse({ revs: {} })).toEqual({ revs: {} });
    for (const name of ['ask', 'complete']) {
      expect(Object.hasOwn(OPS, name)).toBe(false);
      expect(Object.hasOwn(SURFACE, name)).toBe(false);
    }
    expect(
      OPS.message.input.safeParse({ canvas, to: { party: 'you' }, body: 'Hello' }).success,
    ).toBe(false);
    expect(AskInput.safeParse({ ...ask, extra: true }).success).toBe(false);
    expect(
      CompleteInput.safeParse({ task: attempt, outcome: 'succeeded', summary: '', extra: true })
        .success,
    ).toBe(false);
    expect(AskOutput.safeParse({ id: attempt }).success).toBe(false);
    expect(CompleteOutput.safeParse({}).success).toBe(false);
  });

  it('takes one through four B13 questions, preserving picks and own words', () => {
    expect(AskQuestions.parse([question])).toEqual([question]);
    expect(AskQuestions.safeParse([{ ...question, options: [] }]).success).toBe(true);
    const four = Array.from({ length: 4 }, (_, i) => ({ ...question, id: String(i) }));
    expect(AskQuestions.safeParse(four).success).toBe(true);
    for (const questions of [
      [],
      [...four, { ...question, id: 'fifth' }],
      [question, question],
      [{ ...question, options: [{ label: 'Same' }, { label: 'Same' }] }],
      [{ ...question, options: [], other: false }],
    ])
      expect(AskQuestions.safeParse(questions).success).toBe(false);
  });

  it('accepts only non-secret questions without previews', () => {
    expect(AskQuestions.safeParse([{ ...question, secret: false }]).success).toBe(true);
    const secret = AskQuestions.safeParse([{ ...question, secret: true }]);
    expect(secret.success).toBe(false);
    if (!secret.success)
      expect(secret.error.issues.map((issue) => issue.message)).toContain(
        "Logins and secrets belong to the agent's CLI; ask without them.",
      );

    for (const one of [
      { ...question, secret: true },
      { ...question, preview: 'a file' },
      { ...question, options: [{ label: 'Left', preview: 'a file' }] },
    ])
      expect(AskQuestions.safeParse([one]).success).toBe(false);
  });

  it('bounds the complete normalized ask including its default and request id', () => {
    for (const char of ['x', '€', '\\']) {
      const base = AskInput.parse({ ...ask, request });
      const available = MAX_ASK_BYTES - bytes({ ...base, questions: [{ ...question, text: '' }] });
      const cost = bytes(char) - 2;
      const text = char.repeat(Math.floor(available / cost));
      const value = { ...ask, request, questions: [{ ...question, text }] };
      expect(AskInput.safeParse(value).success).toBe(true);
      expect(
        AskInput.safeParse({ ...value, questions: [{ ...question, text: text + char }] }).success,
      ).toBe(false);
    }
  });

  it.each([60, 86_400])('accepts deadline %s seconds', (deadlineSeconds) => {
    expect(AskInput.safeParse({ ...ask, deadlineSeconds }).success).toBe(true);
  });
  it.each([59, 86_401, 60.5, null])('refuses deadline %s', (deadlineSeconds) => {
    expect(AskInput.safeParse({ ...ask, deadlineSeconds }).success).toBe(false);
  });

  it('bounds completion summaries by UTF-8 without cutting or changing them', () => {
    for (const summary of ['', 'x'.repeat(4096), '€'.repeat(1365)]) {
      const value = { canvas, task: attempt, outcome: 'failed', summary, request };
      expect(CompleteInput.parse(value)).toEqual(value);
    }
    for (const summary of ['x'.repeat(4097), '€'.repeat(1366)])
      expect(CompleteInput.safeParse({ task: attempt, outcome: 'failed', summary }).success).toBe(
        false,
      );
    expect(
      CompleteInput.safeParse({ task: attempt, outcome: 'cancelled', summary: '' }).success,
    ).toBe(false);
  });
});
