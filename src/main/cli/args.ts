import { parseArgs } from 'node:util';

import { z } from 'zod';

import { ID_PATTERN } from '../../shared/adapter';
import {
  DEFAULT_TOKEN_HOURS,
  MAX_TOKEN_CANVASES,
  MAX_TOKEN_HOURS,
  MAX_WAIT_SECONDS,
} from '../../shared/api/limits';

/*
 * The `corrallm` command's command lines (API Spec §8.6), read and checked before anything runs.
 * `serve` names its canvases by their files and never a folder: a canvas's project folder is the
 * one picked for it in the app (folder trust is the app's, decision 7), so nothing here is ever a
 * TrustedPath. `wait` takes no token: an orchestrator's token comes only from its environment.
 * Nor does `token`: it makes, renews and revokes tokens, and names canvases by their files, as
 * `serve` does; `--into` names the file a new token is written to, whose path goes into the
 * command that reads it back (`token header`), so it holds no character a shell would read.
 */

const HOURS = `<1-${String(MAX_TOKEN_HOURS)}>`;

export const USAGE = `Usage:
  corrallm serve --canvas <file> [--canvas <file>…] [--profile <dir>] [--port <n>]
                 [--new-token [--name <name>] [--hours ${HOURS}] [--read-only]]
  corrallm wait [--for <message id>] [--after <cursor>] [--timeout <seconds>]
  corrallm token new --canvas <file> [--canvas <file>…] [--name <name>] [--hours ${HOURS}]
                 [--read-only] [--into <file>] [--profile <dir>]
  corrallm token renew [--name <name>] [--hours ${HOURS}] [--into <file>] [--profile <dir>]
  corrallm token revoke [--name <name>] [--profile <dir>]
  corrallm token header --from <file>    (an MCP client's headers helper)
  corrallm dump [--profile <dir>]
  CORRALLM_NATIVE_SELFTEST=1 corrallm    (the native self-test, under plain Node)`;

/** A command line that isn't one of the command's: what is wrong with it. */
export class UsageError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'UsageError';
  }
}

/** `corrallm serve`: the canvas files to serve, and a new token to make, if asked. */
export interface ServeCommand {
  command: 'serve';
  canvases: string[];
  profile?: string;
  port?: number;
  newToken?: { name: string; hours: number; access: 'read' | 'write' };
}

/** `corrallm wait`: what for, from where, and for how long, in seconds. */
export interface WaitCommand {
  command: 'wait';
  for?: string;
  after?: string;
  timeout: number;
}

/** `corrallm dump`: inspects a profile without taking it from its owner. */
export interface DumpCommand {
  command: 'dump';
  profile?: string;
}

/**
 * `corrallm token`: a new token for canvas files, a renewal or a revoke of the live token of a
 * name, on a profile (the app's unless given); a new or renewed one written `into` a file rather
 * than shown. `header` prints the Authorization header from such a file, as an MCP client's
 * headers helper.
 */
export type TokenCommand =
  | {
      command: 'token';
      action: 'new';
      name: string;
      hours: number;
      access: 'read' | 'write';
      canvases: string[];
      into?: string;
      profile?: string;
    }
  | {
      command: 'token';
      action: 'renew';
      name: string;
      hours: number;
      into?: string;
      profile?: string;
    }
  | { command: 'token'; action: 'revoke'; name: string; profile?: string }
  | { command: 'token'; action: 'header'; from: string };

export type Command = ServeCommand | WaitCommand | TokenCommand | DumpCommand;

/** Reads a command line (after `corrallm`); throws UsageError, saying why, if it isn't one. */
export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  switch (command) {
    case 'serve':
      return parseServe(rest);
    case 'wait':
      return parseWait(rest);
    case 'token':
      return parseToken(rest);
    case 'dump': {
      const { values } = read(rest, { profile: { type: 'string' } });
      return { command, ...(values.profile === undefined ? {} : { profile: values.profile }) };
    }
    case undefined:
      throw new UsageError('Name a command: serve, wait, token or dump.');
    default:
      throw new UsageError(`corrallm has no command “${command}”: serve, wait, token or dump.`);
  }
}

function parseToken(argv: string[]): TokenCommand {
  const [action, ...rest] = argv;
  const profileOf = (profile: string | undefined) => (profile === undefined ? {} : { profile });
  const intoOf = (into: string | undefined) => (into === undefined ? {} : { into: intoFile(into) });
  switch (action) {
    case 'new': {
      const { values } = read(rest, {
        canvas: { type: 'string', multiple: true },
        name: { type: 'string' },
        hours: { type: 'string' },
        'read-only': { type: 'boolean' },
        into: { type: 'string' },
        profile: { type: 'string' },
      });
      const canvases = values.canvas ?? [];
      if (canvases.length === 0) {
        throw new UsageError('Name the canvases the token reaches, each with --canvas <file>.');
      }
      if (canvases.length > MAX_TOKEN_CANVASES) {
        throw new UsageError(
          `A token reaches ${String(MAX_TOKEN_CANVASES)} canvases at most: name fewer with --canvas.`,
        );
      }
      return {
        command: 'token',
        action,
        name: tokenName(values.name),
        hours: tokenHours(values.hours),
        access: values['read-only'] === true ? 'read' : 'write',
        canvases,
        ...intoOf(values.into),
        ...profileOf(values.profile),
      };
    }
    case 'renew': {
      const { values } = read(rest, {
        name: { type: 'string' },
        hours: { type: 'string' },
        into: { type: 'string' },
        profile: { type: 'string' },
        canvas: { type: 'string', multiple: true },
        'read-only': { type: 'boolean' },
      });
      if (values.canvas !== undefined || values['read-only'] !== undefined) {
        throw new UsageError(
          'renew keeps the token’s canvases and access: for others, make a new token with corrallm token new, which replaces it too.',
        );
      }
      return {
        command: 'token',
        action,
        name: tokenName(values.name),
        hours: tokenHours(values.hours),
        ...intoOf(values.into),
        ...profileOf(values.profile),
      };
    }
    case 'revoke': {
      const { values } = read(rest, { name: { type: 'string' }, profile: { type: 'string' } });
      return {
        command: 'token',
        action,
        name: tokenName(values.name),
        ...profileOf(values.profile),
      };
    }
    case 'header': {
      const { values } = read(rest, { from: { type: 'string' } });
      if (values.from === undefined || values.from === '') {
        throw new UsageError('Name the file the token is in, with --from <file>.');
      }
      return { command: 'token', action, from: values.from };
    }
    case undefined:
      throw new UsageError('Say what to do with a token: new, renew or revoke.');
    default:
      throw new UsageError(`corrallm token has no “${action}”: new, renew or revoke.`);
  }
}

