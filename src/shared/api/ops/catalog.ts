import { z } from 'zod';

import { JOBS } from '../../adapter';
import { MCP_CHANGES, REWIND_RESTORES } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** The catalog (Core Server §4 A; src/shared/adapter.ts): what every adapter declares. */

const Command = z.strictObject({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
});

const Mode = z.strictObject({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  asks: z.boolean(),
  rank: z.number(),
});

const Connection = z.strictObject({
  id: z.string(),
  label: z.string(),
  short: z.string(),
  description: z.string(),
  view: z.enum(['terminal', 'transcript']),
  startModes: z.array(z.string()),
  live: z.strictObject({ effort: z.boolean(), stopTask: z.boolean() }),
  panels: z.strictObject({
    resume: z.literal(true).optional(),
    mcp: z.strictObject({ changes: z.array(z.enum(MCP_CHANGES)) }).optional(),
    rewind: z.strictObject({ restores: z.array(z.enum(REWIND_RESTORES)) }).optional(),
  }),
  images: z
    .strictObject({ types: z.array(z.string()), maxBytes: z.number(), max: z.number() })
    .nullable(),
  usage: z.string().nullable(),
  continueIn: z
    .strictObject({
      connection: z.string(),
      commands: z.array(Command),
      shell: z.boolean(),
      mcpSignIn: z.boolean(),
    })
    .optional(),
  keys: z.strictObject({ shiftEnter: z.string().nullable() }).optional(),
  shellPrefix: z.string().optional(),
});

const Adapter = z.strictObject({
  id: z.string(),
  name: z.string(),
  accent: z.number(),
  logo: z.string().optional(),
  words: z.strictObject({ defaults: z.string(), mcpHint: z.string().optional() }),
  modes: z.array(Mode),
  runtimeModes: z.boolean(),
  role: z.enum(['append', 'append-new', 'none']),
  resume: z.boolean(),
  list: z.boolean(),
  actions: z.array(
    z.strictObject({ name: z.string(), description: z.string(), job: z.enum(JOBS).optional() }),
  ),
  connections: z.array(Connection),
  registerMcp: z.string().optional(),
});

const UsageBackend = z.strictObject({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  windows: z.array(z.strictObject({ id: z.string(), label: z.string(), lengthMs: z.number() })),
});

export const catalogOps = {
  'catalog.get': define('catalog.get', {
    summary:
      'The catalog: every adapter corrallm runs agents with (its connections, modes and the ' +
      'actions its steps can name) and the usage backends their connections spend.',
    input: z.strictObject({}),
    output: z.strictObject({ adapters: z.array(Adapter), usageBackends: z.array(UsageBackend) }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
