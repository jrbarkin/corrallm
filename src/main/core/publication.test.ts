import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentId, CanvasId } from '../../shared/api/ids';
import { SURFACE } from '../../shared/api/surface';
import { createDispatcher } from './call';
import type { OpContext, Projection, Publication, ReceiptTopic } from './call';
import { CALLERS, CANVAS, isLead, OTHER_CANVAS, RESOLVERS, testRegistry } from './test-registry';

/*
 * What core.call does for the topics (B11 §5): a write's receipts, once its change is published,
 * and a topic's projection, read under its reading op's audience and reach.
 */

const RUN: ReceiptTopic = `run:${CANVAS}`;
const MESSAGES: ReceiptTopic = `messages:${CANVAS}`;

/** A publication whose topics' revisions the test moves, saying what it was asked and when. */
function publication() {
  const said: string[] = [];
  let at = 0;
  const allocated = new Map<string, number>();
  const revs = new Map<string, number>();
  const pub: Publication = {
    mark: () => at,
    attribute: (topic, by) => {
      said.push(`attribute ${topic} ${by}`);
    },
    receipts: async (topics, since) => {
      said.push(`receipts ${topics.join(',')} since ${String(since)}`);
      await Promise.resolve();
      return Object.fromEntries(
        topics.flatMap((topic) =>
          (allocated.get(topic) ?? 0) > since ? [[topic, revs.get(topic) ?? 0]] : [],
        ),
      );
    },
  };
  return {
    pub,
    said,
    /** Publishes a change of `topic`: its next revision. */
    move: (topic: string) => {
      revs.set(topic, (revs.get(topic) ?? 0) + 1);
      allocated.set(topic, ++at);
    },
  };
}

function withOp(
  implementation: (args: { canvas: string; agent: string }, ctx: OpContext) => unknown,
  pub: Publication,
) {
  const registry = testRegistry();
  return createDispatcher(
    {
      ...registry,
      implementations: { ...registry.implementations, 'test.agent': implementation },
    },
    { isLead, resolvers: RESOLVERS, check: true, publication: pub },
  );
}

describe('a write’s publication receipts', () => {
  it('carries the revision of each topic the op said it changed, once that is published', async () => {
    const { pub, said, move } = publication();
    const core = withOp(async ({ agent }, ctx) => {
      move(RUN);
      ctx.published(RUN);
      said.push('changed');
      await Promise.resolve();
      said.push('returned');
      return { agent };
    }, pub);
    expect(await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you)).toEqual(
      { ok: true, value: { agent: 'helper', revs: { [RUN]: 1 } } },
    );
    // Asked after the op returned, from where publication was as it began.
    expect(said).toEqual([
      `attribute ${RUN} you`,
      'changed',
      'returned',
      `receipts ${RUN} since 0`,
    ]);
  });

  it('says nothing of a topic that didn’t move while the op ran: no bump for a no-op', async () => {
    const { pub, move } = publication();
    move(MESSAGES);
    const core = withOp(({ agent }, ctx) => {
      ctx.published(MESSAGES);
      ctx.published(RUN);
      move(RUN);
      return { agent };
    }, pub);
    expect(
      await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.lead),
    ).toEqual({ ok: true, value: { agent: 'helper', revs: { [RUN]: 1 } } });
  });

  it('asks for no receipt where no topic was said to change, and keeps a commit’s revision', async () => {
    const { pub, said } = publication();
    const core = withOp(({ agent }, ctx) => {
      ctx.reached(CANVAS, 4);
      return { agent };
    }, pub);
    expect(await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you)).toEqual(
      { ok: true, value: { agent: 'helper', revs: { [`canvas:${CANVAS}`]: 4 } } },
    );
    expect(said).toEqual([]);
  });

  it('gives a failed op no receipt', async () => {
    const { pub, said, move } = publication();
    const core = withOp((_args, ctx) => {
      move(RUN);
      ctx.published(RUN);
      throw new Error('It broke.');
    }, pub);
    expect(
      await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(said.filter((line) => line.startsWith('receipts'))).toEqual([]);
  });
});

describe('a topic’s projection', () => {
  const projection: Projection = {
    name: 'session.transcript',
    surface: SURFACE['session.transcript'],
    input: z.strictObject({ canvas: CanvasId, agent: AgentId }),
    read: ({ agent }: { agent: string }, { party }: { party: string }) => ({
      agent,
      party,
    }),
  };
  const core = createDispatcher(testRegistry(), { isLead, resolvers: RESOLVERS, check: true });

  it('is read under its reading op’s audience and reach, and its strict arguments', async () => {
    expect(
      await core.project(projection, { canvas: CANVAS, agent: 'worker' }, CALLERS.worker),
    ).toEqual({ ok: true, value: { agent: 'worker', party: 'worker' } });
    expect(
      await core.project(projection, { canvas: CANVAS, agent: 'stranger' }, CALLERS.you),
    ).toEqual({ ok: true, value: { agent: 'stranger', party: 'you' } });
    // A worker's transcript reach is its own; a lead's, its linked agents and team.
    expect(
      await core.project(projection, { canvas: CANVAS, agent: 'peer' }, CALLERS.worker),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(
      await core.project(projection, { canvas: CANVAS, agent: 'stranger' }, CALLERS.lead),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    // A canvas a token wasn't granted.
    expect(
      await core.project(
        projection,
        { canvas: OTHER_CANVAS, agent: 'peer' },
        CALLERS['outside-read'],
      ),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    for (const args of [
      { canvas: CANVAS },
      { canvas: CANVAS, agent: 'peer', more: true },
      { canvas: 'nope', agent: 'peer' },
    ])
      expect(await core.project(projection, args, CALLERS.you)).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
  });

  it('refuses a party outside its audience', async () => {
    const yours: Projection = {
      ...projection,
      name: 'test.yours',
      surface: { ...SURFACE['window.get'] },
    };
    expect(
      await core.project(yours, { canvas: CANVAS, agent: 'peer' }, CALLERS['outside-write']),
    ).toMatchObject({ ok: false, error: { code: 'human-only' } });
  });
});
