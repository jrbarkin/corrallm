import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { define } from '../define';
import { brandsIn, idsIn } from '../ids';
import { OPS } from '../registry';
import { SURFACE } from '../surface';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES, MAX_MESSAGE_BYTES } from '../limits';
import { MAX_NODE_ID } from '../../model/canvas';
import { NEW_SESSION } from '../../model/session';
import { runView, sessionView } from '../../model/views';
import { AgentId } from '../ids';
import { MAX_FORM_FIELDS, MAX_QUESTIONS } from '../../session';
import { b11RunOps } from './run';
import { b11SessionOps } from './session';
import { b11ConversationOps, ReplyAnswer } from './conversation';

const canvas = '00000000-0000-4000-8000-000000000001';
const request = '00000000-0000-4000-8000-000000000002';
const agent = 'agent/with\nseparators';
const prepared = { ...b11RunOps, ...b11SessionOps, ...b11ConversationOps };
const valid = {
  'run.get': { canvas },
  'run.start': { canvas },
  'run.stop': { canvas },
  'run.resume': { canvas },
  'run.goOn': { canvas, agent, item: 'delay' },
  'session.open': { canvas, agent },
  'session.setMode': { canvas, agent, mode: 'mode' },
  'session.setModel': { canvas, agent, model: 'provider/model' },
  'session.setEffort': { canvas, agent, effort: null },
  'session.stopTask': { canvas, agent, task: 'native-task' },
  'session.restart': { canvas, agent },
  'session.newConversation': { canvas, agent },
  'session.conversations': { canvas, agent },
  'session.resumeConversation': { canvas, agent, conversation: 'native-thread' },
  'session.rewindPreview': { canvas, agent, message: 'native-message' },
  'session.rewind': { canvas, agent, message: 'native-message', restore: 'both' },
  'session.mcpServers': { canvas, agent },
  'session.changeMcpServer': { canvas, agent, server: 'reported-server', change: 'disable' },
  'session.options': { canvas, agent, adapter: 'adapter' },
  'session.continueIn': { canvas, agent, connection: 'adapter.terminal', then: { text: 'hello' } },
  message: { canvas, to: agent, body: 'hello' },
  reply: { canvas, to: 'hold/a/ok', answer: { choice: 'approve' } },
} satisfies Record<keyof typeof prepared, Record<string, unknown>>;

