import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TOKEN_IN_FLIGHT, TOKEN_WRITES_PER_SECOND } from '../../shared/api/limits';
import { withEnvelope } from '../../shared/api/define';
import { createDispatcher, drainsOf, OpFailure, scopeOf } from './call';
import type { DispatchOptions, OpContext } from './call';
import type { Committer } from './canvas/commit';
import { CommitFailed } from './canvas/documents';
import { partyOf } from './caller';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { asHuman } from './gui';
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

describe('drainsOf', () => {
  it('drains every scope beneath a canvas’s, or those of the agents an op removes or switches', () => {
    expect(
      drainsOf({ scope: 'canvas', drains: 'canvas' }, { canvas: CANVAS, discard: true }),
    ).toEqual([['app', CANVAS]]);
    expect(
      drainsOf({ scope: 'canvas', drains: 'agents' }, { canvas: CANVAS, agent: 'helper' }),
    ).toEqual([['app', CANVAS, 'helper']]);
    expect(
      drainsOf(
        { scope: 'canvas', drains: 'agents' },
        { canvas: CANVAS, nodes: ['helper', 'team'], links: [] },
      ),
    ).toEqual([
      ['app', CANVAS, 'helper'],
      ['app', CANVAS, 'team'],
    ]);
    expect(drainsOf({ scope: 'canvas' }, { canvas: CANVAS, agent: 'helper' })).toEqual([]);
  });

  it('drains, for an op in the app’s scope, the canvas it replaces, and none when it replaces none', () => {
    const create = { scope: 'app', drains: 'canvas' } as const;
    expect(drainsOf(create, { replace: { canvas: CANVAS, discard: true } })).toEqual([
      ['app', CANVAS],
    ]);
    expect(drainsOf(create, { template: { id: 'review-loop' } })).toEqual([]);
  });
});

