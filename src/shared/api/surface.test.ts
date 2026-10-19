import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { JsonSchema } from '../session';
import { withEnvelope } from './define';
import type { OpDef } from './define';
import { DEVIATIONS, REASONS } from './deviations';
import { brandedId, brandsIn, children, defOf, ID_BRANDS, NeedId } from './ids';
import type { Brand } from './ids';
import { MAX_REQUEST_BYTES } from './limits';
import { inputSchemaOf, OPS, opsFor, outputSchemaOf, toolName, toolOf } from './registry';
import { RULES } from './rules';
import type { RuleRow } from './rules';
import { GUI_OPS, PARTIES, SURFACE } from './surface';
import type { Party, Rule, Surface } from './surface';
import { UNHOSTED } from './unhosted';

/*
 * The tests that make 1:1 the default (Core Server §3.7). T1: the surface's rules, checked on the
 * real registry and, to show each check catches what it should, on registries made wrong on
 * purpose. T2: surface.snap.json, the surfaces as each party sees them, so that every change to
 * them is a reviewed diff (`pnpm api:surface` writes it).
 */

interface Registry {
  surface: Readonly<Record<string, Surface>>;
  ops: Readonly<Record<string, OpDef>>;
  deviations: Readonly<Partial<Record<string, string>>>;
  unhosted: Readonly<Partial<Record<string, string>>>;
  rules: Readonly<Partial<Record<Rule, RuleRow>>>;
}

const REAL: Registry = {
  surface: SURFACE,
  ops: OPS,
  deviations: DEVIATIONS,
  unhosted: UNHOSTED,
  rules: RULES,
};

const NAME = /^[a-z]+(\.[a-zA-Z]+)?$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,49}$/;
/** Argument names that hold ids, which must therefore be branded. */
const ID_KEYS = new Set([
  'canvas',
  'agent',
  'node',
  'nodes',
  'link',
  'links',
  'item',
  'into',
  'before',
  'need',
  'message',
  'conversation',
  'task',
  'token',
  'id',
  'to',
  'replyTo',
  'from',
  'for',
  'a',
  'b',
  'frame',
  'group',
  'parent',
]);
/** The brands that name an agent, which an op open to a token must say whether it may aim at itself. */
const AGENT_BRANDS: readonly Brand[] = ['AgentId', 'NodeId'];

/** Whether `schema` takes strings that aren't a branded id (a literal or an enum is a fixed word). */
function takesUnbrandedText(schema: z.ZodType): boolean {
  if (ID_BRANDS.has(schema)) return false;
  const { type } = defOf(schema);
  if (type === 'string' || type === 'template_literal') return true;
  if (type === 'record') return false;
  return children(schema).some((child) => takesUnbrandedText(child.schema));
}

/** The argument names, under `path`, holding ids that aren't branded. */
function unbrandedIds(schema: z.ZodType, path = ''): string[] {
  return children(schema).flatMap(({ key, schema: child }) => {
    const at = key === undefined ? path : `${path}.${key}`;
    if (key !== undefined && ID_KEYS.has(key) && takesUnbrandedText(child)) return [at];
    return unbrandedIds(child, at);
  });
}

/** Whether `schema` holds a transform: what it parses may come out as something else. */
function transforms(schema: z.ZodType): boolean {
  return (
    defOf(schema).type === 'transform' || children(schema).some((child) => transforms(child.schema))
  );
}

/**
 * Where, under `path`, reach can't follow an id to the op: through a pipe (a transform after it, a
 * preprocess before it), or in a union with a transform, whose parsed value may fit another option.
 */
function hiddenIds(schema: z.ZodType, path = ''): string[] {
  const { type } = defOf(schema);
  if (brandsIn(schema).length > 0) {
    if (type === 'pipe') return [`${path} puts an id through a pipe`];
    if (type === 'union' && transforms(schema)) {
      return [`${path} is a union of an id and a transform`];
    }
  }
  return children(schema).flatMap(({ key, schema: child }) =>
    hiddenIds(child, key === undefined ? path : `${path}.${key}`),
  );
}

/** The fields an object result has, whichever of its shapes it takes. */
function resultFields(schema: z.ZodType): string[] {
  const def = defOf(schema);
  if (def.type === 'object') return Object.keys(def.shape ?? {});
  return children(schema).flatMap((child) => resultFields(child.schema));
}

const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** The most bytes a JSON number takes (-1.7976931348623157e+308). */
const NUMBER_BYTES = 24;
/** The most bytes a string's character takes in JSON: an escape, `\u001f`. */
const CHAR_BYTES = 6;

