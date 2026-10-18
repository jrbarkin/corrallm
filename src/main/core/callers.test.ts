import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
import { createCore } from './core';
import {
  CALLERS,
  CANVAS,
  isLead,
  NO_DESKTOP,
  OTHER_CANVAS,
  pipedRegistry,
  REAL_FIXTURES,
  REAL_OUT_OF_REACH,
  RESOLVERS,
  TEST_FIXTURES,
  TEST_OUT_OF_REACH,
  testRegistry,
  unreachableCalls,
} from './test-registry';
import type { OpFixture, OutOfReach } from './test-registry';

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
  close(): Promise<void>;
}

const REGISTRIES: [
  string,
  Readonly<Record<string, OpFixture>>,
  OutOfReach,
  () => Promise<Setup>,
][] = [
  [
    'the registry',
    REAL_FIXTURES,
    REAL_OUT_OF_REACH,
    async () => {
      const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-callers-'));
      const core = await createCore(
        { profile, app: { name: 'corrallm', version: '1.0.0' }, check: true },
        NO_DESKTOP,
      );
      return {
        core,
        close: async () => {
          await core.close();
          await rm(profile, { recursive: true, force: true });
        },
      };
    },
  ],
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
      fixture.valid.flatMap((args) => idsIn(def.input, args).map(({ brand }) => brand)),
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

/** `result`'s value without the fields that may differ by who calls. */
function invariant(result: OpResult<unknown>, varies: readonly string[]): unknown {
  if (!result.ok || typeof result.value !== 'object' || result.value === null) return result;
  return Object.fromEntries(Object.entries(result.value).filter(([key]) => !varies.includes(key)));
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
      // Each party's answer against the first's: yours, where you are in the audience.
      const [first, ...others] = PARTIES.filter((p) => inAudience(name, p));
      if (first === undefined) return;
      for (const args of fixture.valid) {
        const firsts = await setup.core.call(name, args, CALLERS[first]);
        expect(firsts.ok, JSON.stringify(firsts)).toBe(true);
        for (const party of others) {
          const theirs = await setup.core.call(name, args, CALLERS[party]);
          // A token's call that came to you as a proposal is its rule's to check, below.
          if (proposes && theirs.ok && 'proposed' in (theirs.value as object)) continue;
          expect(invariant(theirs, varies), party).toEqual(invariant(firsts, varies));
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
        const yours = await setup.core.call(name, args, CALLERS.you);
        expect(yours.ok && !('proposed' in (yours.value as object)), rule).toBe(true);
        for (const party of TOKEN_PARTIES.filter((p) => inAudience(name, p))) {
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
