import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TOKEN_IN_FLIGHT, TOKEN_WRITES_PER_SECOND } from '../../shared/api/limits';
import { createDispatcher, OpFailure, scopeOf } from './call';
import type { DispatchOptions } from './call';
import { asHuman, partyOf } from './caller';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { REMEMBERED_REQUESTS } from './requests';
import {
  CALLERS,
  CANVAS,
  isLead,
  OTHER_CANVAS,
  pipedRegistry,
  PROPOSAL,
  RESOLVERS,
  testRegistry,
} from './test-registry';

const REQUEST = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

function setup(options: DispatchOptions = {}) {
  const registry = testRegistry();
  const core = createDispatcher(registry, {
    isLead,
    resolvers: RESOLVERS,
    check: true,
    ...options,
  });
  return { core, calls: registry.calls, registry };
}

const message = (more: object = {}) => ({ canvas: CANVAS, to: 'peer', body: 'hello', ...more });

describe('partyOf', () => {
  it('makes you of a human caller only, and reads lead status on every call', () => {
    expect(partyOf(asHuman(3))).toBe('you');
    expect(partyOf(asHuman('host'))).toBe('you');
    const lead = CALLERS.lead as AgentCaller;
    expect(partyOf(lead)).toBe('worker');
    let leads = true;
    const now = () => leads;
    expect(partyOf(lead, now)).toBe('lead');
    leads = false;
    expect(partyOf(lead, now)).toBe('worker');
    expect(partyOf(CALLERS['outside-read'])).toBe('outside-read');
    expect(partyOf(CALLERS['outside-write'])).toBe('outside-write');
  });
});

describe('scopeOf', () => {
  it('runs an op aimed at a group in its canvas’s scope, which holds every member’s', () => {
    const agentScoped = { scope: 'agent' } as const;
    expect(scopeOf(agentScoped, { canvas: CANVAS, target: { group: 'team' } })).toEqual([
      'app',
      CANVAS,
    ]);
    expect(scopeOf(agentScoped, { canvas: CANVAS, target: { agent: 'helper' } })).toEqual([
      'app',
      CANVAS,
      'helper',
    ]);
    expect(scopeOf(agentScoped, { canvas: CANVAS, to: 'helper' })).toEqual([
      'app',
      CANVAS,
      'helper',
    ]);
  });
});