/**
 * The most bytes a JSON value the schema accepts can take, or where it is unbounded: a string
 * without a maximum length, a list without a maximum count, a map without both.
 */
function worstCase(schema: JsonSchema, path = ''): number | { unbounded: string } {
  const most = (list: (number | { unbounded: string })[]) =>
    list.reduce<number | { unbounded: string }>(
      (a, b) => (typeof a !== 'number' ? a : typeof b !== 'number' ? b : Math.max(a, b)),
      0,
    );
  const sum = (list: (number | { unbounded: string })[]) =>
    list.reduce<number | { unbounded: string }>(
      (a, b) => (typeof a !== 'number' ? a : typeof b !== 'number' ? b : a + b),
      0,
    );
  if ('const' in schema) return utf8(JSON.stringify(schema.const));
  if (Array.isArray(schema.enum)) return most(schema.enum.map((v) => utf8(JSON.stringify(v))));
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key])) {
      return most((schema[key] as JsonSchema[]).map((option) => worstCase(option, path)));
    }
  }
  if (Array.isArray(schema.allOf)) {
    return sum((schema.allOf as JsonSchema[]).map((part) => worstCase(part, path)));
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type];
  return most(
    types.map((type) => {
      switch (type) {
        case 'null':
          return 4;
        case 'boolean':
          return 5;
        case 'number':
        case 'integer':
          return NUMBER_BYTES;
        case 'string': {
          const length = schema.format === 'uuid' ? 36 : schema.maxLength;
          return typeof length === 'number' ? 2 + length * CHAR_BYTES : { unbounded: path };
        }
        case 'array': {
          const items = (schema.prefixItems as JsonSchema[] | undefined) ?? [];
          const fixed = sum(
            items.map((item, i) => {
              const each = worstCase(item, `${path}[${String(i)}]`);
              return typeof each === 'number' ? each + 1 : each;
            }),
          );
          if (schema.items === undefined || schema.items === false) return sum([2, fixed]);
          const count = schema.maxItems;
          if (typeof count !== 'number') return { unbounded: path };
          const each = worstCase(schema.items as JsonSchema, `${path}[]`);
          return typeof each === 'number' ? sum([2, fixed, count * (each + 1)]) : each;
        }
        case 'object': {
          const properties = Object.entries((schema.properties as JsonSchema | undefined) ?? {});
          const fields = sum(
            properties.map(([key, value]) => {
              const field = worstCase(value as JsonSchema, `${path}.${key}`);
              return typeof field === 'number' ? utf8(JSON.stringify(key)) + 2 + field : field;
            }),
          );
          const extra = schema.additionalProperties;
          if (extra === undefined || extra === false) return sum([2, fields]);
          const count = schema.maxProperties;
          const names = worstCase(
            (schema.propertyNames as JsonSchema | undefined) ?? { type: 'string' },
            `${path}{}`,
          );
          const each = worstCase(extra as JsonSchema, `${path}{}`);
          if (typeof count !== 'number') return { unbounded: path };
          return typeof names === 'number' && typeof each === 'number'
            ? sum([2, fields, count * (names + 2 + each)])
            : typeof names === 'number'
              ? each
              : names;
        }
        default:
          return { unbounded: path };
      }
    }),
  );
}

