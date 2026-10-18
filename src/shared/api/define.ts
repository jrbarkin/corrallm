import { z } from 'zod';

import { NeedId } from './ids';
import { SURFACE } from './surface';
import type { OpName, Rule, Surface } from './surface';

/*
 * An operation's schemas, beside its surface (Core Server §3.1). `define` adds the envelope its
 * surface calls for, so no op declares it itself: a write takes a `request` id, which core.call
 * dedupes per caller; an op carrying a rule that may make a token's call a proposal for you (R4,
 * R5) returns its result or `{ proposed }`, and its MCP outputSchema covers both.
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

type Proposes<S extends Surface> = S extends { rules: readonly (infer R)[] }
  ? [Extract<R, 'discard' | 'restore-code'>] extends [never]
    ? false
    : true
  : false;

/** An op's definition with the envelope its surface `S` calls for. */
export type Enveloped<S extends Surface, I extends Input, O extends z.ZodType> = OpDef<
  S['kind'] extends 'read'
    ? I
    : z.ZodObject<z.core.util.Extend<I['shape'], typeof REQUEST>, z.core.$strict>,
  Proposes<S> extends true ? z.ZodUnion<[O, typeof Proposed]> : O
>;

/** `def` with the envelope `surface` calls for. */
export function withEnvelope<S extends Surface, I extends Input, O extends z.ZodType>(
  surface: S,
  def: OpDef<I, O>,
): Enveloped<S, I, O> {
  const proposes = surface.rules?.some((rule) => PROPOSING_RULES.includes(rule)) ?? false;
  return {
    summary: def.summary,
    input: surface.kind === 'read' ? def.input : def.input.extend(REQUEST),
    output: proposes ? z.union([def.output, Proposed]) : def.output,
  } as Enveloped<S, I, O>;
}

/** The op `name`'s definition, with the envelope its surface calls for. */
export function define<N extends OpName, I extends Input, O extends z.ZodType>(
  name: N,
  def: OpDef<I, O>,
): Enveloped<(typeof SURFACE)[N], I, O> {
  return withEnvelope(SURFACE[name], def);
}
