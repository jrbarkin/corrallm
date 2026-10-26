import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PROPOSING_RULES } from '../../shared/api/define';
import type { OpResult } from '../../shared/api/errors';
import { brandsIn, idsIn } from '../../shared/api/ids';
import { toolName } from '../../shared/api/registry';
import { PARTIES } from '../../shared/api/surface';
import type { Party, Rule, Surface } from '../../shared/api/surface';
import { listTools } from '../api/mcp';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import type { TokenCaller } from './caller';
import {
  allValid,
  CALLERS,
  CANVAS,
  isLead,
  OTHER_CANVAS,
  pipedRegistry,
  RESOLVERS,
  TEST_FIXTURES,
  TEST_OUT_OF_REACH,
  testRegistry,
  unreachableCalls,
  validFor,
} from './test-registry';
import type { OpFixture, OutOfReach } from './test-registry';
import { REAL_FIXTURES, REAL_OUT_OF_REACH, startWorld } from './test-world';

const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

/*
 * T3b (Core Server §3.7), generated from a registry: what each op answers each party. A party
 * outside an op's audience is refused (human-only for an op yours alone), and its tool list leaves
 * the op out; the parties in it get the same result but for the fields the op says vary; a rule is
 * refused (or proposed) to a token and applied for you; and reach, per op and party: each id an
 * op's valid arguments name, swapped in turn for each id of its kind a token party in the audience
 * doesn't reach (`OutOfReach`), is not-found. It runs on the registry and on the core's test
 * registry, which has an op for every check.
 */

const TOKEN_PARTIES = PARTIES.filter((party) => party !== 'you');

interface Setup {
  core: Dispatcher;
  /** Readies it for a call of op `op` meeting `rule`: what undoes that. */
  meeting?(rule: Rule, op: string): () => void;
  close(): Promise<void>;
}

const REGISTRIES: [
  string,
  Readonly<Record<string, OpFixture>>,
  OutOfReach,
  () => Promise<Setup>,
][] = [
  ['the registry', REAL_FIXTURES, REAL_OUT_OF_REACH, startWorld],
  [
    'the test registry',
    TEST_FIXTURES,
    TEST_OUT_OF_REACH,
    () => {
      // Each call a second after the last: no token's writes are limited here.
      let now = 0;
      const core = createDispatcher(testRegistry(), {
        isLead,
        resolvers: RESOLVERS,
        check: true,
        now: () => (now += 1000),
      });
      return Promise.resolve({ core, close: () => Promise.resolve() });
    },
  ],
];

/**
 * What keeps T3b from trying every token party's reach on every op that takes an id: a kind of id
 * an op takes that none of its valid arguments names, a kind `world` doesn't say what a party in
 * the audience doesn't reach of, or a party no call is generated for.
 */
function reachGaps(
  core: Dispatcher,
  fixtures: Readonly<Record<string, OpFixture>>,
  world: OutOfReach,
): string[] {
  return Object.entries(fixtures).flatMap(([name, fixture]) => {
    const def = core.ops[name];
    const surface = core.surface[name];
    if (!def || !surface) return [`${name}: there is no such op`];
    const brands = [...new Set(brandsIn(def.input))];
    if (brands.length === 0) return [];
    const named = new Set(
      allValid(fixture).flatMap((args) => idsIn(def.input, args).map(({ brand }) => brand)),
    );
    const calls = unreachableCalls(core, name, fixture, world);
    return [
      ...brands
        .filter((brand) => !named.has(brand))
        .map((brand) => `${name}: its valid arguments name no ${brand}`),
      ...TOKEN_PARTIES.flatMap((party) => {
        const reach = surface.access[party];
        if (reach === undefined) return [];
        const caller = CALLERS[party] as TokenCaller;
        return [
          ...brands
            .filter((brand) => world[brand]?.(caller, reach) === undefined)
            .map((brand) => `${name}: nothing says which ${brand} ${party} doesn’t reach`),
          ...(calls.some((call) => call.party === party)
            ? []
            : [`${name}: no call names what ${party} doesn’t reach`]),
        ];
      }),
    ];
  });
}