/** What T1 finds wrong with a registry: one line each, empty when it keeps every rule. */
function problems(registry: Registry): string[] {
  const found: string[] = [];
  const names = Object.keys(registry.surface);
  for (const [name, surface] of Object.entries(registry.surface)) {
    const def = registry.ops[name];
    if (!def) {
      found.push(`${name}: no schemas`);
      continue;
    }
    const parties = Object.keys(surface.access) as Party[];
    const unhosted = name in registry.unhosted;
    const gui = parties.includes('you') && !unhosted;
    const mcp = parties.some((party) => party !== 'you');
    const deviation = registry.deviations[name];
    if (gui !== mcp && !(mcp && unhosted)) {
      if (deviation === undefined) found.push(`${name}: on one surface only, with no deviation`);
      else if (!(deviation in REASONS)) found.push(`${name}: deviates for no listed reason`);
    } else if (deviation !== undefined) {
      found.push(`${name}: listed as a deviation, but it no longer deviates`);
    }

    const brands = brandsIn(def.input);
    if (mcp && brands.some((brand) => AGENT_BRANDS.includes(brand)) && !surface.self) {
      found.push(`${name}: names an agent, open to a token, and declares no self`);
    }
    const rules = surface.rules ?? [];
    if (
      rules.some((rule) => rule === 'discard' || rule === 'restore-code') &&
      !surface.destructive
    ) {
      found.push(`${name}: may become a proposal, and declares no destructive`);
    }
    for (const field of unbrandedIds(def.input))
      found.push(`${name}: ${field} is an id, not branded`);
    for (const hidden of hiddenIds(def.input)) found.push(`${name}: ${hidden}`);
    const worst = worstCase(inputSchemaOf(def));
    if (typeof worst !== 'number') {
      found.push(`${name}: ${worst.unbounded || 'its input'} is unbounded`);
    } else if (worst > MAX_REQUEST_BYTES) {
      found.push(`${name}: its input may take ${String(worst)} bytes, over MAX_REQUEST_BYTES`);
    }
    if (surface.waits && (surface.kind !== 'read' || deviation !== 'transport')) {
      found.push(`${name}: waits, but isn't a read on MCP alone (the transport deviation)`);
    }
    const fields = resultFields(def.output);
    for (const field of surface.varies ?? []) {
      if (!fields.includes(field)) found.push(`${name}: varies by ${field}, not in its result`);
    }
    if (!NAME.test(name)) found.push(`${name}: not area.verb`);
    if (!TOOL_NAME.test(toolName(name))) found.push(`${name}: its tool name isn't one MCP takes`);
    const listed = toolOf(name, def, surface);
    if (
      JSON.stringify(listed.inputSchema) !==
      JSON.stringify(z.toJSONSchema(def.input, { io: 'input' }))
    ) {
      found.push(`${name}: its inputSchema isn't exactly its input's JSON Schema`);
    }
  }
  for (const [name, phase] of Object.entries(registry.unhosted)) {
    const surface = registry.surface[name];
    if (!surface) found.push(`${name}: unhosted, but no such op`);
    else if (!('you' in surface.access)) found.push(`${name}: unhosted, but not for the GUI`);
    else if (!Object.keys(surface.access).some((party) => party !== 'you')) {
      found.push(`${name}: unhosted, and on no surface meanwhile`);
    }
    if (phase !== 'B8' && phase !== 'B11') found.push(`${name}: unhosted until ${String(phase)}`);
  }
  for (const name of Object.keys(registry.deviations)) {
    if (!(name in registry.surface)) found.push(`${name}: a deviation, but no such op`);
  }
  const used = new Set(names.flatMap((name) => registry.surface[name]?.rules ?? []));
  for (const rule of used) if (!(rule in registry.rules)) found.push(`${rule}: no RULES row`);
  for (const rule of Object.keys(registry.rules)) {
    if (!used.has(rule as Rule)) found.push(`${rule}: a RULES row no op carries`);
  }
  return found;
}

