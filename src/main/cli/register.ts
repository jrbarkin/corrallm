import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CORRALLM_MCP_SERVER } from '../../shared/session';

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
 * (`corrallm token header`), and names the file, never the token. A registration that is text for
 * a file in the orchestrator's own folder (`registerMcpIn`) is printed, never written: corrallm
 * writes no other tool's settings, and none registers user-wide.
 */

/** The name orchestrators register corrallm's MCP server under: never the agents' `corrallm`. */
export const SERVER_NAME = CORRALLM_MCP_SERVER;

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

/** One way to register corrallm in one CLI: a command to run, or text for a file in a folder. */
export interface Registration {
  /** The CLI's display name, from its adapter's descriptor. */
  name: string;
  /** The command, or the text to add to `in`; filled, and never holding a token. */
  text: string;
  /** Where the text goes, relative to the orchestrator's folder; none: `text` is a command. */
  in?: string;
  /** Whether its client reads a renewed token again with no restart. */
  renews: boolean;
}

/** How to register corrallm in each installed CLI that says how. */
export interface Registrations {
  /** By the token's file, which the client reads each time it connects. */
  byFile: Registration[];
  /** By the token's variable, which the client reads as it starts. */
  byVariable: Registration[];
}

/**
 * How to register corrallm's MCP server at `url` in each installed CLI that says how: by the
 * token's variable, or, given the token's `file`, by its headers helper where the CLI has one.
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
  for (const adapter of CATALOG.adapters) {
    const { id, name, registerMcp, registerMcpHelper } = adapter;
    if (installed[id] !== true) continue;
    const base = {
      name,
      renews: adapter.registerMcpRenews === true,
      ...(adapter.registerMcpIn === undefined ? {} : { in: adapter.registerMcpIn }),
    };
    if (helper !== undefined && registerMcpHelper !== undefined) {
      result.byFile.push({
        ...base,
        text: fill(registerMcpHelper).replaceAll('{helper}', helper),
      });
    } else if (registerMcp !== undefined) {
      // By its variable, a client reads the token only as it starts, whatever else it can do.
      result.byVariable.push({
        ...base,
        renews: false,
        text: fill(registerMcp).replaceAll('{var}', TOKEN_VARIABLE),
      });
    }
  }
  return result;
}

/**
 * The lines that show registrations, indented: a command as it is, and text for a file with where
 * it goes in the orchestrator's folder (corrallm prints it and never writes it).
 */
export function registrationLines(list: readonly Registration[]): string[] {
  const lines: string[] = [];
  for (const registration of list) {
    if (lines.length > 0) lines.push('');
    if (registration.in === undefined) {
      lines.push(...registration.text.split('\n').map((line) => `  ${line}`));
    } else {
      lines.push(
        `  ${registration.name}: in your orchestrator’s folder, add this to ${registration.in} (corrallm doesn’t write it):`,
        '',
        ...registration.text.split('\n').map((line) => `    ${line}`),
      );
    }
  }
  return lines;
}

/**
 * The shipped command's launcher, `bin/corrallm` beside the bundle's `cli/`, as a real path; none
 * for a checkout's build, which ships no launcher.
 */
export function commandLauncher(bundle: string): string | undefined {
  try {
    const launcher = realpathSync(path.join(path.dirname(bundle), '..', 'bin', 'corrallm'));
    return statSync(launcher).isFile() ? launcher : undefined;
  } catch {
    return undefined;
  }
}

/** The first `corrallm` on `searchPath` (absolute folders only), as a real path. */
function firstOnPath(searchPath: string): string | undefined {
  for (const folder of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(folder)) continue;
    try {
      const found = realpathSync(path.join(folder, 'corrallm'));
      if (statSync(found).isFile()) return found;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

/**
 * Why the helper the by-file registrations name, `corrallm token header`, wouldn't run as
 * `corrallm` in the client's shell, if it wouldn't: said in words, and never fixed. `launcher` is
 * this command's (`commandLauncher`).
 */
export function helperProblem(
  searchPath: string,
  launcher: string | undefined,
): string | undefined {
  const first = firstOnPath(searchPath);
  if (first === undefined) {
    return `Your PATH has no corrallm command, so this helper can’t run: install it from ${launcher === undefined ? 'a packaged corrallm’s' : 'corrallm’s'} Settings first.`;
  }
  if (launcher === undefined || first === launcher) return undefined;
  return `\`corrallm\` on your PATH is another program (${first}), so this helper would run that: install corrallm’s from its Settings, or put it first.`;
}
