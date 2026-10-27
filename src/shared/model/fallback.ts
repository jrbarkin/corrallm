import { z } from 'zod';

import { adapterIn, connectionIn, ID_PATTERN } from '../adapter';
import type { Catalog, UsageBackendId } from '../adapter';
import { EFFORT_PATTERN, MODEL_PATTERN } from '../session';
import type { AgentData } from './canvas';

const Id = z.string().max(32).regex(ID_PATTERN);
const Model = z.string().max(200).regex(MODEL_PATTERN);
const Effort = z.string().max(40).regex(EFFORT_PATTERN);

/** A configured endpoint, with its connection resolved before it is kept. */
export const FallbackStepSchema = z.strictObject({
  adapter: Id,
  connection: Id,
  model: Model.optional(),
  effort: Effort.optional(),
});
export type FallbackStep = z.infer<typeof FallbackStepSchema>;

/** Input only: a missing connection means the adapter's first at the time of the edit. */
export const FallbackStepInputSchema = FallbackStepSchema.extend({ connection: Id.optional() });
export const FallbackInputSchema = z.strictObject({
  to: z.array(FallbackStepInputSchema).min(1).max(3),
  back: z.literal('return').optional(),
});
export type FallbackInput = z.infer<typeof FallbackInputSchema>;

const Position = z.strictObject({
  step: z.int().min(0).max(2),
  from: FallbackStepSchema,
  kept: z
    .strictObject({ model: Model.nullable().optional(), effort: Effort.nullable().optional() })
    .optional(),
  why: z.enum(['usage-limit', 'rule']),
  at: z.int().nonnegative(),
});

/** File shape: unknown catalog ids survive, but no extra fields or ambiguous endpoints do. */
export const FallbackSchema = z
  .strictObject({
    to: z.array(FallbackStepSchema).min(1).max(3),
    back: z.literal('return').optional(),
    on: Position.optional(),
  })
  .refine(
    (value) =>
      value.to.every(
        (step, index) => value.to.findIndex((other) => sameStep(step, other)) === index,
      ) &&
      (value.on === undefined ||
        (value.on.step < value.to.length &&
          value.to.every((step) => !sameStep(step, value.on?.from)))),
    'Fallback endpoints must be distinct and its position must name a step',
  );
export type Fallback = z.infer<typeof FallbackSchema>;

/** The endpoint an agent's document names, without resolving native defaults or starting it. */
export function endpointOf(
  agent: Pick<AgentData, 'adapter' | 'connection' | 'settings'>,
  catalog: Catalog,
  defaultAdapter: string,
): FallbackStep | undefined {
  const adapter = agent.adapter ?? defaultAdapter;
  const connection = agent.connection ?? adapterIn(catalog, adapter)?.connections[0]?.id;
  if (connection === undefined) return undefined;
  const settings = Object.hasOwn(agent.settings ?? {}, adapter)
    ? agent.settings?.[adapter]
    : undefined;
  return {
    adapter,
    connection,
    ...(settings?.model === undefined ? {} : { model: settings.model }),
    ...(settings?.effort === undefined ? {} : { effort: settings.effort }),
  };
}

/** Config input, admitted by catalog membership and distinct from the agent's own endpoint. */
export function parseFallback(value: unknown, catalog: Catalog, own?: FallbackStep): Fallback {
  const input = FallbackInputSchema.parse(value);
  const to = input.to.map((step): FallbackStep => {
    const adapter = adapterIn(catalog, step.adapter);
    const connection = step.connection ?? adapter?.connections[0]?.id;
    if (connection === undefined || !adapter?.connections.some((one) => one.id === connection))
      throw new TypeError('A fallback step must name an available adapter and its connection');
    return { ...step, connection };
  });
  const fallback = FallbackSchema.parse({
    to,
    ...(input.back === undefined ? {} : { back: input.back }),
  });
  if (own !== undefined && to.some((step) => sameStep(step, own)))
    throw new TypeError('The agent’s own endpoint and fallback steps must be distinct');
  return fallback;
}

export function sameStep(a: FallbackStep, b: FallbackStep | undefined): boolean {
  return (
    a.adapter === b?.adapter &&
    a.connection === b.connection &&
    a.model === b.model &&
    a.effort === b.effort
  );
}

/** Stored unknown ids survive; a known connection still cannot name a different owner. */
export function readFallback(value: unknown, catalog: Catalog, own?: FallbackStep): Fallback {
  const fallback = FallbackSchema.parse(value);
  for (const step of [...fallback.to, ...(fallback.on === undefined ? [] : [fallback.on.from])]) {
    const owner = connectionIn(catalog, step.connection)?.adapter.id;
    if (owner !== undefined && owner !== step.adapter)
      throw new TypeError('A fallback connection belongs to another adapter');
  }
  const origin = fallback.on?.from ?? own;
  if (origin !== undefined && fallback.to.some((step) => sameStep(step, origin)))
    throw new TypeError('The agent’s own endpoint and fallback steps must be distinct');
  return fallback;
}