/** A token's name, as given (`orchestrator` by default): an id, or UsageError. */
function tokenName(given: string | undefined): string {
  const name = given ?? 'orchestrator';
  if (!ID_PATTERN.test(name)) {
    throw new UsageError(
      `--name is a letter, then up to 31 letters, digits, dots, dashes or underscores, not “${name}”.`,
    );
  }
  return name;
}

/** How long a token lasts, as given (DEFAULT_TOKEN_HOURS by default), or UsageError. */
function tokenHours(given: string | undefined): number {
  const hours = given === undefined ? DEFAULT_TOKEN_HOURS : whole(given);
  if (hours === undefined || hours < 1 || hours > MAX_TOKEN_HOURS) {
    throw new UsageError(
      `--hours is how long the token lasts: 1 to ${String(MAX_TOKEN_HOURS)} hours, not “${given ?? ''}”.`,
    );
  }
  return hours;
}

/**
 * Whether a path can be named in the command that reads a token back: none of a shell's quotes,
 * escapes or expansions, nor a control character (`--into`, which `token` checks again once it is
 * absolute).
 */
export function nameableFile(file: string): boolean {
  return file !== '' && !/['"\\$`\p{Cc}]/u.test(file);
}

function intoFile(into: string): string {
  if (!nameableFile(into)) {
    throw new UsageError(
      `--into is a file whose path has no quote, backslash, $, backtick or control character (a command names it), not “${into}”.`,
    );
  }
  return into;
}

function parseServe(argv: string[]): ServeCommand {
  const { values } = read(argv, {
    canvas: { type: 'string', multiple: true },
    profile: { type: 'string' },
    port: { type: 'string' },
    'new-token': { type: 'boolean' },
    name: { type: 'string' },
    hours: { type: 'string' },
    'read-only': { type: 'boolean' },
  });
  const canvases = values.canvas ?? [];
  if (canvases.length === 0) {
    throw new UsageError('Name the canvases to serve, each with --canvas <file>.');
  }
  const port = values.port === undefined ? undefined : whole(values.port);
  if (values.port !== undefined && (port === undefined || port > 65535)) {
    throw new UsageError(`--port is a port, 0 to 65535 (0: any free one), not “${values.port}”.`);
  }
  const tokenOnly = (['name', 'hours', 'read-only'] as const).filter(
    (option) => values[option] !== undefined,
  );
  if (values['new-token'] !== true && tokenOnly.length > 0) {
    throw new UsageError(`--${tokenOnly.join(', --')} only go with --new-token.`);
  }
  let newToken: ServeCommand['newToken'];
  if (values['new-token'] === true) {
    newToken = {
      name: tokenName(values.name),
      hours: tokenHours(values.hours),
      access: values['read-only'] === true ? 'read' : 'write',
    };
  }
  return {
    command: 'serve',
    canvases,
    ...(values.profile === undefined ? {} : { profile: values.profile }),
    ...(port === undefined ? {} : { port }),
    ...(newToken === undefined ? {} : { newToken }),
  };
}

function parseWait(argv: string[]): WaitCommand {
  const { values } = read(argv, {
    for: { type: 'string' },
    after: { type: 'string' },
    timeout: { type: 'string' },
  });
  if (values.for !== undefined && !z.uuid().safeParse(values.for).success) {
    throw new UsageError(`--for is a message’s id, not “${values.for}”.`);
  }
  if (values.after !== undefined && (values.after === '' || values.after.length > 4096)) {
    throw new UsageError('--after is a cursor corrallm gave (a `next`).');
  }
  const timeout = values.timeout === undefined ? MAX_WAIT_SECONDS : whole(values.timeout);
  if (timeout === undefined || timeout > MAX_WAIT_SECONDS) {
    throw new UsageError(
      `--timeout is how long to wait: 0 to ${String(MAX_WAIT_SECONDS)} seconds, not “${values.timeout ?? ''}”.`,
    );
  }
  return {
    command: 'wait',
    ...(values.for === undefined ? {} : { for: values.for }),
    ...(values.after === undefined ? {} : { after: values.after }),
    timeout,
  };
}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

/** Reads `argv` as `options`, with no other options and no other words, or throws UsageError. */
function read<O extends NonNullable<Options>>(argv: string[], options: O) {
  try {
    const parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
    const [extra] = parsed.positionals;
    if (extra !== undefined) throw new UsageError(`Unexpected “${extra}” on the command line.`);
    return parsed;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** A whole number of 0 or more, as typed: undefined if it isn't one. */
function whole(text: string): number | undefined {
  return /^\d{1,9}$/.test(text) ? Number(text) : undefined;
}
