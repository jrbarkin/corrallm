import { z } from 'zod';

import { EntityKey, NeedId } from './ids';
import { MAX_EXPECT } from './limits';
import { SURFACE } from './surface';
import type { OpName, Rule, Surface } from './surface';

/** Schema preparation needs only envelope metadata, never an unregistered audience or scope. */
export type Envelope = Pick<Surface, 'kind' | 'rules'>;

/*
 * An operation's schemas, beside its surface (Core Server §3.1). `define` adds the envelope its
 * surface calls for, so no op declares it itself: a write takes a `request` id, which core.call
 * dedupes per caller, and returns the topic revisions it reached (`revs`, which core.call adds); a
 * doc op takes the revisions it expects of the entities it changes (`expect`), and is refused as a
 * conflict if any has another (B9 Design §6); an op carrying a rule that may make a token's call a
 * proposal for you (R4, R5) returns its result or `{ proposed }`, and its MCP outputSchema covers
 * both.
 */

/** What an op does, in a sentence (its MCP description), and its arguments' and result's schemas. */
export interface OpDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly summary: string;
  readonly input: I;
  readonly output: O;
}

/** An op's arguments: always one object, refusing keys it doesn't name. */
export type Input = z.ZodObject<z.core.$ZodShape, z.core.$strict>;

/** The rules that make a token's call a proposal for you instead of applying it: R4 and R5. */
export const PROPOSING_RULES: readonly Rule[] = ['discard', 'restore-code'];

/** What an op returns when a token's call became a proposal for you (Core Server §6.9). */
export const Proposed = z.strictObject({ proposed: NeedId });

/** What every write takes: a request id, so that a repeated call returns the first call's result. */
const REQUEST = { request: z.uuid().optional() };

/**
 * The revisions a doc op expects of entities of its canvas's document, by their keys: 0 for one
 * that isn't there. Any other refuses it as a conflict, saying what they are now.
 */
export const Expect = z
  .record(EntityKey, z.int().min(0))
  .refine((expected) => Object.keys(expected).length <= MAX_EXPECT, {
    message: `At most ${String(MAX_EXPECT)} entities`,
  })
  .meta({
    maxProperties: MAX_EXPECT,
    description:
      'The revision you read of each entity this changes, by its key (node/<id>, link/<a>/<b>, ' +
      'item/<agent>/<id>; 0: none). If one has changed since, nothing is changed: the call is a ' +
      'conflict, saying what each is now.',
  });

/** What every doc op takes besides a request id. */
const EXPECT = { expect: Expect.optional() };

/**
 * The revision of each topic a write reached (`canvas:<id>`: its document's), by the topic's key:
 * a window resolves the call once its copy of each is there.
 */
export const Revs = z.record(z.string(), z.int().min(0));

/** What every write returns besides its result. */
const REVS = { revs: Revs };

/** An object's schema with `Shape`'s fields too. */
type Extended<O extends z.ZodType, Shape extends z.core.$ZodShape> =
  O extends z.ZodObject<infer Own, infer Config>
    ? z.ZodObject<z.core.util.Extend<Own, Shape>, Config>
    : never;

type Proposes<S extends Envelope> = S extends { rules: readonly (infer R)[] }
  ? [Extract<R, 'discard' | 'restore-code'>] extends [never]
    ? false
    : true
  : false;

/** What a write returns: its result and the revisions it reached, or a proposal. */
type Written<S extends Envelope, O extends z.ZodType> =
  Proposes<S> extends true
    ? z.ZodUnion<[Extended<O, typeof REVS>, typeof Proposed]>
    : Extended<O, typeof REVS>;

/** An op's definition with the envelope its surface `S` calls for. */
export type Enveloped<S extends Envelope, I extends Input, O extends z.ZodType> = OpDef<
  S['kind'] extends 'read'
    ? I
    : S['kind'] extends 'doc'
      ? z.ZodObject<z.core.util.Extend<I['shape'], typeof REQUEST & typeof EXPECT>, z.core.$strict>
      : z.ZodObject<z.core.util.Extend<I['shape'], typeof REQUEST>, z.core.$strict>,
  S['kind'] extends 'read' ? O : Written<S, O>
>;

/** `def` with the envelope `surface` calls for. Throws for a write whose result isn't an object. */
export function withEnvelope<S extends Envelope, I extends Input, O extends z.ZodType>(
  surface: S,
  def: OpDef<I, O>,
): Enveloped<S, I, O> {
  if (surface.kind === 'read') return def as Enveloped<S, I, O>;
  if (!(def.output instanceof z.ZodObject)) throw new Error('A write’s result is an object.');
  const proposes = surface.rules?.some((rule) => PROPOSING_RULES.includes(rule)) ?? false;
  const written = def.output.extend(REVS);
  return {
    summary: def.summary,
    input: def.input.extend(surface.kind === 'doc' ? { ...REQUEST, ...EXPECT } : REQUEST),
    output: proposes ? z.union([written, Proposed]) : written,
  } as Enveloped<S, I, O>;
}

/** The op `name`'s definition, with the envelope its surface calls for. */
export function define<N extends OpName, I extends Input, O extends z.ZodType>(
  name: N,
  def: OpDef<I, O>,
): Enveloped<(typeof SURFACE)[N], I, O>;
/** Prepare bounded schemas before their implementation/registration; this grants no access. */
export function define<S extends Envelope, I extends Input, O extends z.ZodType>(
  envelope: S,
  def: OpDef<I, O>,
): Enveloped<S, I, O>;
export function define(name: OpName | Envelope, def: OpDef<Input>): OpDef {
  return withEnvelope(typeof name === 'string' ? SURFACE[name] : name, def);
}
