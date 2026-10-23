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
import { lockProfile, processStart, ProfileLocked } from '../core/lock';
import type { ProfileLock } from '../core/lock';
import { partyName } from '../core/parties';
import { CATALOG } from '../sessions/adapters';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { installedClis } from '../sessions/installed';
import { removeApiFile, writeApiFile } from './api-file';
import type { ServeCommand } from './args';
import { TOKEN_VARIABLE, URL_VARIABLE } from './wait';

/*
 * `corrallm serve` (API Spec §8.6, §8.7; Core Server §7.6): corrallm's core under plain Node, with
 * its MCP server on 127.0.0.1, for orchestrators outside corrallm. It owns the profile while it
 * runs (core.lock), and serves only canvases the app keeps: each --canvas file must be the one the
 * profile's canvas memory names for the canvas it holds, with the project folder picked for it in
 * the app,
 * since a command line, which an agent can type as easily as you, never grants folder trust. Each
 * run restores paused, which holds only the run's own sends, so orchestrators' messages still
 * reach idle agents; but nothing is delivered until every check that may refuse the start has
 * passed (each canvas opened, the port listened on, the token made, api.json published), so a
 * refused start sends nothing. It listens on --port, which it keeps for later starts, else the
 * port the profile keeps (chosen free once), writes api.json, and says on stderr each message, reply and thing newly
 * waiting for an answer, with every control character shown escaped, since what it says comes from
 * canvases, agents and MCP servers. --new-token makes an outside token for the canvases named,
 * shown once, on a terminal only, with how to register corrallm by its variable in each installed
 * CLI that says how (its adapter's `registerMcp`). Told to stop (SIGINT, SIGTERM, SIGHUP), it holds
 * each run where it is, journals, ends its sessions, writes out what it keeps, removes api.json
 * and lets the profile go; told as it starts, it makes no token and delivers nothing.
 */

