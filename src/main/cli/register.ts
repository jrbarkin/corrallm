import path from 'node:path';

import { CATALOG } from '../sessions/adapters';
import { nameableFile } from './args';
import { TOKEN_VARIABLE } from './wait';

/*
 * How corrallm tells a person to register its MCP server in each installed CLI (API Spec §8.5,
 * revision R36; Build Plan B30), from each adapter's own descriptor, so the platform holds no
 * CLI's syntax: `registerMcp` by the variable that holds the token, which a client reads as it
 * starts (after a renewal it must start again); `registerMcpHelper` by a headers helper, a command
 * the client runs each time it connects (and again after a 401) to read the token from a file only
 * the user can read, so a renewal into that file needs nothing. The helper is corrallm's own
 * (`corrallm token header`), and names the file, never the token.
 */

/** The name orchestrators register corrallm's MCP server under: never the agents' `corrallm`. */
export const SERVER_NAME = 'corrallm-server';

/**
 * The command that prints a token's Authorization header from `file`, for a client to run in a
 * shell: `file` absolute, with no character a shell would read in double quotes (`nameableFile`).
 */
export function headersHelper(file: string): string {
  if (!path.isAbsolute(file) || !nameableFile(file)) {
    throw new RangeError(`A token file a command names is absolute and plain, not “${file}”.`);
  }
  return `corrallm token header --from "${file}"`;
}

/** How to register corrallm in each installed CLI that says how. */
export interface Registrations {
  /** By the token's file, which the client reads each time it connects. */
  byFile: string[];
  /** By the token's variable, which the client reads as it starts. */
  byVariable: string[];
}

/**
 * The commands that register corrallm's MCP server at `url` in each installed CLI that says how:
 * by the token's variable, or, given the token's `file`, by its headers helper where the CLI has
 * one.
 */
export function registrations(
  installed: Readonly<Record<string, boolean>>,
  url: string,
  file?: string,
): Registrations {
  const helper = file === undefined ? undefined : JSON.stringify(headersHelper(file)).slice(1, -1);
  const fill = (template: string) =>
    template.replaceAll('{server}', SERVER_NAME).replaceAll('{url}', url);
  const result: Registrations = { byFile: [], byVariable: [] };
  for (const { id, registerMcp, registerMcpHelper } of CATALOG.adapters) {
    if (installed[id] !== true) continue;
    if (helper !== undefined && registerMcpHelper !== undefined) {
      result.byFile.push(fill(registerMcpHelper).replaceAll('{helper}', helper));
    } else if (registerMcp !== undefined) {
      result.byVariable.push(fill(registerMcp).replaceAll('{var}', TOKEN_VARIABLE));
    }
  }
  return result;
}
