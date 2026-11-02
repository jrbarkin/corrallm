import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { withEnvelope } from '../../shared/api/define';
import { brandedId } from '../../shared/api/ids';
import { RULES } from '../../shared/api/rules';
import { SURFACE, W } from '../../shared/api/surface';
import type { Surface } from '../../shared/api/surface';
import { MADE_UP } from '../../shared/test-made-up';
import { callTool, listTools } from '../api/mcp';
import { createDispatcher } from './call';
import type { Implementation, Registry } from './call';
import type { OutsideCaller } from './caller';
import { mergePermits, onEveryCarrier, ruleChecks } from './rules';
import type { Engines } from './engines';
import { CALLERS, CANVAS, isLead, RESOLVERS } from './test-registry';

/*
 * Q30 (B9b Design §9 C1): a person may make a read-write token that merges no agent's branch
 * (`--no-merge`). Its party stays outside-write, so its tool list is a writer's; the
 * `merge-permits` rule, checked in core.call on every op that carries it (branch.merge, from its
 * registration), refuses its call, whatever transport it comes by and whatever op runs it.
 */

const SENTENCE = 'This token was made with --no-merge: it can’t merge an agent’s branch.';

const NO_MERGE: OutsideCaller = {
  kind: 'outside',
  token: 'no-merge-token',
  name: 'builder',
  access: 'write',
  merge: false,
  canvases: [CANVAS],
};

const Canvas = brandedId('CanvasId', z.uuid());
const Agent = brandedId('AgentId', z.string().min(1).max(64));

/** An op shaped as branch.merge is to be (§9 C1), and one that runs it as part of itself. */
const SURFACES = {
  'test.merge': {
    access: W,
    kind: 'command',
    scope: 'none',
    self: 'refused',
    rules: ['merge-permits'],
  },
  'test.outer': { access: W, kind: 'command', scope: 'none' },
} as const satisfies Record<string, Surface>;

function registry(): Registry & { merged: unknown[] } {
  const merged: unknown[] = [];
  const implementations: Record<string, Implementation> = {
    'test.merge': ({ agent }: { agent: string }) => {
      merged.push(agent);
      return { merged: agent };
    },
    'test.outer': async ({ agent }: { agent: string }, ctx) => {
      await ctx.call('test.merge', { canvas: CANVAS, agent });
      return { merged: agent };
    },
  };
  const input = z.strictObject({ canvas: Canvas, agent: Agent });
  const output = z.strictObject({ merged: z.string() });
  return {
    surface: SURFACES,
    ops: {
      'test.merge': withEnvelope(SURFACES['test.merge'], {
        summary: 'Merges an agent’s branch.',
        input,
        output,
      }),
      'test.outer': withEnvelope(SURFACES['test.outer'], {
        summary: 'Merges an agent’s branch as part of itself.',
        input,
        output,
      }),
    },
    implementations,
    rules: {
      'merge-permits': onEveryCarrier(
        'merge-permits',
        (_args, { caller }) => mergePermits(caller),
        SURFACES,
      ),
    },
    merged,
  };
}

describe('merge-permits', () => {
  it('is a RULES row checked on a call, telling a --no-merge token why', () => {
    expect(RULES['merge-permits']).toEqual({ kind: 'argument', sentence: SENTENCE });
  });

  it('lets only a token made to merge merge: never one made with --no-merge, a read-only one or an agent', () => {
    expect(mergePermits(CALLERS['outside-write'] as OutsideCaller)).toBeUndefined();
    expect(mergePermits(NO_MERGE)).toEqual({ refuse: SENTENCE });
    expect(mergePermits(CALLERS['outside-read'] as OutsideCaller)).toEqual({ refuse: SENTENCE });
    // No agent merges in B9b (B24 decides a lead's): the rule refuses one, besides the audience.
    expect(mergePermits(CALLERS.lead as Parameters<typeof mergePermits>[0])).toMatchObject({
      refuse: expect.any(String) as string,
    });
  });

  it('guards every op that carries it, and the core’s checks guard exactly those of the registry', () => {
    const check = () => undefined;
    expect(Object.keys(onEveryCarrier('merge-permits', check, SURFACES))).toEqual(['test.merge']);
    const carriers = Object.entries(SURFACE as Readonly<Record<string, Surface>>)
      .filter(([, surface]) => surface.rules?.includes('merge-permits'))
      .map(([name]) => name);
    expect(Object.keys(ruleChecks({} as Engines, MADE_UP)['merge-permits']).sort()).toEqual(
      carriers.sort(),
    );
  });

  it('is checked in core.call for every caller: a --no-merge token is refused, you and a merging token aren’t', async () => {
    const fixture = registry();
    const core = createDispatcher(fixture, { isLead, resolvers: RESOLVERS, check: true });
    const args = { canvas: CANVAS, agent: 'worker' };
    expect(await core.call('test.merge', args, CALLERS.you)).toMatchObject({ ok: true });
    expect(await core.call('test.merge', args, CALLERS['outside-write'])).toMatchObject({
      ok: true,
    });
    expect(await core.call('test.merge', args, NO_MERGE)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: SENTENCE },
    });
    // Run as part of another op, it is checked as a call of the caller's own.
    expect(await core.call('test.outer', args, NO_MERGE)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: SENTENCE },
    });
    // The audience refuses the rest first.
    for (const party of ['outside-read', 'lead', 'worker'] as const) {
      expect(await core.call('test.merge', args, CALLERS[party])).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
    expect(fixture.merged).toEqual(['worker', 'worker']);
  });

  it('leaves a --no-merge token a writer’s tool list, and refuses its call there all the same', async () => {
    const core = createDispatcher(registry(), { isLead, resolvers: RESOLVERS, check: true });
    const listed = (caller: typeof NO_MERGE | (typeof CALLERS)['outside-write']) =>
      listTools(core, caller).map(({ name }) => name);
    expect(listed(NO_MERGE)).toEqual(listed(CALLERS['outside-write']));
    expect(listed(NO_MERGE)).toContain('test_merge');
    const result = await callTool(core, NO_MERGE, 'test_merge', {
      canvas: CANVAS,
      agent: 'worker',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('--no-merge');
  });
});
