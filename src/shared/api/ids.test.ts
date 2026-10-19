import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { brandedId, brandsIn, idsIn, NeedId, UnreadableIds } from './ids';
import { MAX_NEED_ID } from './limits';

/*
 * The ids core.call resolves against a token's reach (core/reach.ts): each branded id an op's
 * parsed arguments name, read on the side of a pipe the parsed value matches, and never none where
 * the walker can't tell which id the op gets.
 */

const Agent = brandedId('AgentId', z.string().min(1).max(64));
const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
const idsOf = (schema: z.ZodType, raw: unknown) => idsIn(schema, schema.parse(raw));

describe('idsIn', () => {
  it('finds each id where it is: in fields, lists, optional fields and unions', () => {
    const input = z.strictObject({
      agent: Agent,
      nodes: z.array(Agent).max(3),
      parent: Agent.optional(),
      to: z.union([z.literal('manager'), Agent]),
    });
    expect(idsOf(input, { agent: 'lead', nodes: ['peer', 'helper'], to: 'worker' })).toEqual([
      { brand: 'AgentId', id: 'lead', path: '.agent' },
      { brand: 'AgentId', id: 'peer', path: '.nodes[0]' },
      { brand: 'AgentId', id: 'helper', path: '.nodes[1]' },
      { brand: 'AgentId', id: 'worker', path: '.to' },
    ]);
    expect(idsOf(input, { agent: 'lead', nodes: [], to: 'manager' })).toEqual([
      { brand: 'AgentId', id: 'lead', path: '.agent' },
    ]);
  });

  it('reads a pipe on its out side, which the parsed value matches', () => {
    const input = z.strictObject({ to: z.preprocess(trim, Agent), from: z.string().pipe(Agent) });
    expect(idsOf(input, { to: ' peer ', from: 'lead' })).toEqual([
      { brand: 'AgentId', id: 'peer', path: '.to' },
      { brand: 'AgentId', id: 'lead', path: '.from' },
    ]);
  });

  it('fails closed on an id a pipe may change once it is checked', () => {
    const unbranded = z.custom<z.output<typeof Agent>>();
    for (const to of [Agent.transform((id) => id.toUpperCase()), Agent.pipe(unbranded)]) {
      expect(() => idsOf(z.strictObject({ to }), { to: 'peer' })).toThrow(new UnreadableIds('.to'));
    }
  });

  it('fails closed on a value no option of a union holding an id takes once parsed', () => {
    const to = z.union([z.literal('manager'), Agent.transform((agent) => ({ agent }))]);
    expect(() => idsOf(z.strictObject({ to }), { to: 'stranger' })).toThrow(
      new UnreadableIds('.to'),
    );
    // A union holding no id names none, whatever it parsed to.
    const plain = z.union([z.boolean(), z.number().transform((n) => ({ n }))]);
    expect(idsOf(z.strictObject({ n: plain }), { n: 5 })).toEqual([]);
  });
});

describe('brandsIn', () => {
  it('finds an id on either side of a pipe', () => {
    expect(brandsIn(z.preprocess(trim, Agent))).toEqual(['AgentId']);
    expect(brandsIn(Agent.transform((id) => id.length))).toEqual(['AgentId']);
    expect(brandsIn(z.strictObject({ n: z.number().transform(String) }))).toEqual([]);
  });
});

describe('NeedId', () => {
  it('names a Needs item by what it is, then whose and which: never a bare UUID', () => {
    for (const id of [
      'hold/lead/check',
      'start/a%2Fb',
      'prompt/worker/toolu_01',
      'proposal/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      'file/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    ]) {
      expect(NeedId.safeParse(id).success, id).toBe(true);
    }
    for (const id of [
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      'hold/',
      'later/lead',
      `hold/${'x'.repeat(MAX_NEED_ID)}`,
    ]) {
      expect(NeedId.safeParse(id).success, id).toBe(false);
    }
  });
});
