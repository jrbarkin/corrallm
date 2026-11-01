import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PARTIES } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import type { Message } from '../../shared/model/messages';
import type { OutsideCaller } from './caller';
import { partyIdOf } from './caller';
import type { Core } from './core';
import { cursorOf } from './delivery/messages';
import { CALLERS, CANVAS, validFor } from './test-registry';
import { REAL_FIXTURES, startWorld } from './test-world';

/*
 * T3c (Core Server §3.7), its `wait` half: after each fixture's writes, an outside party's `wait`
 * returns only what is addressed to it, and exactly what `messages` lists as sent to it since the
 * same cursor. The half that checks each op's `reads` against its topic's projection comes with
 * the topics (B8).
 */

/** Another outside orchestrator on the canvas: the party the world's seeded "yours" came from. */
const OTHER: OutsideCaller = {
  kind: 'outside',
  token: 'other-token',
  name: 'other',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};
const OUTSIDERS = [
  CALLERS['outside-write'] as OutsideCaller,
  CALLERS['outside-read'] as OutsideCaller,
  OTHER,
];
/** Cursors at the start of the canvas's messages, for `messages` and for `wait`. */
const PAGED = cursorOf('messages', { [CANVAS]: 0 });
const WAITED = cursorOf('wait', { [CANVAS]: 0 });

describe('T3c: wait', () => {
  let world: { core: Core; close(): Promise<void> };

  beforeAll(async () => {
    world = await startWorld();
  });

  afterAll(async () => {
    await world.close();
  });

  /** What `caller` was sent since the start, as `messages` lists it. */
  async function sentTo(caller: OutsideCaller): Promise<Message[]> {
    const items: Message[] = [];
    let after = PAGED;
    for (;;) {
      const page = await world.core.call('messages', { canvas: CANVAS, after }, caller);
      if (!page.ok) throw new Error(page.error.sentence);
      if (page.value.items.length === 0) break;
      items.push(...(page.value.items as Message[]));
      after = page.value.next;
    }
    return items.filter((message) => message.to === partyIdOf(caller));
  }

  /** What `caller` waits through since the start, page by page. */
  async function waited(caller: OutsideCaller): Promise<Message[]> {
    const items: Message[] = [];
    let after = WAITED;
    for (;;) {
      const page = await world.core.call('wait', { after, timeoutSeconds: 0 }, caller);
      if (!page.ok) throw new Error(page.error.sentence);
      if (page.value.messages.length === 0) break;
      items.push(...(page.value.messages as Message[]));
      after = page.value.next;
    }
    return items;
  }

  it.each(Object.entries(REAL_FIXTURES))(
    'returns each outside party only what is addressed to it, after %s’s writes',
    async (name, fixture) => {
      const surface = world.core.surface[name];
      for (const party of PARTIES) {
        if (surface?.kind === 'read' || !surface?.access[party]) continue;
        for (const args of validFor(fixture, party)) {
          await world.core.call(name as OpName, args, CALLERS[party]);
        }
      }
      for (const caller of OUTSIDERS) {
        const got = await waited(caller);
        expect(got.every((message) => message.to === partyIdOf(caller))).toBe(true);
        expect(got).toEqual(await sentTo(caller));
      }
    },
    // A fixture may do real Git work (branch.merge: a merge, then its observation).
    30_000,
  );

  it('has something addressed to each party by the end, so that the check above meant something', async () => {
    for (const caller of OUTSIDERS) {
      expect(await waited(caller)).not.toEqual([]);
    }
  });
});