/** Canonical field order, including the run position; array order remains significant. */
export function sameFallback(a: Fallback | undefined, b: Fallback | undefined): boolean {
  return (
    JSON.stringify(a === undefined ? undefined : FallbackSchema.parse(a)) ===
    JSON.stringify(b === undefined ? undefined : FallbackSchema.parse(b))
  );
}

/** Shape only: actual parent, symlink, ownership and replacement checks belong to C's exporter. */
export const HandoffFileSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (path) =>
      path.endsWith('.md') &&
      path
        .split('/')
        .every(
          (part) =>
            /^[A-Za-z0-9._ -]+$/.test(part) &&
            part !== '.' &&
            part !== '..' &&
            !part.startsWith('-') &&
            part.toLowerCase() !== '.git',
        ),
    'A handoff file must be a bounded relative Markdown path',
  );
const HandoffAt = z.int().min(10).max(95);
export const HandoffSettingsSchema = z.strictObject({
  off: z.literal(true).optional(),
  at: HandoffAt.optional(),
  file: HandoffFileSchema.optional(),
});
export type HandoffSettings = z.infer<typeof HandoffSettingsSchema>;
export const HandoffInputSchema = HandoffSettingsSchema.extend({
  file: HandoffFileSchema.nullable().optional(),
});

/** Null is the default settings; a null file means no export. Neither is stored as null. */
export function parseHandoff(value: unknown): HandoffSettings | undefined {
  if (value === null) return undefined;
  const { file, ...settings } = HandoffInputSchema.parse(value);
  return { ...settings, ...(file == null ? {} : { file }) };
}

export function sameHandoff(
  a: HandoffSettings | undefined,
  b: HandoffSettings | undefined,
): boolean {
  return (
    JSON.stringify(a === undefined ? undefined : HandoffSettingsSchema.parse(a)) ===
    JSON.stringify(b === undefined ? undefined : HandoffSettingsSchema.parse(b))
  );
}

export const SessionContextSchema = z.strictObject({
  used: z.int().nonnegative(),
  window: z.int().positive(),
  compactAt: z.int().positive().nullable(),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;
export const HANDOFF_RESERVE = 20_000;

/** Whole tokens on the connection's own reported basis; a small window asks at zero, never below. */
export function askPoint(at: number, context: SessionContext): number {
  HandoffAt.parse(at);
  const { window, compactAt } = SessionContextSchema.parse(context);
  const share = Number((BigInt(window) * BigInt(at)) / 100n);
  return Math.max(0, Math.min(share, compactAt === null ? share : compactAt - HANDOFF_RESERVE));
}

/** C supplies a snapshot of durable exhaustion and holding, real non-warn rule readings. */
export interface FallbackHeld {
  why: 'usage-limit' | 'rule';
  resetsAt: number | null;
}
export interface FallbackPassed {
  step: FallbackStep;
  why: 'already-on' | 'unavailable' | FallbackHeld['why'];
  resetsAt?: number | null;
}
export type FallbackNext =
  { step: FallbackStep; passed: FallbackPassed[] } | { none: FallbackPassed[] };

/** The caller resolves the current adapter/connection. Only the suffix, then on.from once. */
export function next(
  agent: Pick<AgentData, 'fallback' | 'settings'> & Pick<FallbackStep, 'adapter' | 'connection'>,
  catalog: Catalog,
  held: ReadonlyMap<UsageBackendId, FallbackHeld>,
): FallbackNext {
  if (agent.fallback === undefined) return { none: [] };
  const fallback = FallbackSchema.parse(agent.fallback);
  const current = endpointOf(agent, catalog, agent.adapter);
  const candidates = fallback.to.slice(fallback.on === undefined ? 0 : fallback.on.step + 1);
  if (fallback.on !== undefined) candidates.push(fallback.on.from);
  const passed: FallbackPassed[] = [];
  for (const step of candidates) {
    if (sameStep(step, current)) {
      passed.push({ step, why: 'already-on' });
      continue;
    }
    const connection = adapterIn(catalog, step.adapter)?.connections.find(
      (one) => one.id === step.connection,
    );
    if (connection === undefined) {
      passed.push({ step, why: 'unavailable' });
      continue;
    }
    const hold = connection.usage === null ? undefined : held.get(connection.usage);
    if (hold !== undefined) {
      passed.push({ step, ...hold });
      continue;
    }
    return { step, passed };
  }
  return { none: passed };
}

/** Resolve a declared action or an unambiguous shared catalog job for one send, never editing a queue. */
export function resolveAction(
  action: string,
  adapter: string,
  catalog: Catalog,
): { action: string } | { unknown: true } {
  const target = adapterIn(catalog, adapter);
  if (target?.actions.some((one) => one.name === action)) return { action };
  const jobs = new Set(
    catalog.adapters.flatMap((one) =>
      one.actions.filter((declared) => declared.name === action).map((declared) => declared.job),
    ),
  );
  if (jobs.size !== 1 || jobs.has(undefined)) return { unknown: true };
  const [job] = jobs;
  const equivalent = target?.actions.find((one) => one.job === job);
  return equivalent === undefined ? { unknown: true } : { action: equivalent.name };
}
