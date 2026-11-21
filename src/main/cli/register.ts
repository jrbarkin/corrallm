import { accessSync, constants, realpathSync, statSync } from 'node:fs';
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
 * shell: its absolute token-file path is quoted as one literal word.
 */
export function headersHelper(file: string, command: readonly string[] = ['corrallm']): string {
  if (!path.isAbsolute(file) || !nameableFile(file)) {
    throw new RangeError('A token-file path is absolute, bounded and on one line.');
  }
  const bare = command.length === 1 && command[0] === 'corrallm';
  if (
    !bare &&
    (command.length < 1 || command.length > 2 || command.some((part) => !plainPath(part)))
  )
    throw new RangeError('A credential helper uses absolute executable paths.');
  const invocation = bare ? 'corrallm' : command.map(shellWord).join(' ');
  return `${invocation} token header --from ${shellPath(file)}`;
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
  command?: readonly string[],
): Registrations {
  const helper =
    file === undefined ? undefined : JSON.stringify(headersHelper(file, command)).slice(1, -1);
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
        // Command templates place the JSON contents inside a single-quoted shell word; file
        // templates keep them as string contents. The adapter owns the surrounding format.
        text: fill(registerMcpHelper).replaceAll('{helper}', () =>
          adapter.registerMcpIn === undefined ? helper.replaceAll("'", "'\\''") : helper,
        ),
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
  if (path.basename(path.dirname(bundle)) !== 'cli') return undefined;
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
    // A client may run in another folder: an earlier relative entry cannot be resolved here.
    if (!path.isAbsolute(folder)) return undefined;
    try {
      const found = realpathSync(path.join(folder, 'corrallm'));
      accessSync(found, constants.X_OK);
      if (statSync(found).isFile()) return found;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

export interface HelperInvocation {
  command: string[];
  /** Canonical code paths for the profile owner's location check, even when the name is bare. */
  files: string[];
  note?: string;
}

/** Select this running command, never another program named corrallm on the client's PATH. */
export function helperInvocation({
  searchPath,
  launcher,
  node,
  bundle,
}: {
  searchPath: string;
  launcher?: string;
  node: string;
  bundle: string;
}): HelperInvocation {
  const files =
    launcher === undefined
      ? [codePath(node, constants.X_OK), codePath(bundle, constants.R_OK)]
      : [codePath(launcher, constants.X_OK)];
  const first = firstOnPath(searchPath);
  if (launcher !== undefined && first === files[0]) return { command: ['corrallm'], files };
  return {
    command: files,
    files,
    note:
      first === undefined
        ? 'Your PATH has no verified corrallm command; the registration uses this command’s absolute invocation instead.'
        : 'The corrallm on PATH is not this command; the registration uses this command’s absolute invocation instead.',
  };
}

function plainPath(file: string): boolean {
  return path.isAbsolute(file) && nameableFile(file);
}
function codePath(file: string, permission: number): string {
  if (!plainPath(file))
    throw new Error('A credential helper needs an absolute, single-line code path.');
  const canonical = realpathSync(file);
  if (!plainPath(canonical) || !statSync(canonical).isFile())
    throw new Error('The credential helper code is not a regular file.');
  accessSync(canonical, permission);
  return canonical;
}
function shellWord(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/** A path in a shell command or export, preserving the existing spelling for plain names. */
export function shellPath(file: string): string {
  return `"${file.replace(/[\\"$`]/g, (character) => `\\${character}`)}"`;
}
