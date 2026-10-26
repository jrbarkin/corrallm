import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { answerUnowned } from '../core/core';
import { appProfile } from '../core/host/node';
import { ProfileLocked } from '../core/lock';
import type { LockHolder } from '../core/lock';
import { askTokenOwner } from '../core/token-socket';
import { accessText } from '../core/tokens';
import type { TokenAnswer, TokenOwner, TokenRequest } from '../core/token-socket';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { installedClis } from '../sessions/installed';
import { writeWhole } from '../whole-file';
import { nameableFile } from './args';
import type { TokenCommand } from './args';
import { shown } from './output';
import { registrations, SERVER_NAME } from './register';
import { readTokenFile } from './token-file';
import { TOKEN_FILE_VARIABLE, TOKEN_VARIABLE, URL_VARIABLE } from './wait';

/*
 * `corrallm token new|renew|revoke` (Build Plan B30; Core Server §6.7, D7): outside tokens made,
 * renewed and revoked by a person while corrallm runs, behind `serve --new-token`'s gate: only
 * with stderr on a terminal. It asks whichever corrallm owns the profile (the app's core or
 * `corrallm serve`, core.lock says) over the profile's token socket, which only the profile's user
 * can open (core/token-socket.ts), never MCP, so the token works, or stops working, at once; with
 * no owner, it writes the profile's tokens.json itself under core.lock, as `serve --new-token`
 * does (Core.answerUnowned). An owner that holds the profile but doesn't answer is waited for a
 * little (one starting up), then said. A new or renewed token is shown once, on that terminal, or,
 * with `--into <file>`, only written to that file, 0600, and never shown: its value is in no
 * argument, log or file of corrallm's (the token store keeps its hash). It says how to register
 * corrallm in each installed CLI: by the token's variable, or, given the file, by a headers helper
 * where the CLI has one, which reads the file each time it connects, so a renewal into it needs no
 * restart. `token header --from <file>` is that helper: it prints the Authorization header from
 * the file, on stdout, for the client that runs it, and needs no terminal.
 */

const NOT_A_TERMINAL =
  'corrallm token: it makes, renews and revokes tokens only on a terminal, so that a person does: run it in one, with stderr not redirected.';
/** How long it waits for an owner that holds the profile to answer: one starting up. */
const OWNER_WAIT_MS = 10 * 1000;

const BY: Readonly<Record<TokenOwner, string>> = {
  app: 'the corrallm app, which owns the profile',
  serve: 'corrallm serve, which owns the profile',
  none: 'corrallm token itself, as nothing owns the profile: the next corrallm on it serves it',
};

export interface TokenIO {
  env: NodeJS.ProcessEnv;
  /** What relative files (`--canvas`, `--into`, `--from`, `--profile`) are read against. */
  cwd: string;
  /** Where it says what it does: a terminal, which new, renew and revoke need. */
  stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
  /** Where `header` prints the header, for the client that runs it; nothing else prints there. */
  stdout: { write(text: string): unknown };
  platform?: NodeJS.Platform;
  /** How long it waits for an owner that holds the profile to answer. */
  ownerWaitMs?: number;
}