describe('core.call', () => {
  it('lets a draining op stop what holds an agent’s scope on its canvas, then run', async () => {
    const registry = testRegistry();
    const surface = {
      access: { you: 'all' },
      kind: 'command',
      scope: 'canvas',
      drains: 'canvas',
    } as const;
    const core = createDispatcher(
      {
        ...registry,
        surface: { ...registry.surface, 'test.close': surface },
        ops: {
          ...registry.ops,
          'test.close': withEnvelope(surface, {
            summary: 'Closes a canvas.',
            input: z.strictObject({ canvas: z.uuid() }),
            output: z.strictObject({ closed: z.boolean() }),
          }),
        },
        implementations: { ...registry.implementations, 'test.close': () => ({ closed: true }) },
      },
      { isLead, resolvers: RESOLVERS, check: true },
    );
    const holding = core.call('test.hold', { canvas: CANVAS, agent: 'peer' }, CALLERS.you);
    await vi.waitFor(() => {
      expect(registry.calls['test.hold']).toHaveLength(1);
    });
    expect(await core.call('test.close', { canvas: CANVAS }, CALLERS.you)).toEqual({
      ok: true,
      value: { closed: true, revs: {} },
    });
    expect(await holding).toEqual({ ok: true, value: { stopped: true } });
  });

  it('lets an op in the app’s scope drain the canvas it replaces, and none when it replaces none', async () => {
    const registry = testRegistry();
    const surface = {
      access: { you: 'all' },
      kind: 'command',
      scope: 'app',
      drains: 'canvas',
    } as const;
    const core = createDispatcher(
      {
        ...registry,
        surface: { ...registry.surface, 'test.create': surface },
        ops: {
          ...registry.ops,
          'test.create': withEnvelope(surface, {
            summary: 'Creates a canvas, maybe in place of another.',
            input: z.strictObject({ replace: z.strictObject({ canvas: z.uuid() }).optional() }),
            output: z.strictObject({ created: z.boolean() }),
          }),
        },
        implementations: { ...registry.implementations, 'test.create': () => ({ created: true }) },
      },
      { isLead, resolvers: RESOLVERS, check: true },
    );
    const holding = core.call('test.hold', { canvas: CANVAS, agent: 'peer' }, CALLERS.you);
    await vi.waitFor(() => {
      expect(registry.calls['test.hold']).toHaveLength(1);
    });
    expect(await core.call('test.create', {}, CALLERS.you)).toMatchObject({ ok: true });
    expect(registry.released).toEqual([]);
    expect(
      await core.call('test.create', { replace: { canvas: CANVAS } }, CALLERS.you),
    ).toMatchObject({ ok: true });
    expect(await holding).toEqual({ ok: true, value: { stopped: true } });
  });

  it('refuses text with a broken character (a lone surrogate) anywhere in its arguments', async () => {
    const registry = testRegistry();
    const surface = { access: { you: 'all' }, kind: 'command', scope: 'none' } as const;
    const core = createDispatcher(
      {
        ...registry,
        surface: { ...registry.surface, 'test.labels': surface },
        ops: {
          ...registry.ops,
          'test.labels': withEnvelope(surface, {
            summary: 'Labels things.',
            input: z.strictObject({
              labels: z.record(z.string().max(10), z.string().max(10)).optional(),
            }),
            output: z.strictObject({}),
          }),
        },
        implementations: { ...registry.implementations, 'test.labels': () => ({}) },
      },
      { isLead, resolvers: RESOLVERS, check: true },
    );
    const broken = (where: string) => ({
      ok: false,
      error: {
        code: 'invalid',
        sentence: `Invalid arguments (${where}): it holds a broken character (a lone surrogate).`,
      },
    });
    expect(await core.call('test.message', message({ body: 'hello \ud800' }), CALLERS.you)).toEqual(
      broken('body'),
    );
    expect(await core.call('test.agent', { canvas: CANVAS, agent: '\udc00' }, CALLERS.you)).toEqual(
      broken('agent'),
    );
    // A key too, named by what holds it.
    expect(await core.call('test.labels', { labels: { 'a\ud800': 'x' } }, CALLERS.you)).toEqual(
      broken('labels'),
    );
    expect([registry.calls['test.message'], registry.calls['test.agent']]).toEqual([[], []]);
    // Whole surrogate pairs are text like any other.
    expect(await core.call('test.labels', { labels: { '𝔸': '𝔸' } }, CALLERS.you)).toMatchObject({
      ok: true,
    });
  });

  it('gives every write’s result the revisions it reached, and a read’s none', async () => {
    const { core } = setup();
    expect(await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you)).toEqual(
      { ok: true, value: { agent: 'helper', revs: {} } },
    );
    expect(await core.call('test.read', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { caller: 'you', same: 1 },
    });
  });

  describe('ctx.commit', () => {
    /** The test registry with test.agent committing a change to its canvas's document. */
    function committing(commit: Committer) {
      const registry = testRegistry();
      return createDispatcher(
        {
          ...registry,
          implementations: {
            ...registry.implementations,
            'test.agent': ({ canvas, agent }: { canvas?: string; agent: string }, ctx: OpContext) =>
              ctx.commit(canvas, (document) => ({ next: document, result: { agent } })),
          },
        },
        { isLead, resolvers: RESOLVERS, check: true, commit, openCanvases: () => [] },
      );
    }
    const DOCUMENT = { id: CANVAS, arrange: false, nodes: [], links: [] };

    it('commits as the caller’s party, giving the call the revision it reached', async () => {
      const calls: unknown[] = [];
      const core = committing((canvas, build, call) => {
        calls.push({ canvas, op: call.op, by: call.by, request: call.request });
        call.noReturn();
        return Promise.resolve({ result: build(DOCUMENT).result, rev: 7 });
      });
      const args = { canvas: CANVAS, agent: 'helper', request: REQUEST };
      expect(await core.call('test.agent', args, CALLERS['outside-write'])).toEqual({
        ok: true,
        value: { agent: 'helper', revs: { [`canvas:${CANVAS}`]: 7 } },
      });
      expect(calls).toEqual([
        { canvas: CANVAS, op: 'test.agent', by: 'outside:orchestrator', request: REQUEST },
      ]);
    });

    it('gives a commit that changed nothing no revision', async () => {
      const core = committing((_canvas, build) =>
        Promise.resolve({ result: build(DOCUMENT).result }),
      );
      expect(
        await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you),
      ).toEqual({ ok: true, value: { agent: 'helper', revs: {} } });
    });

    it('runs a request again whose commit couldn’t be written', async () => {
      let tries = 0;
      const core = committing((_canvas, build) => {
        tries += 1;
        if (tries === 1) throw new CommitFailed(new Error('The disk is full.'));
        return Promise.resolve({ result: build(DOCUMENT).result, rev: 2 });
      });
      const args = { canvas: CANVAS, agent: 'helper', request: REQUEST };
      expect(await core.call('test.agent', args, CALLERS.you)).toEqual({
        ok: false,
        error: {
          code: 'unavailable',
          sentence: 'The change couldn’t be written, so nothing changed: The disk is full.',
        },
      });
      expect(await core.call('test.agent', args, CALLERS.you)).toMatchObject({
        ok: true,
        value: { revs: { [`canvas:${CANVAS}`]: 2 } },
      });
      expect(tries).toBe(2);
    });

    it('refuses a commit in a core that keeps no documents', async () => {
      const registry = testRegistry();
      const bare = createDispatcher(
        {
          ...registry,
          implementations: {
            ...registry.implementations,
            'test.agent': ({ canvas }: { canvas?: string }, ctx: OpContext) =>
              ctx.commit(canvas, (document) => ({ next: document, result: {} })),
          },
        },
        { isLead, resolvers: RESOLVERS },
      );
      expect(
        await bare.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you),
      ).toEqual({
        ok: false,
        error: { code: 'unavailable', sentence: 'This core keeps no canvas’s document.' },
      });
    });
  });

  it('answers a conflict with what the entities it names are now', async () => {
    const registry = testRegistry();
    const current = { 'node/helper': { rev: 3, value: null } };
    const core = createDispatcher(
      {
        ...registry,
        implementations: {
          ...registry.implementations,
          'test.agent': () => {
            throw new OpFailure('conflict', 'It changed.', current);
          },
        },
      },
      { isLead, resolvers: RESOLVERS, check: true },
    );
    expect(await core.call('test.agent', { canvas: CANVAS, agent: 'helper' }, CALLERS.you)).toEqual(
      { ok: false, error: { code: 'conflict', sentence: 'It changed.', current } },
    );
  });

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
        error: {
          code: 'human-only',
          sentence: 'Only the user can call test.yours, in corrallm’s window.',
        },
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
      value: { agent: 'helper', revs: {} },
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
      value: { sent: 'peer', revs: {} },
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
      value: { sent: 'peer', revs: {} },
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
      value: { sent: 'peer', revs: {} },
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
      value: { deleted: 'stranger', revs: {} },
    });
  });

  it('checks a token’s rules in the op’s scope, once what runs there before it is done', async () => {
    const registry = testRegistry();
    const checked: string[] = [];
    const core = createDispatcher(
      {
        ...registry,
        rules: {
          'shell-text': {
            'test.message': ({ body }: { body: string }) => {
              checked.push(body);
              return undefined;
            },
          },
        },
      },
      { isLead, resolvers: RESOLVERS, check: true },
    );
    const peer = { canvas: CANVAS, agent: 'peer' };
    const holding = core.call('test.hold', peer, CALLERS.you);
    await vi.waitFor(() => {
      expect(registry.calls['test.hold']).toHaveLength(1);
    });
    const sending = core.call('test.message', message(), CALLERS['outside-write']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(checked).toEqual([]);
    await core.call('test.stop', peer, CALLERS.you);
    await holding;
    expect(await sending).toEqual({ ok: true, value: { sent: 'peer', revs: {} } });
    expect(checked).toEqual(['hello']);
  });

  it('keeps a rule’s check by the op carrying it, refusing an op whose check isn’t kept', async () => {
    const registry = testRegistry();
    const core = createDispatcher(
      {
        ...registry,
        // The shell-text rule is checked on test.message alone; the proposing rule on no op (as a
        // rule only checked on the change at commit).
        rules: { 'shell-text': { 'test.agent': () => undefined } },
      },
      { isLead, resolvers: RESOLVERS, check: true },
    );
    expect(await core.call('test.message', message(), CALLERS.worker)).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence: 'No check is kept for the rule shell-text on test.message.',
      },
    });
    expect(registry.calls['test.message']).toEqual([]);
    expect(
      await core.call(
        'test.delete',
        { canvas: CANVAS, agent: 'stranger' },
        CALLERS['outside-write'],
      ),
    ).toEqual({ ok: true, value: { deleted: 'stranger', revs: {} } });
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
    expect(await retry).toEqual({ ok: true, value: { agent: 'helper', revs: {} } });
    expect(runs).toBe(2);
    // The retry's result is the one kept.
    expect(await core.call('test.agent', args, CALLERS['outside-write'])).toEqual({
      ok: true,
      value: { agent: 'helper', revs: {} },
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
    expect(broken.again).toEqual({ ok: true, value: { agent: 'again', revs: {} } });
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
    expect(await call(stopped)).toEqual({ ok: true, value: { agent: 'again', revs: {} } });
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
        value: { stopped: true, revs: {} },
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
