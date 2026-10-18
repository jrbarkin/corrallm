import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { CanvasId } from '../../shared/canvas';
import { agentOf } from '../../shared/model/messages';
import type { Message, PartyId } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import { threadTitle } from '../../shared/model/session';
import type { TurnResult } from '../../shared/session';
import { startApiServer } from '../api/mcp';
import type { ApiServer } from '../api/mcp';
import { createCore } from '../core/core';
import type { Core } from '../core/core';
import { appProfile, NODE_HOST } from '../core/host/node';
import { lockProfile, ProfileLocked } from '../core/lock';
import type { ProfileLock } from '../core/lock';
import { partyName } from '../core/parties';
import { CATALOG } from '../sessions/adapters';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { installedClis } from '../sessions/installed';
import { removeApiFile, writeApiFile } from './api-file';
import type { ServeCommand } from './args';
import { TOKEN_VARIABLE } from './wait';

/*
 * `corrallm serve` (API Spec §8.6, §8.7; Core Server §7.6): corrallm's core under plain Node, with
 * its MCP server on 127.0.0.1, for orchestrators outside corrallm. It owns the profile while it
 * runs (core.lock), and serves only canvases the app keeps: each --canvas file must be the one
 * canvases.json names for the canvas it holds, with the project folder picked for it in the app,
 * since a command line, which an agent can type as easily as you, never grants folder trust. Each
 * run restores paused, which holds only the run's own sends, so orchestrators' messages still reach
 * idle agents. It listens on --port, else the port the profile keeps (chosen free once), writes
 * api.json, and says on stderr each message, reply and thing newly waiting for an answer.
 * --new-token makes an outside token for the canvases named, shown once, on a terminal only, with
 * how to register corrallm by its variable in each installed CLI that says how (its adapter's
 * `registerMcp`). Told to stop (SIGINT, SIGTERM, SIGHUP), it holds each run where it is, journals,
 * ends its sessions, writes out what it keeps, removes api.json and lets the profile go.
 */

/** The name orchestrators register corrallm's MCP server under: never the agents' `corrallm`. */
export const SERVER_NAME = 'corrallm-outside';

const NOT_A_TERMINAL =
  'corrallm serve: --new-token prints a token only to a terminal, so that a person sees it once: run it in one, with stderr not redirected.';

export interface ServeIO {
  env: NodeJS.ProcessEnv;
  /** Where it says what it does: a terminal, or not (a new token is printed only to one). */
  stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
  /** Which app this is, as app.info says. */
  app: { name: string; version: string };
  /** Resolves once the process is told to stop. */
  stopped: Promise<unknown>;
}