describe('T1: the surface’s rules', () => {
  it('holds for the registry', () => {
    expect(problems(REAL)).toEqual([]);
  });

  it('lists every operation once, with its schemas', () => {
    expect(Object.keys(OPS).sort()).toEqual(Object.keys(SURFACE).sort());
  });

  // Registries made wrong on purpose: each check catches what it should.
  const Agent = brandedId('AgentId', z.string().min(1).max(64));
  const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
  const both = { you: 'all', worker: 'linked' } as const;
  const yours = { you: 'all' } as const;
  const tokens = { 'outside-write': 'canvas' } as const;
  const read = (
    surface: Surface,
    input = z.strictObject({}),
    output: z.ZodType = z.strictObject({ ok: z.boolean() }),
  ) => withEnvelope(surface, { summary: 'A test op.', input, output });
  const registry = (
    ops: Record<string, [Surface, OpDef]>,
    more: Partial<Omit<Registry, 'surface' | 'ops'>> = {},
  ): Registry => ({
    surface: Object.fromEntries(Object.entries(ops).map(([name, [surface]]) => [name, surface])),
    ops: Object.fromEntries(Object.entries(ops).map(([name, [, def]]) => [name, def])),
    deviations: {},
    unhosted: {},
    rules: {},
    ...more,
  });
  const op = (
    surface: Surface,
    input?: z.ZodObject<z.core.$ZodShape, z.core.$strict>,
    output?: z.ZodType,
  ): [Surface, OpDef] => [surface, read(surface, input, output)];

  it.each<[string, Registry, string]>([
    [
      'an op on one surface without a deviation',
      registry({ 'test.yours': op({ access: yours, kind: 'read', scope: 'none' }) }),
      'test.yours: on one surface only, with no deviation',
    ],
    [
      'a deviation of no listed reason',
      registry(
        { 'test.yours': op({ access: yours, kind: 'read', scope: 'none' }) },
        { deviations: { 'test.yours': 'because' } },
      ),
      'test.yours: deviates for no listed reason',
    ],
    [
      'a deviation that no longer deviates',
      registry(
        { 'test.both': op({ access: both, kind: 'read', scope: 'none' }) },
        { deviations: { 'test.both': 'view' } },
      ),
      'test.both: listed as a deviation, but it no longer deviates',
    ],
    [
      'an unhosted op not for the GUI',
      registry(
        { 'test.tokens': op({ access: tokens, kind: 'read', scope: 'none' }) },
        { unhosted: { 'test.tokens': 'B8' } },
      ),
      'test.tokens: unhosted, but not for the GUI',
    ],
    [
      'an unhosted op that is yours alone, on no surface meanwhile',
      registry(
        { 'test.yours': op({ access: yours, kind: 'read', scope: 'none' }) },
        { unhosted: { 'test.yours': 'B11' } },
      ),
      'test.yours: unhosted, and on no surface meanwhile',
    ],
    [
      'an unhosted op that isn’t registered',
      registry({}, { unhosted: { 'test.gone': 'B8' } }),
      'test.gone: unhosted, but no such op',
    ],
    [
      'a rule with no row',
      registry({
        'test.shell': op({ access: both, kind: 'command', scope: 'none', rules: ['shell-text'] }),
      }),
      'shell-text: no RULES row',
    ],
    [
      'a row no op carries',
      registry({}, { rules: { sticky: { kind: 'argument', sentence: 'Only yours.' } } }),
      'sticky: a RULES row no op carries',
    ],
    [
      'an op naming an agent, open to a token, without self',
      registry({
        'test.agent': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ agent: Agent }),
        ),
      }),
      'test.agent: names an agent, open to a token, and declares no self',
    ],
    [
      'a proposing rule without destructive',
      registry(
        { 'test.delete': op({ access: both, kind: 'command', scope: 'none', rules: ['discard'] }) },
        { rules: { discard: { kind: 'argument', sentence: 'Comes to you.' } } },
      ),
      'test.delete: may become a proposal, and declares no destructive',
    ],
    [
      'an id that isn’t branded',
      registry({
        'test.id': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ to: z.union([z.string().max(9), z.literal('manager')]) }),
        ),
      }),
      'test.id: .to is an id, not branded',
    ],
    [
      'an id behind a preprocess that isn’t branded',
      registry({
        'test.id': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ to: z.preprocess(trim, z.string().max(9)) }),
        ),
      }),
      'test.id: .to is an id, not branded',
    ],
    [
      'an op naming an agent behind a preprocess, open to a token, without self',
      registry({
        'test.agent': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ agent: z.preprocess(trim, Agent) }),
        ),
      }),
      'test.agent: names an agent, open to a token, and declares no self',
    ],
    [
      'an id put through a transform',
      registry({
        'test.id': op(
          { access: both, kind: 'read', scope: 'none', self: 'refused' },
          z.strictObject({ to: Agent.transform((id) => id.toLowerCase()) }),
        ),
      }),
      'test.id: .to puts an id through a pipe',
    ],
    [
      'an id put through a preprocess',
      registry({
        'test.id': op(
          { access: both, kind: 'read', scope: 'none', self: 'refused' },
          z.strictObject({ to: z.preprocess(trim, Agent) }),
        ),
      }),
      'test.id: .to puts an id through a pipe',
    ],
    [
      'a union of an id and a transform',
      registry({
        'test.id': op(
          { access: both, kind: 'read', scope: 'none', self: 'refused' },
          z.strictObject({ to: z.union([Agent, z.number().max(9).transform(String)]) }),
        ),
      }),
      'test.id: .to is a union of an id and a transform',
    ],
    [
      'an unbounded string',
      registry({
        'test.long': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ body: z.string() }),
        ),
      }),
      'test.long: .body is unbounded',
    ],
    [
      'an unbounded list',
      registry({
        'test.many': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ words: z.array(z.string().max(5)) }),
        ),
      }),
      'test.many: .words is unbounded',
    ],
    [
      'an unbounded map',
      registry({
        'test.map': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ values: z.record(z.string().max(5), z.number()) }),
        ),
      }),
      'test.map: .values is unbounded',
    ],
    [
      'an input whose worst case is over the request limit',
      registry({
        'test.big': op(
          { access: both, kind: 'read', scope: 'none' },
          z.strictObject({ words: z.array(z.string().max(1_000_000)).max(10) }),
        ),
      }),
      'test.big: its input may take 60000043 bytes, over MAX_REQUEST_BYTES',
    ],
    [
      'a long poll that writes',
      registry(
        { 'test.poll': op({ access: tokens, kind: 'command', scope: 'none', waits: true }) },
        { deviations: { 'test.poll': 'transport' } },
      ),
      "test.poll: waits, but isn't a read on MCP alone (the transport deviation)",
    ],
    [
      'a long poll on both surfaces',
      registry({ 'test.poll': op({ access: both, kind: 'read', scope: 'none', waits: true }) }),
      "test.poll: waits, but isn't a read on MCP alone (the transport deviation)",
    ],
    [
      'a varies field not in the result',
      registry({
        'test.varies': op({ access: both, kind: 'read', scope: 'none', varies: ['items'] }),
      }),
      'test.varies: varies by items, not in its result',
    ],
    [
      'a name that isn’t area.verb',
      registry({ 'Test.read-it': op({ access: both, kind: 'read', scope: 'none' }) }),
      'Test.read-it: not area.verb',
    ],
    [
      'a tool name over 49 characters',
      registry({ ['test.' + 'x'.repeat(45)]: op({ access: both, kind: 'read', scope: 'none' }) }),
      `test.${'x'.repeat(45)}: its tool name isn't one MCP takes`,
    ],
  ])('catches %s', (_what, wrong, problem) => {
    expect(problems(wrong)).toContain(problem);
  });

  it('accepts an op on MCP alone while it is unhosted, and bounded, branded ids', () => {
    expect(
      problems(
        registry(
          {
            'test.agent': op(
              { access: both, kind: 'command', scope: 'agent', self: 'refused' },
              z.strictObject({
                agent: Agent,
                to: z.union([Agent, z.literal('manager')]),
                words: z.array(z.string().max(5)).max(3),
              }),
            ),
          },
          { unhosted: { 'test.agent': 'B11' } },
        ),
      ),
    ).toEqual([]);
  });
});

