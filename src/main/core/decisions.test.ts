import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { CanvasMemory } from '../memory';
import {
  decided,
  decidedOf,
  deciding,
  landed,
  recoverDecisions,
  withdrawnDecision,
} from './decisions';
import { MessageStore, MessageTable } from './delivery/messages';
import { openTestStore } from './store/test-store';
import type { Store } from './store/store';

/*
 * Who decided (decisions.ts): each decision a record in the canvas's messages, kept across a
 * restart; one cut off as it was being made is unresolved as the canvas's messages load again,
 * never made again.
 */

const CANVAS = '6e2d3c4b-5a6f-4b7c-9d8e-0f1a2b3c4d5e' as CanvasId;
const NEED = 'prompt/b/7/m1/permission';

let profile: string;
let database: Store;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-decisions-'));
  database = await openTestStore(profile);
});

afterEach(async () => {
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

/** The canvas's messages, loaded from the database as a core starting again loads them. */
async function messages(): Promise<MessageStore> {
  const store = new MessageStore(
    CANVAS,
    new MessageTable(database, new CanvasMemory(database)),
    () => 1000,
  );
  await store.load();
  return store;
}

async function restart(): Promise<MessageStore> {
  await database.close();
  database = await openTestStore(profile);
  return messages();
}

it('keeps who decided across a restart: the latest that took effect', async () => {
  const store = await messages();
  const refused = deciding(store, { need: NEED, by: 'you', words: 'You allowed it, once.' });
  withdrawnDecision(store, refused.id, 'Its CLI didn’t take this answer');
  const made = deciding(store, { need: NEED, by: 'you', words: 'You denied it.' });
  landed(store, made.id);
  decided(store, { need: 'hold/a/0a1b2c3d/ok', by: 'you', words: 'You answered it: Approve.' });
  await store.durable();
  const again = await restart();
  expect(decidedOf(again, NEED)).toMatchObject({
    id: made.id,
    by: 'you',
    to: 'you',
    from: 'corrallm',
    kind: 'settled',
    state: 'delivered',
    body: 'You denied it.',
  });
  expect(decidedOf(again, 'hold/a/0a1b2c3d/ok')?.body).toBe('You answered it: Approve.');
  expect(decidedOf(again, 'hold/a/0a1b2c3d/other')).toBeUndefined();
  expect(again.get(refused.id)).toMatchObject({
    state: 'withdrawn',
    body: 'Its CLI didn’t take this answer, so it changed nothing: You allowed it, once.',
  });
  expect(recoverDecisions(again)).toBe(false);
});

it('leaves a decision cut off as it was made unresolved, saying so, never made again', async () => {
  const store = await messages();
  const cut = deciding(store, { need: NEED, by: 'you', words: 'You allowed it, once.' });
  await store.durable();
  // The core stops before its CLI's answer is known.
  const again = await restart();
  expect(recoverDecisions(again)).toBe(true);
  await again.durable();
  const settled = await restart();
  expect(settled.get(cut.id)).toMatchObject({
    state: 'unresolved',
    by: 'you',
    body: expect.stringMatching(
      /^You allowed it, once: corrallm stopped as it was answering, so it may not have reached/,
    ) as string,
  });
  // Still who decided, as far as anyone can tell: a second answer is told of it.
  expect(decidedOf(settled, NEED)?.id).toBe(cut.id);
  expect(recoverDecisions(settled)).toBe(false);
});
