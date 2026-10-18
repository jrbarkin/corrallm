import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROPOSING_RULES } from '../../shared/api/define';
import type { OpResult } from '../../shared/api/errors';
import { toolName } from '../../shared/api/registry';
import { PARTIES } from '../../shared/api/surface';
import type { Party, Rule, Surface } from '../../shared/api/surface';
import { listTools } from '../api/mcp';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import { createCore } from './core';
import {
  CALLERS,
  isLead,
  NO_DESKTOP,
  REAL_FIXTURES,
  RESOLVERS,
  TEST_FIXTURES,
  testRegistry,
} from './test-registry';
import type { OpFixture } from './test-registry';

/*
 * T3b (Core Server §3.7), generated from a registry: what each op answers each party. A party
 * outside an op's audience is refused (human-only for an op yours alone), and its tool list leaves
 * the op out; the parties in it get the same result but for the fields the op says vary; a rule is
 * refused (or proposed) to a token and applied for you; an id out of a party's reach is not-found.
 * It runs on the registry and on the core's test registry, which has an op for every check.
 */

const TOKEN_PARTIES = PARTIES.filter((party) => party !== 'you');

interface Setup {
  core: Dispatcher;
  close(): Promise<void>;
}

const REGISTRIES: [string, Readonly<Record<string, OpFixture>>, () => Promise<Setup>][] = [
  [
    'the registry',
    REAL_FIXTURES,
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

/** `result`'s value without the fields that may differ by who calls. */
function invariant(result: OpResult<unknown>, varies: readonly string[]): unknown {
  if (!result.ok || typeof result.value !== 'object' || result.value === null) return result;
  return Object.fromEntries(Object.entries(result.value).filter(([key]) => !varies.includes(key)));
}

describe.each(REGISTRIES)('T3b on %s', (_label, fixtures, start) => {
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

    it('answers not-found to each party naming what it doesn’t reach', async () => {
      for (const [party, args] of Object.entries(fixture.unreachable ?? {})) {
        expect(await setup.core.call(name, args, CALLERS[party as Party]), party).toMatchObject({
          ok: false,
          error: { code: 'not-found' },
        });
      }
    });
  });
});