describe('core.call', () => {
  it('answers with the op’s result, as a value', async () => {
    const { core } = setup();
    expect(await core.call('test.read', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { caller: 'you', same: 1 },
    });
    // No arguments are an empty object.
    expect(await core.call('test.read', undefined, CALLERS.worker)).toEqual({
      ok: true,
      value: { caller: 'worker', same: 1 },
    });
  });

  it('checks the audience on every call: human-only for an op yours alone, else forbidden', async () => {
    const { core, calls } = setup();
    for (const party of ['lead', 'worker', 'outside-read', 'outside-write'] as const) {
      expect(await core.call('test.yours', {}, CALLERS[party])).toEqual({
        ok: false,
        error: { code: 'human-only', sentence: expect.stringContaining('test.yours') as unknown },
      });
    }
    expect(
      await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.worker),
    ).toEqual({
      ok: false,
      error: { code: 'forbidden', sentence: expect.stringContaining('test.agent') as unknown },
    });
    expect(calls['test.yours']).toEqual([]);
    expect(calls['test.agent']).toEqual([]);
    expect((await core.call('test.yours', {}, CALLERS.you)).ok).toBe(true);
  });

  it('refuses you an op only tokens may call', async () => {
    const { core, calls } = setup();
    expect(await core.call('test.tokens', {}, CALLERS.you)).toEqual({
      ok: false,
      error: { code: 'forbidden', sentence: 'You can’t call test.tokens.' },
    });
    expect(calls['test.tokens']).toEqual([]);
    expect((await core.call('test.tokens', {}, CALLERS['outside-read'])).ok).toBe(true);
  });

  it('refuses an op that doesn’t exist, or isn’t its own', async () => {
    const { core } = setup();
    for (const name of ['test.missing', 'toString', '__proto__']) {
      expect(await core.call(name, {}, CALLERS.you)).toEqual({
        ok: false,
        error: { code: 'not-found', sentence: `There is no operation named ${name}.` },
      });
    }
  });

  it('refuses arguments that don’t fit, saying where', async () => {
    const { core, calls } = setup();
    const result = await core.call('test.message', message({ body: 'x'.repeat(101) }), CALLERS.you);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid',
        sentence: expect.stringMatching(/^Invalid arguments \(body\): /) as unknown,
      },
    });
    expect(await core.call('test.read', { extra: 1 }, CALLERS.you)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(await core.call('test.read', 'text', CALLERS.you)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(calls['test.message']).toEqual([]);
  });

  it('resolves every id a token names against its reach: not-found when out of it', async () => {
    const { core, calls } = setup();
    // The lead reaches its team, never a worker outside it, for a write.
    expect(
      await core.call('test.agent', { canvas: CANVAS, agent: 'worker' }, CALLERS.lead),
    ).toEqual({
      ok: false,
      error: { code: 'not-found', sentence: 'There is no agent worker (at agent).' },
    });
    // Nor an agent that isn’t there, the same way.
    expect(await core.call('test.agent', { canvas: CANVAS, agent: 'ghost' }, CALLERS.lead)).toEqual(
      {
        ok: false,
        error: { code: 'not-found', sentence: 'There is no agent ghost (at agent).' },
      },
    );
    // A worker reaches only the agents linked to it.
    expect((await core.call('test.message', message({ to: 'stranger' }), CALLERS.worker)).ok).toBe(
      false,
    );
    // An outside token, only its canvases.
    expect(
      await core.call(
        'test.message',
        message({ canvas: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99' }),
        CALLERS['outside-write'],
      ),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(calls['test.agent']).toEqual([]);
    expect(calls['test.message']).toEqual([]);
    expect(
      (await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.lead)).ok,
    ).toBe(true);
    // You reach everything; whether it exists is the op’s to say.
    expect(
      (await core.call('test.agent', { canvas: CANVAS, agent: 'ghost' }, CALLERS.you)).ok,
    ).toBe(true);
  });

  it('fills in the canvas for a caller with exactly one, and asks one with several to name it', async () => {
    const both = [CANVAS, OTHER_CANVAS];
    const { core, calls } = setup({ openCanvases: () => both });
    const outside: OutsideCaller = {
      ...(CALLERS['outside-write'] as OutsideCaller),
      canvases: both,
    };
    for (const caller of [CALLERS.you, outside]) {
      // However the rest reads, and whatever it names: nothing out of reach is told.
      for (const agent of ['helper', 'ghost']) {
        expect(await core.call('test.agent', { agent }, caller)).toEqual({
          ok: false,
          error: {
            code: 'invalid',
            sentence: `Name the canvas: there is more than one to choose from (${both.join(', ')}).`,
          },
        });
      }
    }
    expect(calls['test.agent']).toEqual([]);
    // With one, it is filled in.
    expect(await core.call('test.agent', { agent: 'helper' }, CALLERS['outside-write'])).toEqual({
      ok: true,
      value: { agent: 'helper' },
    });
    expect(
      (
        await setup({ openCanvases: () => [CANVAS] }).core.call(
          'test.agent',
          { agent: 'helper' },
          CALLERS.you,
        )
      ).ok,
    ).toBe(true);
  });

  it('resolves an id behind a preprocess as the op gets it, for reach and self', async () => {
    const core = createDispatcher(
      pipedRegistry((agent) => z.preprocess(trim, agent)),
      { isLead, resolvers: RESOLVERS },
    );
    const piped = (to: string) => ({ canvas: CANVAS, to });
    expect(await core.call('test.piped', piped(' stranger '), CALLERS.worker)).toEqual({
      ok: false,
      error: { code: 'not-found', sentence: 'There is no agent stranger (at to).' },
    });
    expect(await core.call('test.piped', piped(' worker '), CALLERS.worker)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'An agent can’t call test.piped on itself.' },
    });
    expect(await core.call('test.piped', piped(' peer '), CALLERS.worker)).toEqual({
      ok: true,
      value: { sent: 'peer' },
    });
  });

  it('finds nothing in reach behind a pipe that may change an id once it is checked', async () => {
    const registry = pipedRegistry((agent) => agent.transform((id) => id.toLowerCase()));
    const core = createDispatcher(registry, { isLead, resolvers: RESOLVERS });
    const called = vi.spyOn(registry.implementations, 'test.piped');
    expect(await core.call('test.piped', { canvas: CANVAS, to: 'PEER' }, CALLERS.worker)).toEqual({
      ok: false,
      error: {
        code: 'not-found',
        sentence: 'There is nothing in reach at to: its schema hides which id it names.',
      },
    });
    expect(called).not.toHaveBeenCalled();
    // You reach everything.
    expect(await core.call('test.piped', { canvas: CANVAS, to: 'PEER' }, CALLERS.you)).toEqual({
      ok: true,
      value: { sent: 'peer' },
    });
  });

  it('finds nothing a token names in reach where the core resolves no such id', async () => {
    const { core } = setup({ resolvers: {} });
    expect(await core.call('test.message', message(), CALLERS['outside-write'])).toMatchObject({
      ok: false,
      error: { code: 'not-found', sentence: `There is no canvas ${CANVAS} (at canvas).` },
    });
  });

  it('refuses an agent aiming an op declared self: refused at itself', async () => {
    const { core, calls } = setup();
    expect(await core.call('test.message', message({ to: 'worker' }), CALLERS.worker)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'An agent can’t call test.message on itself.' },
    });
    expect(calls['test.message']).toEqual([]);
  });

  it('refuses a token’s call that meets a rule, and never yours', async () => {
    const { core, calls } = setup();
    expect(await core.call('test.message', message({ body: '!ls' }), CALLERS.worker)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'Only what you typed may run a shell command.' },
    });
    expect(calls['test.message']).toEqual([]);
    expect(await core.call('test.message', message({ body: '!ls' }), CALLERS.you)).toEqual({
      ok: true,
      value: { sent: 'peer' },
    });
  });

  it('makes a token’s call that meets R4 a proposal, applying nothing', async () => {
    const { core, calls } = setup();
    const args = { canvas: CANVAS, agent: 'stranger' };
    expect(await core.call('test.delete', args, CALLERS['outside-write'])).toEqual({
      ok: true,
      value: { proposed: PROPOSAL },
    });
    expect(calls['test.delete']).toEqual([]);
    expect(await core.call('test.delete', args, CALLERS.you)).toEqual({
      ok: true,
      value: { deleted: 'stranger' },
    });
  });

  it('returns a repeated request’s first result, once per caller', async () => {
    const { core, calls } = setup();
    const first = await core.call('test.message', message({ request: REQUEST }), CALLERS.worker);
    const again = await core.call('test.message', message({ request: REQUEST }), CALLERS.worker);
    expect(again).toEqual(first);
    expect(calls['test.message']).toHaveLength(1);
    // Another caller's request of the same id is its own.
    await core.call('test.message', message({ request: REQUEST }), CALLERS.lead);
    expect(calls['test.message']).toHaveLength(2);
    // Two at once share the one call.
    const both = await Promise.all([
      core.call('test.agent', { canvas: CANVAS, agent: 'helper', request: REQUEST }, CALLERS.you),
      core.call('test.agent', { canvas: CANVAS, agent: 'helper', request: REQUEST }, CALLERS.you),
    ]);
    expect(both[0]).toEqual(both[1]);
    expect(calls['test.agent']).toHaveLength(1);
  });

  it('runs a request again whose first call was cancelled, once that call has unwound', async () => {
    const { core, registry } = setup();
    const args = { canvas: CANVAS, agent: 'helper', request: REQUEST };
    const unwound = Promise.withResolvers<undefined>();
    let runs = 0;
    // An op that, aborted, takes a while to unwind, applying nothing.
    registry.implementations['test.agent'] = async (_args, { signal }) => {
      runs++;
      if (runs > 1) return { agent: 'helper' };
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
      await unwound.promise;
      throw signal.reason as Error;
    };
    const caller = new AbortController();
    const first = core.call('test.agent', args, CALLERS['outside-write'], caller.signal);
    await vi.waitFor(() => {
      expect(runs).toBe(1);
    });
    // The client's connection drops, and it retries at once.
    caller.abort(new Error('The connection closed.'));
    const retry = core.call('test.agent', args, CALLERS['outside-write']);
    await Promise.resolve();
    expect(runs).toBe(1);
    unwound.resolve(undefined);
    expect(await first).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'The call was cancelled.' },
    });
    expect(await retry).toEqual({ ok: true, value: { agent: 'helper' } });
    expect(runs).toBe(2);
    // The retry's result is the one kept.
    expect(await core.call('test.agent', args, CALLERS['outside-write'])).toEqual({
      ok: true,
      value: { agent: 'helper' },
    });
    expect(runs).toBe(2);
  });

  it('keeps a request’s result only when its op came to it by itself', async () => {
    const { core, registry } = setup();
    const outcomes: (() => unknown)[] = [];
    registry.implementations['test.agent'] = async (_args, { signal }) => {
      const outcome = outcomes.shift();
      if (outcome) return outcome();
      // Held until stopped, then failing as an op that unwinds does.
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
      throw new OpFailure('refused', 'Stopped before it began.');
    };
    const call = (request: string) =>
      core.call('test.agent', { canvas: CANVAS, agent: 'helper', request }, CALLERS.you);
    const runsOf = async (request: string, outcome: () => unknown) => {
      outcomes.push(outcome, () => ({ agent: 'again' }));
      const first = await call(request);
      const again = await call(request);
      outcomes.length = 0;
      return { first, again };
    };
    // A failure it came to by itself is its result.
    const conflict = await runsOf(crypto.randomUUID(), () => {
      throw new OpFailure('conflict', 'Someone else got there first.');
    });
    expect(conflict.again).toEqual(conflict.first);
    // A failure nobody expected is run again.
    const broken = await runsOf(crypto.randomUUID(), () => {
      throw new Error('The disk is full.');
    });
    expect(broken.first).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(broken.again).toEqual({ ok: true, value: { agent: 'again' } });
    // So is one a preempting op stopped, whatever it threw as it unwound.
    const stopped = crypto.randomUUID();
    const holding = call(stopped);
    await vi.waitFor(async () => {
      expect(
        (await core.call('test.stop', { canvas: CANVAS, agent: 'helper' }, CALLERS.you)).ok,
      ).toBe(true);
      expect(await holding).toEqual({
        ok: false,
        error: { code: 'refused', sentence: 'Stopped before it began.' },
      });
    });
    outcomes.push(() => ({ agent: 'again' }));
    expect(await call(stopped)).toEqual({ ok: true, value: { agent: 'again' } });
  });

  it('keeps each caller’s recent requests apart, so none pushes out another’s', async () => {
    const { core, calls } = setup();
    await core.call('test.message', message({ request: REQUEST }), CALLERS.worker);
    const flood = Array.from({ length: REMEMBERED_REQUESTS + 1 }, () => crypto.randomUUID());
    for (const request of flood) {
      await core.call('test.agent', { canvas: CANVAS, agent: 'helper', request }, CALLERS.you);
    }
    expect(calls['test.agent']).toHaveLength(flood.length);
    await core.call('test.message', message({ request: REQUEST }), CALLERS.worker);
    expect(calls['test.message']).toHaveLength(1);
    // The caller's own oldest request is forgotten: a repeat of it runs again.
    await core.call(
      'test.agent',
      { canvas: CANVAS, agent: 'helper', request: flood[0] },
      CALLERS.you,
    );
    expect(calls['test.agent']).toHaveLength(flood.length + 1);
  });

  it('limits a token’s calls in flight', async () => {
    const { core } = setup();
    const caller = CALLERS['outside-write'];
    const holding = Array.from({ length: TOKEN_IN_FLIGHT }, (_, i) => {
      const controller = new AbortController();
      const agent = ['lead', 'helper', 'worker', 'peer', 'stranger'][i % 5] ?? 'lead';
      return {
        controller,
        result: core.call('test.hold', { canvas: CANVAS, agent }, caller, controller.signal),
      };
    });
    await vi.waitFor(() => {
      expect(holding).toHaveLength(TOKEN_IN_FLIGHT);
    });
    expect(await core.call('test.read', {}, caller)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'Too many calls; slow down.' },
    });
    // Another token, and you, are not held up.
    expect((await core.call('test.read', {}, CALLERS['outside-read'])).ok).toBe(true);
    expect((await core.call('test.read', {}, CALLERS.you)).ok).toBe(true);
    for (const { controller } of holding) controller.abort(new Error('done'));
    await Promise.all(holding.map(({ result }) => result));
    expect((await core.call('test.read', {}, caller)).ok).toBe(true);
  });

  it('limits a token’s writes a second, never its reads, and never yours', async () => {
    let now = 1000;
    const { core } = setup({ now: () => now });
    const caller = CALLERS['outside-write'];
    for (let i = 0; i < TOKEN_WRITES_PER_SECOND; i++) {
      expect((await core.call('test.message', message(), caller)).ok).toBe(true);
    }
    expect(await core.call('test.message', message(), caller)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'Too many calls; slow down.' },
    });
    expect((await core.call('test.read', {}, caller)).ok).toBe(true);
    for (let i = 0; i <= TOKEN_WRITES_PER_SECOND; i++) {
      expect((await core.call('test.message', message(), CALLERS.you)).ok).toBe(true);
    }
    now += 1000;
    expect((await core.call('test.message', message(), caller)).ok).toBe(true);
  });

  it('turns what an op throws into an error value, never throwing itself', async () => {
    const { core, registry } = setup();
    registry.implementations['test.read'] = () => {
      throw new OpFailure('conflict', 'Someone else got there first.');
    };
    expect(await core.call('test.read', {}, CALLERS.you)).toEqual({
      ok: false,
      error: { code: 'conflict', sentence: 'Someone else got there first.' },
    });
    registry.implementations['test.read'] = () => Promise.reject(new Error('The disk is full.'));
    expect(await core.call('test.read', {}, CALLERS.you)).toEqual({
      ok: false,
      error: { code: 'unavailable', sentence: 'The disk is full.' },
    });
  });

  it('lets a preempting op stop what holds its scope', async () => {
    const { core } = setup();
    const args = { canvas: CANVAS, agent: 'helper' };
    const holding = core.call('test.hold', args, CALLERS.you);
    await vi.waitFor(async () => {
      expect(await core.call('test.stop', args, CALLERS.you)).toEqual({
        ok: true,
        value: { stopped: true },
      });
    });
    expect(await holding).toEqual({ ok: true, value: { stopped: true } });
  });

  it('checks that arguments and results are plain data, and results fit their schema', async () => {
    const { core, registry } = setup();
    expect(await core.call('test.read', { hello: () => 1 }, CALLERS.you)).toEqual({
      ok: false,
      error: { code: 'invalid', sentence: 'args.hello is a function, not plain data.' },
    });
    class Party {
      readonly name = 'you';
    }
    registry.implementations['test.read'] = () => ({ caller: new Party(), same: 1 });
    expect(await core.call('test.read', {}, CALLERS.you)).toEqual({
      ok: false,
      error: { code: 'unavailable', sentence: 'result.caller is a Party, not plain data.' },
    });
    registry.implementations['test.read'] = () => ({ caller: 'you' });
    expect(await core.call('test.read', {}, CALLERS.you)).toMatchObject({
      ok: false,
      error: {
        code: 'unavailable',
        sentence: expect.stringMatching(/^The result doesn’t fit/) as unknown,
      },
    });
    // Unchecked (production), what the op returns goes as it is.
    const unchecked = createDispatcher(registry, { check: false });
    expect(await unchecked.call('test.read', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { caller: 'you' },
    });
  });

  it('reads a caller’s party on every call', async () => {
    let leads = true;
    const { core } = setup({ isLead: () => leads });
    const helper: Caller = { kind: 'agent', canvas: CANVAS, agent: 'lead', session: 's' };
    expect((await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, helper)).ok).toBe(
      true,
    );
    leads = false;
    expect(
      await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, helper),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });
});