describe('prepared operation schemas, not registrations', () => {
  it.each(Object.keys(prepared) as (keyof typeof prepared)[])(
    '%s takes bounded branded input and refuses extra fields',
    (name) => {
      const input = prepared[name].input;
      const args = valid[name];
      const parsed = input.parse(args);
      expect(input.safeParse({ ...args, extra: true }).success).toBe(false);
      expect(input.safeParse({ ...args, canvas: 'not-a-canvas' }).success).toBe(false);
      if ('agent' in args)
        expect(input.safeParse({ ...args, agent: 'x'.repeat(MAX_NODE_ID + 1) }).success).toBe(
          false,
        );
      expect(idsIn(input, parsed).some((ref) => ref.brand === 'CanvasId')).toBe(true);
    },
  );

  it('uses the projected DTOs as read results without changing registered session.get', () => {
    const summary = sessionView(AgentId.parse(agent), 'adapter.terminal', NEW_SESSION).summary;
    expect(OPS['session.get'].output.parse(summary)).toEqual(summary);
    expect(b11RunOps['run.get'].output.parse(runView({ running: false, agents: {} }))).toEqual({
      running: false,
      agents: {},
      notices: [],
    });
  });

  it('envelopes a standalone definition without registering a name', () => {
    const def = define(
      { kind: 'command' },
      { summary: 'Prepared', input: z.strictObject({}), output: z.strictObject({}) },
    );
    expect(def.input.parse({ request })).toEqual({ request });
    expect(def.output.parse({ revs: {} })).toEqual({ revs: {} });
  });

  it('exports each new schema without adding an op or changing the registered reply', () => {
    const names = Object.keys({ ...b11RunOps, ...b11SessionOps });
    for (const name of names) {
      expect(name in OPS).toBe(false);
      expect(name in SURFACE).toBe(false);
    }
    expect(
      OPS.reply.input.safeParse({ canvas, to: 'prompt/a/q', answer: { answers: { q: 'yes' } } })
        .success,
    ).toBe(false);
    expect(
      b11ConversationOps.reply.input.safeParse({
        canvas,
        to: 'prompt/a/q',
        answer: { answers: { q: 'yes' } },
      }).success,
    ).toBe(true);
  });

  it('brands native and queue ids, rejects flags, and has no transforms hiding an id', () => {
    const def = b11SessionOps['session.rewind'];
    const args = def.input.parse({
      canvas,
      agent,
      message: 'native.message-1',
      restore: 'code',
      request,
    });
    expect(brandsIn(def.input)).toContain('EntryId');
    expect(idsIn(def.input, args).map((ref) => ref.id)).toContain('native.message-1');
    expect(def.input.safeParse({ ...args, message: '--help' }).success).toBe(false);
    expect(b11RunOps['run.goOn'].input.safeParse({ canvas, agent, item: 'delay' }).success).toBe(
      true,
    );
    expect(def.output.safeParse({ proposed: 'proposal/one' }).success).toBe(true);
  });

  it('bounds Continue input, checks image bytes/count, and rejects caller-supplied origin', () => {
    const input = b11SessionOps['session.continueIn'].input;
    const args = { canvas, agent, connection: 'adapter.terminal', then: { text: '!echo hi' } };
    expect(input.safeParse(args).success).toBe(true);
    expect(
      input.safeParse({ ...args, then: { text: 'é'.repeat(MAX_MESSAGE_BYTES) } }).success,
    ).toBe(false);
    expect(input.safeParse({ ...args, then: { text: 'hi', origin: 'manual' } }).success).toBe(
      false,
    );
    expect(
      input.safeParse({
        ...args,
        then: {
          text: 'hi',
          images: Array.from({ length: MAX_IMAGES + 1 }, () => ({
            mediaType: 'image/png',
            data: 'AAAA',
          })),
        },
      }).success,
    ).toBe(false);
    expect(
      input.safeParse({
        ...args,
        then: {
          text: 'hi',
          images: [
            { mediaType: 'image/png', data: 'A'.repeat(4 * Math.ceil((MAX_IMAGE_BYTES + 3) / 3)) },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('checks the aggregate image budget and the image encoding', () => {
    const input = b11SessionOps['session.continueIn'].input;
    const args = valid['session.continueIn'];
    const image = { mediaType: 'image/png', data: 'A'.repeat(4 * Math.floor(MAX_IMAGE_BYTES / 3)) };
    expect(input.safeParse({ ...args, then: { text: 'hi', images: [image] } }).success).toBe(true);
    expect(
      input.safeParse({
        ...args,
        then: {
          text: 'hi',
          images: Array.from(
            { length: Math.ceil(MAX_IMAGE_TOTAL / MAX_IMAGE_BYTES) + 1 },
            () => image,
          ),
        },
      }).success,
    ).toBe(false);
    for (const bad of [
      { ...image, data: '!!!!' },
      { ...image, mediaType: 'image/svg+xml' },
    ])
      expect(input.safeParse({ ...args, then: { text: 'hi', images: [bad] } }).success).toBe(false);
  });

  it('caps prompt collections and rejects native flags at every prepared entry point', () => {
    const fields = Object.fromEntries(
      Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => [`q${String(i)}`, 'yes']),
    );
    expect(ReplyAnswer.safeParse({ form: { action: 'accept', values: fields } }).success).toBe(
      false,
    );
    const questions = Object.fromEntries(
      Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${String(i)}`, 'yes']),
    );
    expect(ReplyAnswer.safeParse({ answers: questions }).success).toBe(false);
    for (const [name, field] of [
      ['session.stopTask', 'task'],
      ['session.resumeConversation', 'conversation'],
      ['session.rewindPreview', 'message'],
      ['session.rewind', 'message'],
    ] as const) {
      const input = prepared[name].input;
      expect(input.safeParse({ ...valid[name], [field]: '--help' }).success).toBe(false);
      expect(input.safeParse({ ...valid[name], [field]: 'x'.repeat(129) }).success).toBe(false);
    }
  });

  it.each([
    { choice: 'approve' },
    { choice: 'retry', text: 'try again', images: [{ mediaType: 'image/png', data: 'AAAA' }] },
    { text: 'changes' },
    { answers: { q1: 'one', q2: ['two', 'three'] } },
    { permission: 'deny', feedback: 'do this instead' },
    { plan: { approve: true, mode: 'manual' } },
    { plan: { approve: false, feedback: 'change it' } },
    {
      form: { action: 'accept', values: { text: 'hello', yes: true, number: 3, choices: ['one'] } },
    },
  ])('takes a strict typed answer %j', (answer) => {
    expect(ReplyAnswer.safeParse(answer).success).toBe(true);
  });

  it.each([
    { choice: 'approve', command: 'run me' },
    { answers: {} },
    { choice: 'x', permission: 'once' },
    { permission: 'once', feedback: 'no' },
    { form: { action: 'accept', values: { nested: { command: 'no' } } } },
    { text: 'x'.repeat(MAX_MESSAGE_BYTES + 1) },
  ])('refuses invalid/oversized answer %#', (answer) => {
    expect(ReplyAnswer.safeParse(answer).success).toBe(false);
  });
});