describe('the envelope', () => {
  const surface = (more: Partial<Surface> = {}): Surface => ({
    access: { you: 'all' },
    kind: 'command',
    scope: 'none',
    ...more,
  });
  const def = {
    summary: 'A test op.',
    input: z.strictObject({ n: z.number() }),
    output: z.strictObject({ n: z.number() }),
  };

  it('gives a write a request id, and a read none', () => {
    const request = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(withEnvelope(surface(), def).input.parse({ n: 1, request })).toEqual({ n: 1, request });
    expect(
      withEnvelope(surface({ kind: 'doc' }), def).input.safeParse({ n: 1, request: 'again' })
        .success,
    ).toBe(false);
    expect(
      withEnvelope(surface({ kind: 'read' }), def).input.safeParse({ n: 1, request }).success,
    ).toBe(false);
  });

  it('lets an op that may become a proposal return { proposed }, and its outputSchema say so', () => {
    const proposing = withEnvelope(surface({ rules: ['discard'], destructive: true }), def);
    const proposed = { proposed: NeedId.parse('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b') };
    expect(proposing.output.parse(proposed)).toEqual(proposed);
    expect(proposing.output.parse({ n: 2 })).toEqual({ n: 2 });
    expect(outputSchemaOf(proposing)).toMatchObject({
      type: 'object',
      anyOf: [{ type: 'object' }, { type: 'object' }],
    });
    expect(withEnvelope(surface(), def).output.safeParse(proposed).success).toBe(false);
  });
});

/** A stable hash of a schema's JSON (FNV-1a, 64 bits). */
function hash(value: unknown): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** What surface.snap.json holds: the surfaces as each party sees them. */
function snapshot(): string {
  const tools = Object.fromEntries(
    PARTIES.filter((party) => party !== 'you').map((party) => [
      party,
      opsFor(SURFACE, party).map(toolName),
    ]),
  );
  return `${JSON.stringify(
    {
      gui: GUI_OPS.filter((name) => !(name in UNHOSTED)).map((name) => `api.${name}`),
      mcp: tools,
      counts: Object.fromEntries(
        Object.entries(tools).map(([party, names]) => [party, names.length]),
      ),
      unhosted: UNHOSTED,
      deviations: DEVIATIONS,
      schemas: Object.fromEntries(
        Object.entries(OPS).map(([name, def]) => [
          name,
          { input: hash(inputSchemaOf(def)), output: hash(outputSchemaOf(def)) },
        ]),
      ),
    },
    null,
    2,
  )}\n`;
}

describe('T2: surface.snap.json', () => {
  it('is up to date (pnpm api:surface writes it)', async () => {
    await expect(snapshot()).toMatchFileSnapshot('./surface.snap.json');
  });
});