/** Runs `corrallm token`: its exit code (0 done, 1 refused or failed, saying why). */
export async function tokenCommand(command: TokenCommand, io: TokenIO): Promise<number> {
  if (command.action === 'header') return header(command.from, io);
  const say = (line: string) => {
    io.stderr.write(`${shown(line)}\n`);
  };
  if (!io.stderr.isTTY) {
    say(NOT_A_TERMINAL);
    return 1;
  }
  const profile = path.resolve(io.cwd, command.profile ?? appProfile({ env: io.env }));
  const into =
    command.action === 'revoke' || command.into === undefined
      ? undefined
      : path.resolve(io.cwd, command.into);
  if (into !== undefined) {
    // Before anything is made: a token the file can't take would replace one for nothing.
    const problem = await intoProblem(into);
    if (problem !== undefined) {
      say(`corrallm token: ${problem}`);
      return 1;
    }
  }
  const request = requestOf(command, io.cwd);
  let answer: TokenAnswer;
  try {
    answer = await ask(profile, request, {
      say,
      waitMs: io.ownerWaitMs ?? OWNER_WAIT_MS,
      ...(io.platform === undefined ? {} : { platform: io.platform }),
    });
  } catch (error) {
    say(`corrallm token: ${reasonOf(error)}`);
    return 1;
  }
  if (!answer.ok) {
    say(`corrallm token: ${answer.sentence}`);
    return 1;
  }
  if (answer.op === 'revoke') {
    say(
      `corrallm token: the token "${answer.name}" is revoked, by ${BY[answer.owner]}: its next call is refused, and a call it has going ends.`,
    );
    return 0;
  }
  let written = into;
  if (into !== undefined) {
    try {
      await writeWhole(into, `${answer.token}\n`, { mode: 0o600, durable: true });
    } catch (error) {
      // The token it replaced no longer works: this one is shown, rather than lost.
      say(
        `corrallm token: could not write the token to ${into} (${reasonOf(error)}), so it is shown instead.`,
      );
      written = undefined;
    }
  }
  const installed = await installedClis(
    agentEnvironment(await loginShellEnvironment({ env: io.env })),
  );
  const otherProfile = profile !== path.resolve(appProfile({ env: io.env }));
  for (const line of madeText(answer, request, { into: written, installed, otherProfile })) {
    say(line);
  }
  return written === into ? 0 : 1;
}

/** What to ask the profile's owner: canvases named by their files, absolute. */
function requestOf(
  command: Exclude<TokenCommand, { action: 'header' }>,
  cwd: string,
): TokenRequest {
  switch (command.action) {
    case 'new':
      return {
        version: 1,
        op: 'new',
        name: command.name,
        hours: command.hours,
        access: command.access,
        canvases: command.canvases.map((file) => path.resolve(cwd, file)),
      };
    case 'renew':
      return { version: 1, op: 'renew', name: command.name, hours: command.hours };
    case 'revoke':
      return { version: 1, op: 'revoke', name: command.name };
  }
}

/**
 * Asks the profile's owner, or, with none, answers under core.lock itself; while another holds
 * the profile without answering (starting up, or a corrallm token writing it), tries again for up
 * to `waitMs`, saying so once.
 */
