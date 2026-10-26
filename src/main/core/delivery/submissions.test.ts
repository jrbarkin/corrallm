import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_MESSAGE_BYTES, STORE_SETTLED_PER_PARTY } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { decodeSubmissions } from '../engine/delivery/submission-state';
import type { SubmittedMessage } from '../../../shared/model/queue';
import { CanvasMemory } from '../../memory';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { MessageStore, MessageTable } from './messages';
import { keepSubmissions, submissionsOf } from './submissions';

/*
 * Your manual submissions as the mailbox keeps them (B11 Design §4): each your message to its
 * agent, made once, matched to one that represents it already, and given back as the engine
 * restores them.
 */

const CANVAS = '0b8c6f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e' as CanvasId;
const DONE = { status: 'completed', reason: 'completed' } as const;

let profile: string;
let database: Store;
let messages: MessageStore;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-submissions-'));
  database = await openTestStore(profile);
  messages = new MessageStore(
    CANVAS,
    new MessageTable(database, new CanvasMemory(database)),
    () => 1000,
  );
  await messages.load();
});

afterEach(async () => {
  await messages.durable();
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

const keep = (agents: Record<string, SubmittedMessage[]>) => {
  keepSubmissions(messages, new Map(Object.entries(agents)), 5000);
};

describe('a run’s submissions, as your messages', () => {
  it('are made once, never again once pruned, though the engine still has them', async () => {
    const record: SubmittedMessage = {
      id: 'native-1',
      text: 'Mine',
      status: 'completed',
      result: DONE,
    };
    keep({ lead: [record] });
    const [made] = messages.all();
    expect(made).toMatchObject({ from: 'you', to: 'agent:lead', body: 'Mine', state: 'replied' });
    // Newer settled messages of yours to the agent push it out.
    for (let i = 0; i <= STORE_SETTLED_PER_PARTY; i++) {
      messages.add({
        from: 'you',
        to: 'agent:lead',
        kind: 'text',
        origin: 'manual',
        body: `Later ${String(i)}`,
        state: 'replied',
      });
    }
    await messages.durable();
    expect(messages.get(made?.id ?? '')).toBeUndefined();
    const count = messages.all().length;
    keep({ lead: [record] });
    expect(messages.all()).toHaveLength(count);
  });

  it('gives back only yours the session had: never a party’s, resent or not, nor one waiting', () => {
    messages.add({
      from: 'outside:orchestrator',
      to: 'agent:lead',
      kind: 'text',
      origin: 'resend',
      body: 'Theirs again',
      state: 'replied',
      delivery: { at: 1, as: 'party-1', attempt: 1 },
    });
    messages.add({
      from: 'you',
      to: 'agent:lead',
      kind: 'text',
      origin: 'manual',
      body: 'Waiting to go',
      state: 'pending',
      delivery: { at: 1, as: 'refused-1', attempt: 1 },
    });
    // Delivered by the core: its turn's end kept on its reply.
    const delivered = messages.add({
      from: 'you',
      to: 'agent:lead',
      kind: 'text',
      origin: 'manual',
      body: 'Delivered',
      state: 'replied',
      delivery: { at: 1, as: 'native-2', attempt: 1 },
    });
    messages.add({
      from: 'agent:lead',
      to: 'you',
      kind: 'text',
      origin: 'party',
      body: 'Its reply',
      replyTo: delivered.id,
      turn: { status: 'failed', reason: 'error' },
      state: 'delivered',
    });
    const going = messages.add({
      from: 'you',
      to: 'agent:lead',
      kind: 'text',
      origin: 'manual',
      body: 'Going on',
      state: 'delivered',
      delivery: { at: 1, as: 'native-3', attempt: 1 },
    });
    expect(decodeSubmissions(submissionsOf(messages))).toEqual(
      new Map([
        [
          'lead',
          [
            {
              id: 'native-2',
              text: 'Delivered',
              status: 'failed',
              result: { status: 'failed', reason: 'error' },
            },
            // Its turn going on as the core stopped: restored unresolved, never sent again.
            {
              id: going.delivery?.as,
              text: 'Going on',
              status: 'cancelled',
              unresolved: true,
              result: {
                status: 'cancelled',
                reason: 'interrupted',
                message: 'Unresolved after restart; resume the queue to continue.',
              },
            },
          ],
        ],
      ]),
    );
  });

  it('hold a long one within what a message holds, its whole text shown and given back', () => {
    const text = 'é'.repeat(MAX_MESSAGE_BYTES);
    const record: SubmittedMessage = { id: 'native-1', text, status: 'running', after: 'plan' };
    keep({ lead: [record] });
    const [made] = messages.all();
    expect(Buffer.byteLength(made?.body ?? '')).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(text.startsWith(made?.body.slice(0, 100) ?? '-')).toBe(true);
    expect(messages.displayOf(made?.id ?? '')).toEqual({ after: 'plan', text });
    // As its turn ends, it keeps what it shows.
    keep({ lead: [{ ...record, status: 'completed', result: DONE }] });
    expect(messages.get(made?.id ?? '')).toMatchObject({ state: 'replied' });
    expect(messages.displayOf(made?.id ?? '')).toEqual({ after: 'plan', text });
    expect(decodeSubmissions(submissionsOf(messages)).get('lead')).toEqual([
      { id: 'native-1', text, status: 'completed', after: 'plan', result: DONE },
    ]);
  });

  it('keep a message that represents one already as it is, gaining only where it showed', () => {
    const delivered = messages.add({
      from: 'you',
      to: 'agent:lead',
      kind: 'text',
      origin: 'manual',
      body: 'Yours',
      state: 'delivered',
      delivery: { at: 1, as: 'native-1', attempt: 1 },
    });
    // Another agent's under the same native id represents only that agent's.
    messages.add({
      from: 'you',
      to: 'agent:helper',
      kind: 'text',
      origin: 'manual',
      body: 'Helper’s',
      state: 'replied',
      delivery: { at: 1, as: 'native-2', attempt: 1 },
    });
    keep({
      lead: [
        { id: 'native-1', text: 'Yours', status: 'completed', after: 'plan', result: DONE },
        { id: 'native-2', text: 'Lead’s', status: 'completed', result: DONE },
      ],
    });
    expect(messages.get(delivered.id)).toEqual(delivered);
    expect(messages.displayOf(delivered.id)).toEqual({ after: 'plan' });
    expect(messages.all().map(({ to, body }) => [to, body])).toEqual([
      ['agent:lead', 'Yours'],
      ['agent:helper', 'Helper’s'],
      ['agent:lead', 'Lead’s'],
    ]);
  });
});