/** The name orchestrators register corrallm's MCP server under: never the agents' `corrallm`. */
const SERVER_NAME = 'corrallm-server';

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
    io.stderr.write(`${shown(line)}\n`);
  };
  if (command.newToken && !io.stderr.isTTY) {
    say(NOT_A_TERMINAL);
    return 1;
  }
  const profile = path.resolve(command.profile ?? appProfile({ env: io.env }));
  // The user's alone, as the app's own profile is.
  await mkdir(profile, { recursive: true, mode: 0o700 });
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
  /**
   * Whether it was told to stop. Told as it starts, it makes no token and delivers nothing, and
   * stops as soon as what it is doing then is done.
   */
  let stopping = false;
  void io.stopped.then(() => {
    stopping = true;
  });
  const isStopping = () => stopping;
  const stop = () => {
    say('corrallm serve: stopping…');
    return 0;
  };
  /** Serves until told to stop: 0, or 1 if it can't start. */
  const serving = async (): Promise<number> => {
    const opened = await createCore(
      { profile, app: io.app, check: false, distribution: CORRALLM_DISTRIBUTION },
      NODE_HOST,
    );
    core = opened;
    const names = new Map<CanvasId, string>();
    // Heard from the first, so that what each canvas has waiting for an answer as it opens, and
    // what delivery starts with (a message cut off when corrallm last stopped), are said too.
    opened.watch({
      message: (message) => {
        say(messageLine(opened, names, message));
      },
      need: (canvas, item) => {
        say(needLine(opened, names, canvas, item));
      },
    });
    const files = new Map<CanvasId, string>();
    const basenames = command.canvases.map((file) => path.basename(file));
    for (const file of command.canvases) {
      const name = path.basename(file);
      let canvas: CanvasId;
      try {
        canvas = await opened.keptCanvas(file);
      } catch (error) {
        say(`corrallm serve: ${reasonOf(error)}`);
        return 1;
      }
      files.set(canvas, name);
      // Named before it opens, as what opening it says is said by its name; in the log, two files
      // of one name are told apart by their canvases' ids.
      names.set(
        canvas,
        basenames.filter((one) => one === name).length > 1 ? `${name} ${canvas}` : name,
      );
      try {
        for (const warning of await opened.openHeld(canvas)) {
          say(`${where(names, canvas)} ${warning}`);
        }
      } catch (error) {
        say(`corrallm serve: ${name} can’t be served: ${reasonOf(error)}`);
        return 1;
      }
    }

    const kept = command.port === undefined ? await opened.settings.apiPort() : undefined;
    const port = command.port ?? kept ?? 0;
    try {
      server = await startApiServer({
        core: opened,
        clientOf: (token) => opened.clientOf(token),
        port,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EADDRINUSE') throw error;
      say(
        `corrallm serve: port ${String(port)} is taken: another program listens on it. Stop it, or serve on another port with --port, which is kept for later starts (then register corrallm there again).` +
          (kept === undefined
            ? ''
            : ' If you didn’t expect that, make a new token: an orchestrator that calls this port gives its token to whatever listens there.'),
      );
      return 1;
    }
    const { url } = server;
    // A port given is kept, so a start without one (after a crash, say) listens there again.
    if (command.port === undefined ? kept === undefined : command.port !== 0) {
      await opened.settings.keepApiPort(server.port);
    }
    const served = [...files].map(([canvas, name]) => `${name} (${canvas})`).join(', ');
    // `corrallm wait` finds a server by api.json only on the app's own profile.
    const findIt =
      profile === path.resolve(appProfile({ env: io.env }))
        ? []
        : [
            `corrallm wait finds this server only by its URL: export ${URL_VARIABLE}=${url} where your orchestrator runs.`,
          ];

    if (command.newToken) {
      const installed = await installedClis(
        agentEnvironment(await loginShellEnvironment({ env: io.env })),
      );
      // Told to stop meanwhile (a login shell may take seconds): the token it would replace stays.
      if (stopping) return stop();
      const token = await opened.tokens.create({
        ...command.newToken,
        canvases: [...names.keys()],
      });
      for (const line of tokenText(token, command.newToken, served, url, installed, findIt)) {
        say(line);
      }
    }

    if (stopping) return stop();
    // Discovery is a startup check too: a failed publication must never release queued messages
    // or announce a server that corrallm wait cannot find yet.
    try {
      await writeApiFile(profile, {
        url,
        port: server.port,
        pid: process.pid,
        started: processStart(),
      });
      wroteApi = true;
    } catch (error) {
      say(`corrallm serve: could not write ${path.join(profile, 'api.json')}: ${reasonOf(error)}`);
      return 1;
    }
    // Every check passed: what waits on each canvas goes from now on, unless it was told to stop
    // while the discovery file was being written (leave() still removes it then).
    if (isStopping()) return stop();
    await opened.deliver();
    say(`corrallm serve: serving ${served} at ${url}, on the profile ${profile}. Ctrl-C stops it.`);
    if (!command.newToken) {
      for (const line of findIt) say(`corrallm serve: ${line}`);
    }
    await io.stopped;
    return stop();
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

/**
 * The commands that register corrallm's MCP server by the token's variable, in each installed CLI
 * that says how.
 */
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

/**
 * What --new-token prints, once, line by line: the token, where to keep it, how to register
 * corrallm, and (`findIt`) how `corrallm wait` finds the server.
 */
function tokenText(
  token: string,
  { name, hours, access }: NonNullable<ServeCommand['newToken']>,
  served: string,
  url: string,
  installed: Readonly<Record<string, boolean>>,
  findIt: readonly string[],
): string[] {
  const commands = registrations(installed, url);
  return [
    `corrallm serve: a new token for "${name}" (${access === 'write' ? 'read-write' : 'read-only'}, for ${String(hours)} hour${hours === 1 ? '' : 's'}), reaching ${served}. It replaces any earlier token named "${name}". It is shown only now; corrallm keeps only its hash:`,
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
    ...findIt.flatMap((line) => [line, '']),
  ];
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

/**
 * A line as the terminal is given it: each control character (C0, DEL, C1) shown as its escape
 * (`\x1b`), so no name or title it quotes can move the cursor, erase what was said, ring, or set
 * the clipboard.
 */
function shown(line: string): string {
  return line.replace(
    /\p{Cc}/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