async function ask(
  profile: string,
  request: TokenRequest,
  {
    say,
    waitMs,
    platform,
  }: { say: (line: string) => void; waitMs: number; platform?: NodeJS.Platform },
): Promise<TokenAnswer> {
  const until = Date.now() + waitMs;
  let waiting = false;
  for (;;) {
    const answer = await askTokenOwner(
      profile,
      request,
      platform === undefined ? {} : { platform },
    );
    if (answer !== undefined) return answer;
    try {
      return await answerUnowned(profile, request);
    } catch (error) {
      if (!(error instanceof ProfileLocked)) throw error;
      if (Date.now() >= until) {
        throw new Error(`${error.message} ${unanswered(error.holder)}`, { cause: error });
      }
      if (!waiting) {
        waiting = true;
        say(`corrallm token: ${error.message} Waiting for it to answer…`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** What to do about an owner that holds the profile and never answered. */
function unanswered(holder: LockHolder | undefined): string {
  return holder === undefined || holder.owner === 'token'
    ? 'Try again in a moment.'
    : 'It doesn’t answer corrallm token (an older corrallm, or one that couldn’t serve its token socket: it says why where it runs). Stop it, then run corrallm token again.';
}

/** Why `--into` can't take a token, if it can't: checked before one is made. */
async function intoProblem(file: string): Promise<string | undefined> {
  if (!nameableFile(file)) {
    return `--into names ${file}, whose path has a quote, backslash, $, backtick or control character, which the command that reads it can’t name: choose another.`;
  }
  const folder = path.dirname(file);
  if (!(await stat(folder).catch(() => undefined))?.isDirectory()) {
    return `${folder} isn’t a folder: make it first, or name a file in another.`;
  }
  if ((await stat(file).catch(() => undefined))?.isDirectory()) {
    return `${file} is a folder: name a file for the token.`;
  }
  try {
    await access(folder, constants.W_OK);
  } catch {
    return `${folder} can’t be written to: name a file in another folder.`;
  }
  return undefined;
}

/**
 * What a new or renewed token is said with, line by line: what it is and reaches, the token (unless
 * it was written `into` a file), and how to register corrallm in each installed CLI.
 */
function madeText(
  answer: Extract<TokenAnswer, { op: 'new' | 'renew' }>,
  request: TokenRequest,
  {
    into,
    installed,
    otherProfile,
  }: {
    into: string | undefined;
    installed: Readonly<Record<string, boolean>>;
    otherProfile: boolean;
  },
): string[] {
  const hours = request.op === 'revoke' ? 0 : request.hours;
  const reach = answer.canvases
    .map(({ id, file }) => `${file === undefined ? 'a canvas' : path.basename(file)} (${id})`)
    .join(', ');
  const until = new Date(answer.expires).toTimeString().slice(0, 5);
  const lines = [
    `corrallm token: ${answer.op === 'renew' ? 'a renewed' : 'a new'} token for "${answer.name}" (${accessText(answer.access)}, for ${String(hours)} hour${hours === 1 ? '' : 's'}, until ${until}), reaching ${reach}, made by ${BY[answer.owner]}. It replaces any earlier token named "${answer.name}" at once: that one’s next call is refused.`,
    '',
    ...(into === undefined
      ? ['It is shown only now; corrallm keeps only its hash:', '', `  ${answer.token}`, '']
      : [
          `It is written only to ${into}, which only you can read; corrallm keeps only its hash.`,
          '',
        ]),
  ];
  const { url } = answer;
  if (url === null) {
    lines.push(
      answer.owner === 'none'
        ? `Nothing serves this profile yet: corrallm serve on it prints its URL, to register corrallm at as the MCP server ${SERVER_NAME}.`
        : `${answer.unserved ?? 'Its MCP server isn’t listening.'} Once it listens, corrallm token renew names its URL, to register corrallm at as the MCP server ${SERVER_NAME}.`,
      '',
    );
    return lines;
  }
  const { byFile, byVariable } = registrations(installed, url, into);
  const indented = (commands: string[]) => commands.map((line) => `  ${line}`);
  const anyClient = `  ${url}, as the MCP server ${SERVER_NAME}, with the header Authorization: Bearer <the token, from ${TOKEN_VARIABLE}>`;
  if (into === undefined) {
    lines.push(
      `Keep it in ${TOKEN_VARIABLE} where your orchestrator runs, without echoing it (read -rs ${TOKEN_VARIABLE} && export ${TOKEN_VARIABLE}), and register corrallm by that variable, never by pasting the token:`,
      '',
      ...(byVariable.length > 0 ? indented(byVariable) : [anyClient]),
      '',
      'A client keeps the token it started with: after corrallm token renew it must start again. With --into <file>, the token goes only to a file you can read, which a client with a headers helper reads each time it connects.',
      '',
    );
  } else {
    if (byFile.length > 0) {
      lines.push(
        'Register corrallm so that it reads the token from that file each time it connects: a renewal into the same file then needs no restart.',
        '',
        ...indented(byFile),
        '',
      );
    }
    if (byVariable.length > 0 || byFile.length === 0) {
      lines.push(
        `A client that reads the token only from a variable, as it starts, takes it from the file (export ${TOKEN_VARIABLE}="$(cat "${into}")"), and must start again after a renewal:`,
        '',
        ...(byVariable.length > 0 ? indented(byVariable) : [anyClient]),
        '',
      );
    }
    lines.push(
      `corrallm wait reads the token from the file afresh at each wait: export ${TOKEN_FILE_VARIABLE}="${into}" where your orchestrator runs.`,
      '',
    );
  }
  if (otherProfile) {
    lines.push(
      `corrallm wait finds this server only by its URL: export ${URL_VARIABLE}=${url} where your orchestrator runs.`,
      '',
    );
  }
  return lines;
}

/** `corrallm token header --from <file>`: the Authorization header, as a headers helper prints it. */
async function header(from: string, io: TokenIO): Promise<number> {
  let token: string;
  try {
    token = await readTokenFile(path.resolve(io.cwd, from), io.platform);
  } catch (error) {
    io.stderr.write(`corrallm token header: ${shown(reasonOf(error))}\n`);
    return 1;
  }
  io.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
  return 0;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
