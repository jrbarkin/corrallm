import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { parseRole } from '../../role';
import { EFFORT_PATTERN, MAX_ROLE_LENGTH, MODEL_PATTERN } from '../../session';
import { define } from '../define';
import { SetFallbackInput, SetHandoffInput } from '../fallback';
import type { OpDef } from '../define';
import { AgentId, OpCanvas } from '../ids';
import { MAX_LABEL } from '../limits';
import type { OpName } from '../surface';

const CatalogId = z.string().min(1).max(32).regex(ID_PATTERN);
const Settings = z.strictObject({
  model: z.string().max(MAX_LABEL).regex(MODEL_PATTERN).nullable().optional(),
  effort: z.string().max(40).regex(EFFORT_PATTERN).nullable().optional(),
  mode: CatalogId.nullable().optional(),
});
/** An agent's role: its standing instructions (src/shared/role.ts), trimmed; blank clears it. */
export const Role = z
  .string()
  .max(MAX_ROLE_LENGTH)
  .refine((role) => {
    try {
      parseRole(role);
      return true;
    } catch {
      return false;
    }
  }, 'A role must contain valid text without control characters other than tabs and line breaks.');

export const agentOps = {
  'agent.setType': define('agent.setType', {
    summary:
      'Switches an agent’s CLI, translating steps by their catalog jobs, with an optional connection.',
    input: z.strictObject({
      canvas: OpCanvas,
      agent: AgentId,
      adapter: CatalogId,
      connection: CatalogId.optional(),
    }),
    output: z.strictObject({}),
  }),
  'agent.setConnection': define('agent.setConnection', {
    summary:
      'Switches an agent’s connection, dropping a saved mode the new connection cannot start.',
    input: z.strictObject({ canvas: OpCanvas, agent: AgentId, connection: CatalogId }),
    output: z.strictObject({}),
  }),
  'agent.setFallback': define('agent.setFallback', {
    summary:
      'Sets the backends an agent carries on with when its usage runs out (up to three, each an ' +
      'adapter, its connection and optionally a model and effort; back: return to switch back ' +
      'at the reset), or null to remove them. Yours alone.',
    input: SetFallbackInput,
    output: z.strictObject({ changed: z.boolean() }),
  }),
  'agent.setHandoff': define('agent.setHandoff', {
    summary:
      'Sets when corrallm asks an agent to write its handoff: off, or at a whole percentage of its ' +
      'context window from 10 to 95 (95 when unset), and the Markdown file in its checkout its ' +
      'handoff is copied to (null: none); or null for the defaults. Yours alone.',
    input: SetHandoffInput,
    output: z.strictObject({ changed: z.boolean() }),
  }),
  'agent.setSettings': define('agent.setSettings', {
    summary: 'Merges one adapter’s saved settings: omitted fields stay; null unsets a field.',
    input: z.strictObject({
      canvas: OpCanvas,
      agent: AgentId,
      adapter: CatalogId,
      settings: Settings,
    }),
    output: z.strictObject({}),
  }),
  'agent.setRole': define('agent.setRole', {
    summary: 'Sets an agent’s role, trimming surrounding whitespace; a blank role clears it.',
    input: z.strictObject({ canvas: OpCanvas, agent: AgentId, role: Role }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