describe('T3b’s reach', () => {
  const core = createDispatcher(testRegistry(), { isLead, resolvers: RESOLVERS });

  it('fails an op whose reach it can’t generate calls for', () => {
    // A world that says nothing of agents.
    expect(reachGaps(core, TEST_FIXTURES, { CanvasId: () => [OTHER_CANVAS] })).toContain(
      'test.message: nothing says which AgentId worker doesn’t reach',
    );
    // Valid arguments that name no id.
    expect(
      reachGaps(core, { 'test.delete': { valid: [], invalid: [] } }, TEST_OUT_OF_REACH),
    ).toEqual([
      'test.delete: its valid arguments name no CanvasId',
      'test.delete: its valid arguments name no AgentId',
      'test.delete: no call names what outside-write doesn’t reach',
    ]);
    // A world where a party reaches everything.
    expect(reachGaps(core, TEST_FIXTURES, { CanvasId: () => [], AgentId: () => [] })).toContain(
      'test.stop: no call names what outside-read doesn’t reach',
    );
  });

  it('generates reach for an id behind a preprocess', async () => {
    const piped = createDispatcher(
      pipedRegistry((agent) => z.preprocess(trim, agent)),
      { isLead, resolvers: RESOLVERS },
    );
    expect(
      reachGaps(piped, { 'test.piped': { valid: [], invalid: [] } }, TEST_OUT_OF_REACH),
    ).toContain('test.piped: its valid arguments name no AgentId');
    const fixture = { valid: [{ canvas: CANVAS, to: ' peer ' }], invalid: [] };
    expect(reachGaps(piped, { 'test.piped': fixture }, TEST_OUT_OF_REACH)).toEqual([]);
    const calls = unreachableCalls(piped, 'test.piped', fixture, TEST_OUT_OF_REACH);
    expect(calls).toContainEqual({ party: 'worker', args: { canvas: CANVAS, to: 'stranger' } });
    for (const { party, args } of calls) {
      expect(await piped.call('test.piped', args, CALLERS[party])).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
    }
  });
});

/**
 * `result`'s value without the fields that may differ by who calls, and with those each call mints
 * anew (`fresh`) as only their kind.
 */
function invariant(
  result: OpResult<unknown>,
  varies: readonly string[],
  fresh: readonly string[] = [],
): unknown {
  if (!result.ok || typeof result.value !== 'object' || result.value === null) return result;
  return Object.fromEntries(
    Object.entries(result.value)
      .filter(([key]) => !varies.includes(key))
      .map(([key, value]) => [key, fresh.includes(key) ? typeof value : value]),
  );
}

describe.each(REGISTRIES)('T3b on %s', (_label, fixtures, world, start) => {
  let setup: Setup;
  beforeAll(async () => {
    setup = await start();
  });
  afterAll(async () => {
    await setup.close();
  });
  const surfaceOf = (name: string): Surface => {
    const surface = setup.core.surface[name];
    if (!surface) throw new Error(`There is no op ${name}.`);
    return surface;
  };
  const inAudience = (name: string, party: Party) => party in surfaceOf(name).access;

  it('has fixtures meeting every rule each op carries', () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      for (const rule of surfaceOf(name).rules ?? []) {
        expect(fixture.meetsRule?.[rule], `${name}: ${rule}`).toBeDefined();
      }
    }
  });

  it('names, for every kind of id an op takes, what each token party in its audience doesn’t reach', () => {
    expect(reachGaps(setup.core, fixtures, world)).toEqual([]);
  });

  describe.each(Object.entries(fixtures))('%s', (name, fixture) => {
    it.each(PARTIES)(
      'is listed to %s only if it is in the audience, and refused otherwise',
      async (party) => {
        const listed = listTools(setup.core, CALLERS[party]).map((tool) => tool.name);
        expect(listed.includes(toolName(name))).toBe(inAudience(name, party));
        if (inAudience(name, party)) return;
        const yoursAlone = Object.keys(surfaceOf(name).access).every((p) => p === 'you');
        for (const args of [...fixture.valid, ...fixture.invalid]) {
          expect(await setup.core.call(name, args, CALLERS[party])).toMatchObject({
            ok: false,
            error: { code: yoursAlone ? 'human-only' : 'forbidden' },
          });
        }
      },
    );

    it('answers every party in its audience alike, but for the fields it says vary', async () => {
      const varies = surfaceOf(name).varies ?? [];
      const proposes = (surfaceOf(name).rules ?? []).some((rule) => PROPOSING_RULES.includes(rule));
      const audience = PARTIES.filter((p) => inAudience(name, p));
      // A party with arguments of its own takes them, and is answered.
      for (const party of audience.filter((p) => fixture.by?.[p] !== undefined)) {
        for (const args of validFor(fixture, party)) {
          const theirs = await setup.core.call(name, args, CALLERS[party]);
          expect(theirs.ok, `${party}: ${JSON.stringify(theirs)}`).toBe(true);
        }
      }
      // Each other party's answer against the first's: yours, where you are in the audience.
      const [first, ...others] = audience.filter((p) => fixture.by?.[p] === undefined);
      if (first === undefined) return;
      for (const args of fixture.valid) {
        const firsts = await setup.core.call(name, args, CALLERS[first]);
        expect(firsts.ok, JSON.stringify(firsts)).toBe(true);
        for (const party of others) {
          const theirs = await setup.core.call(name, args, CALLERS[party]);
          // A token's call that came to you as a proposal is its rule's to check, below.
          if (proposes && theirs.ok && 'proposed' in (theirs.value as object)) continue;
          expect(invariant(theirs, varies, fixture.fresh), party).toEqual(
            invariant(firsts, varies, fixture.fresh),
          );
        }
      }
    });

    it('refuses what doesn’t fit it, to everyone in its audience', async () => {
      for (const args of fixture.invalid) {
        for (const party of PARTIES.filter((p) => inAudience(name, p))) {
          expect(await setup.core.call(name, args, CALLERS[party]), party).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
          });
        }
      }
    });

    it('refuses a token’s call meeting each of its rules (or makes it a proposal), and applies yours', async () => {
      for (const [rule, args] of Object.entries(fixture.meetsRule ?? {})) {
        // The tokens first: yours may change what the rule reads (a pause you set, released).
        // An agent's own node is what R6 (`self`) guards: an outside token has none to meet it.
        const meeting = TOKEN_PARTIES.filter(
          (p) => inAudience(name, p) && (rule !== 'self' || CALLERS[p].kind === 'agent'),
        );
        // What the world must be for a call to meet it (R11: a party at its cap), only meanwhile.
        const met = setup.meeting?.(rule as Rule, name);
        try {
          for (const party of meeting) {
            const theirs = await setup.core.call(name, args, CALLERS[party]);
            if (PROPOSING_RULES.includes(rule as Rule)) {
              expect(theirs.ok && 'proposed' in (theirs.value as object), `${rule}: ${party}`).toBe(
                true,
              );
            } else {
              expect(theirs, `${rule}: ${party}`).toMatchObject({
                ok: false,
                error: { code: 'refused' },
              });
            }
          }
        } finally {
          met?.();
        }
        const yours = await setup.core.call(name, args, CALLERS.you);
        expect(yours.ok && !('proposed' in (yours.value as object)), rule).toBe(true);
      }
    });

    it('answers not-found to each token party naming, for any id, one it doesn’t reach', async () => {
      for (const { party, args } of unreachableCalls(setup.core, name, fixture, world)) {
        expect(
          await setup.core.call(name, args, CALLERS[party]),
          `${party}: ${JSON.stringify(args)}`,
        ).toMatchObject({ ok: false, error: { code: 'not-found' } });
      }
    });
  });
});