/** Runs `corrallm serve` until it is told to stop: its exit code (0 once stopped cleanly). */
export async function serveCommand(command: ServeCommand, io: ServeIO): Promise<number> {
  const say = (line: string) => {
    io.stderr.write(`${line}\n`);
  };
  if (command.newToken && !io.stderr.isTTY) {
    say(NOT_A_TERMINAL);
    return 1;
  }
  const profile = path.resolve(command.profile ?? appProfile({ env: io.env }));
  await mkdir(profile, { recursive: true });
  let lock: ProfileLock;
  try {
    lock = await lockProfile(profile, 'serve');
  } catch (error) {
    if (!(error instanceof ProfileLocked)) throw error;
    const advice =
      error.holder === undefined
        ? 'Try again in a moment.'
        : error.holder.owner === 'app'
          ? 'Quit it first, or serve another profile with --profile.'
          : 'Stop it first (Ctrl-C where it runs).';
    say(`corrallm serve: ${error.message} ${advice}`);
    return 1;
  }
  let wroteApi = false;
  // Whatever happens, a process that ends lets the profile go.
  const leave = () => {
    if (wroteApi) removeApiFile(profile);
    lock.release();
  };
  process.once('exit', leave);

  let core: Core | undefined;
  let server: ApiServer | undefined;
  /** Serves until told to stop: 0, or 1 if it can't start. */
  const serving = async (): Promise<number> => {
    const opened = await createCore(
      { profile, app: io.app, check: false, distribution: CORRALLM_DISTRIBUTION },
      NODE_HOST,
    );
    core = opened;
    const names = new Map<CanvasId, string>();
    for (const file of command.canvases) {
      try {
        names.set(await opened.openFile(file), path.basename(file));
      } catch (error) {
        say(`corrallm serve: ${reasonOf(error)}`);
        return 1;
      }
    }

    const kept = command.port === undefined ? await opened.settings.apiPort() : undefined;
    const port = command.port ?? kept ?? 0;
    try {
      server = await startApiServer({
        core: opened,
        clientOf: (token) => opened.tokens.clientOf(token),
        port,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EADDRINUSE') throw error;
      say(
        `corrallm serve: port ${String(port)} is taken: another program listens on it. Stop it, or serve on another port with --port (and register corrallm there again).` +
          (kept === undefined
            ? ''
            : ' If you didn’t expect that, make a new token: an orchestrator that calls this port gives its token to whatever listens there.'),
      );
      return 1;
    }
    const { url } = server;
    if (command.port === undefined && kept === undefined) {
      await opened.settings.keepApiPort(server.port);
    }

    if (command.newToken) {
      const token = await opened.tokens.create({
        ...command.newToken,
        canvases: [...names.keys()],
      });
      const installed = await installedClis(
        agentEnvironment(await loginShellEnvironment({ env: io.env })),
      );
      say(tokenText(token, command.newToken, [...names.values()], url, installed));
    }

    await writeApiFile(profile, { url, port: server.port, pid: process.pid });
    wroteApi = true;
    opened.watch({
      message: (message) => {
        say(messageLine(opened, names, message));
      },
      need: (canvas, item) => {
        say(needLine(opened, names, canvas, item));
      },
    });
    say(
      `corrallm serve: serving ${[...names.values()].join(', ')} at ${url}, on the profile ${profile}. Ctrl-C stops it.`,
    );
    await io.stopped;
    say('corrallm serve: stopping…');
    return 0;
  };

  let code: number;
  try {
    code = await serving();
  } finally {
    await server?.close();
    // Each run held where it is, journaled, every session ended, what the core keeps written out.
    const closed = await core?.close().then(
      () => true,
      (error: unknown) => {
        say(`corrallm serve: ${reasonOf(error)}`);
        return false;
      },
    );
    if (closed === false) code = 1;
    process.removeListener('exit', leave);
    leave();
  }
  return code;
}

/** The commands that register corrallm's MCP server by the token's variable, in each installed CLI. */
export function registrations(installed: Readonly<Record<string, boolean>>, url: string): string[] {
  return CATALOG.adapters.flatMap(({ id, registerMcp }) =>
    registerMcp === undefined || installed[id] !== true
      ? []
      : [
          registerMcp
            .replaceAll('{server}', SERVER_NAME)
            .replaceAll('{url}', url)
            .replaceAll('{var}', TOKEN_VARIABLE),
        ],
  );
}

/** What --new-token prints, once: the token, where to keep it, and how to register corrallm. */
function tokenText(
  token: string,
  { name, hours, access }: NonNullable<ServeCommand['newToken']>,
  canvases: readonly string[],
  url: string,
  installed: Readonly<Record<string, boolean>>,
): string {
  const commands = registrations(installed, url);
  return [
    `corrallm serve: a new token for "${name}" (${access === 'write' ? 'read-write' : 'read-only'}, for ${String(hours)} hour${hours === 1 ? '' : 's'}), reaching ${canvases.join(', ')}. It replaces any earlier token named "${name}". It is shown only now; corrallm keeps only its hash:`,
    '',
    `  ${token}`,
    '',
    `Keep it in ${TOKEN_VARIABLE} where your orchestrator runs, without echoing it (read -rs ${TOKEN_VARIABLE} && export ${TOKEN_VARIABLE}), and register corrallm by that variable, never by pasting the token:`,
    '',
    ...(commands.length > 0
      ? commands.map((line) => `  ${line}`)
      : [
          `  ${url}, as the MCP server ${SERVER_NAME}, with the header Authorization: Bearer <the token, from ${TOKEN_VARIABLE}>`,
        ]),
    '',
  ].join('\n');
}

/**
 * A message added to a canvas, as a line of the log: what it is, from whom to whom, and a notice's
 * words, capped; never a party's text.
 */
function messageLine(core: Core, names: ReadonlyMap<CanvasId, string>, message: Message): string {
  const nodes = core.engines.canvas(message.canvas)?.document.nodes ?? [];
  const who = (party: PartyId) => (agentOf(party) === undefined ? party : partyName(nodes, party));
  const at = where(names, message.canvas);
  const route = `from ${who(message.from)} to ${who(message.to)}`;
  if (message.kind === 'notice') {
    const about = message.replyTo === undefined ? '' : ` about ${message.replyTo}`;
    return `${at} notice to ${who(message.to)}${about}: ${threadTitle(message.body, 200)}`;
  }
  if (message.turn !== undefined && message.replyTo !== undefined) {
    return `${at} reply to ${message.replyTo} ${route}: ${turnWords(message.turn)}`;
  }
  return `${at} ${message.kind === 'text' ? 'message' : message.kind} ${message.id} ${route}`;
}

/** Something newly waiting for an answer, as a line of the log: on which agent, and its title. */
function needLine(
  core: Core,
  names: ReadonlyMap<CanvasId, string>,
  canvas: CanvasId,
  item: NeedsItem,
): string {
  const nodes = core.engines.canvas(canvas)?.document.nodes ?? [];
  const on = item.agent === undefined ? '' : ` on ${partyName(nodes, `agent:${item.agent}`)}`;
  return `${where(names, canvas)} need${on}: ${threadTitle(item.title, 200)}`;
}

/** When and on which canvas, as a log line starts. */
function where(names: ReadonlyMap<CanvasId, string>, canvas: CanvasId): string {
  return `${new Date().toTimeString().slice(0, 8)} [${names.get(canvas) ?? canvas}]`;
}

/** How a turn ended, in short: "completed", "cancelled (interrupted)". */
function turnWords({ status, reason }: TurnResult): string {
  return reason === status ? status : `${status} (${reason})`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
