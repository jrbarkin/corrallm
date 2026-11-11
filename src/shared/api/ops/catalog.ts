import { z } from 'zod';

import { ID_PATTERN, JOBS } from '../../adapter';
import type { Catalog } from '../../adapter';
import { MAX_CONSENT_DESCRIPTION, MAX_CONSENT_TITLE, MAX_CONSENTS } from '../limits';
import { MCP_CHANGES, REWIND_RESTORES } from '../../session';
import { PromptDescriptor } from '../../model/prompts';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** The catalog (Core Server §4 A; src/shared/adapter.ts): what every adapter declares. */

/** A continuation command (B16 C2): `bare` only here, never on a session's own commands. */
const ContinuationCommand = z.strictObject({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  bare: z.literal(true).optional(),
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
  ...PromptDescriptor.shape,
  context: z.boolean(),
  api: z.enum(['http', 'channel']).nullable(),
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
      commands: z.array(ContinuationCommand),
      shell: z.boolean(),
      mcpSignIn: z.boolean(),
    })
    .optional(),
  keys: z.strictObject({ shiftEnter: z.string().nullable() }).optional(),
  shellPrefix: z.string().optional(),
  fileMentions: z.literal(true).optional(),
});

/**
 * A consent an adapter asks you for (B22a C3): words, bounded, and the connections that ask. It
 * holds no field saying whether it was given, and nothing about your account.
 */
const Consent = z.strictObject({
  key: z.string().regex(ID_PATTERN),
  title: z.string().min(1).max(MAX_CONSENT_TITLE),
  description: z.string().max(MAX_CONSENT_DESCRIPTION),
  connections: z.array(z.string()).min(1),
});

/** A registration template is at most 2 KiB. */
const MAX_REGISTER_TEMPLATE = 2048;
/**
 * Where a registration goes in the orchestrator's folder: `/`-separated segments of letters,
 * digits, `.`, `_` and `-`, none starting with `-`, none `.` or `..`.
 */
const REGISTER_IN_PATTERN =
  /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

const Adapter = z
  .strictObject({
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
    registerMcp: z.string().max(MAX_REGISTER_TEMPLATE).optional(),
    registerMcpHelper: z.string().max(MAX_REGISTER_TEMPLATE).optional(),
    registerMcpIn: z.string().max(64).regex(REGISTER_IN_PATTERN).optional(),
    registerMcpRenews: z.literal(true).optional(),
    consents: z.array(Consent).max(MAX_CONSENTS).optional(),
  })
  // Each consent by a key of its own, asked on its own adapter's connections, each named once.
  .refine(({ connections, consents = [] }) => {
    const own = new Set(connections.map(({ id }) => id));
    return (
      new Set(consents.map(({ key }) => key)).size === consents.length &&
      consents.every(
        (consent) =>
          new Set(consent.connections).size === consent.connections.length &&
          consent.connections.every((id) => own.has(id)),
      )
    );
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
    // Optional JSON fields are absent, never present with undefined.
    output: z.strictObject({
      adapters: z.array(Adapter),
      usageBackends: z.array(UsageBackend),
    }) as z.ZodType<Catalog>,
  }),
  'catalog.installed': define('catalog.installed', {
    summary:
      'Which catalog adapters have their CLI installed in the agents’ environment (reads the login shell).',
    input: z.strictObject({}),
    output: z.record(z.string().regex(ID_PATTERN), z.boolean()),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
