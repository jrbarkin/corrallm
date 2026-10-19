import { z } from 'zod';

import type { JsonSchema } from '../session';
import type { OpDef } from './define';
import { appOps } from './ops/app';
import { catalogOps } from './ops/catalog';
import { conversationOps } from './ops/conversation';
import { linkOps } from './ops/link';
import { runOps } from './ops/run';
import { sessionOps } from './ops/session';
import { settingsOps } from './ops/settings';
import { terminalOps } from './ops/terminal';
import { usageOps } from './ops/usage';
import { windowOps } from './ops/window';
import type { OpName, Party, Surface } from './surface';

/*
 * The registry: every operation's schemas (ops/*.ts), keyed as the surface lists them, and how an
 * op is named and listed on MCP. The compiler refuses an op missing here; each ops file refuses one
 * the surface doesn't list.
 */

export const OPS = {
  ...appOps,
  ...catalogOps,
  ...conversationOps,
  ...sessionOps,
  ...settingsOps,
  ...runOps,
  ...usageOps,
  ...linkOps,
  ...windowOps,
  ...terminalOps,
} satisfies Record<OpName, OpDef>;

/** What op `N` takes, once parsed. */
export type ArgsOf<N extends OpName> = z.output<(typeof OPS)[N]['input']>;
/** What op `N` returns. */
export type ResultOf<N extends OpName> = z.output<(typeof OPS)[N]['output']>;

/** The operations `party` may call, by name, sorted: the tools MCP lists to it. */
export function opsFor(surface: Readonly<Record<string, Surface>>, party: Party): string[] {
  return Object.keys(surface)
    .filter((name) => surface[name] !== undefined && party in surface[name].access)
    .sort();
}

/** An op's MCP tool name: `area.verb` becomes `area_verb`. */
export function toolName(name: string): string {
  return name.replace('.', '_');
}

/** An op's arguments as a JSON Schema: exactly what zod makes of its input, as MCP lists it. */
export function inputSchemaOf(def: OpDef): JsonSchema {
  return z.toJSONSchema(def.input, { io: 'input' });
}

/**
 * An op's result as a JSON Schema. MCP wants an object at its root, so a result that may be a
 * proposal instead (a union of objects) says so at its root too.
 */
export function outputSchemaOf(def: OpDef): JsonSchema {
  const schema = z.toJSONSchema(def.output);
  return 'type' in schema ? schema : { type: 'object', ...schema };
}

/** How MCP lists an operation. */
export interface ToolListing {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

/** Operation `name` as MCP lists it: its tool name, summary, schemas, and hints from its kind. */
export function toolOf(name: string, def: OpDef, surface: Surface): ToolListing {
  return {
    name: toolName(name),
    description: def.summary,
    inputSchema: inputSchemaOf(def),
    outputSchema: outputSchemaOf(def),
    annotations: {
      readOnlyHint: surface.kind === 'read',
      destructiveHint: surface.destructive === true,
    },
  };
}