describe('proposal reach', () => {
  it('hides a multi-agent proposal from a worker reaching only its first agent', async () => {
    const world = await startWorld();
    try {
      const core = world.core;
      expect(
        await core.call(
          'canvas.unlink',
          { canvas: CANVAS, a: 'worker', b: 'condemned-b' },
          CALLERS.you,
        ),
      ).toMatchObject({ ok: true });
      expect(
        await core.call(
          'queue.add',
          { canvas: CANVAS, agent: 'condemned-b', entry: { message: 'Private work' } },
          CALLERS.you,
        ),
      ).toMatchObject({ ok: true });
      const proposed = await core.call(
        'canvas.delete',
        { canvas: CANVAS, nodes: ['condemned-a', 'condemned-b'] },
        CALLERS['outside-write'],
      );
      expect(proposed).toMatchObject({
        ok: true,
        value: { proposed: expect.any(String) as string },
      });
      const yours = await core.call('needs', { canvas: CANVAS }, CALLERS.you);
      expect(yours.ok && JSON.stringify(yours.value)).toContain('Condemned-b');
      const result = await core.call('needs', { canvas: CANVAS }, CALLERS.worker);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.error.sentence);
      expect(JSON.stringify(result.value.items)).not.toContain('Condemned-b');
      expect(JSON.stringify(result.value.items)).not.toContain('Private work');
      if (!proposed.ok || !('proposed' in proposed.value)) throw new Error('Not proposed');
      // A known id must not reveal the hidden title through reply's refusal either.
      expect(
        await core.call(
          'reply',
          { canvas: CANVAS, to: proposed.value.proposed, answer: { choice: 'allow' } },
          CALLERS.worker,
        ),
      ).toMatchObject({ ok: false, error: { code: 'not-found' } });
      // Reaching all named agents still reveals the proposal, without choices.
      expect(
        await core.call(
          'canvas.link',
          { canvas: CANVAS, a: 'worker', b: 'condemned-b' },
          CALLERS.you,
        ),
      ).toMatchObject({ ok: true });
      const reachable = await core.call('needs', { canvas: CANVAS }, CALLERS.worker);
      expect(reachable.ok && JSON.stringify(reachable.value)).toContain('Condemned-b');
      if (!reachable.ok) throw new Error(reachable.error.sentence);
      expect(reachable.value.items).toContainEqual(
        expect.objectContaining({ id: proposed.value.proposed, choices: [] }),
      );
    } finally {
      await world.close();
    }
  });
});
