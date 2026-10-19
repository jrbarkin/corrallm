import { ipcMain } from 'electron';
import type { WebContents } from 'electron';

import type { Catalog } from '../shared/adapter';
import { MAX_CANVAS_BYTES, MAX_LINK_LENGTH } from '../shared/ipc';
import type { IpcArgs, IpcChannel, IpcEvent, IpcEventArgs, IpcResult } from '../shared/ipc';
import { parseRunCheckpoint } from '../shared/run';
import type { RunJournal } from './run-journal';
import type { RunShutdown } from './run-shutdown';
import { MAX_FILE_MATCHES } from '../shared/session';
import type { InstalledClis } from '../shared/session';
import { parseBackend, parseRule, parseWindows } from '../shared/usage';
import type { CanvasFiles } from './canvas';
import type { ProjectFiles } from './files';
import type { LinkOpener } from './host/links';
import type { CorePorts } from './host/ports';
import type { FileRevealer } from './host/reveal';
import type { Windows } from './host/windows';
import type { ProjectFolders } from './project';
import { isTrustedSender } from './security';
import {
  parseAgentArgs,
  parseAnswerArgs,
  parseEffortArgs,
  parseFilesArgs,
  parseFreshArgs,
  parseMcpChangeArgs,
  parseModeArgs,
  parseModelArgs,
  parseOptionsArgs,
  parseResumeArgs,
  parseRewindArgs,
  parseRewindPreviewArgs,
  parseSendArgs,
  parseStartArgs,
  parseStopTaskArgs,
  parseTerminalDropArgs,
  parseTerminalInputArgs,
  parseTerminalResizeArgs,
} from './sessions/args';
import type { SessionManager } from './sessions/manager';
import type { UsageReadings } from './usage';

/** Turns the raw, untrusted arguments into the channel's contract tuple, or throws. */
export type ArgsParser<C extends IpcChannel> = (args: unknown[]) => IpcArgs<C>;
/** Who sent a message: the renderer's web contents (whose window a dialog belongs to). */
export interface IpcCaller {
  contents: WebContents;
}
export type IpcHandler<C extends IpcChannel> = (
  caller: IpcCaller,
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>;

/**
 * What the handlers act on: the catalog, which canvas each window shows, canvas files, runs,
 * project folders, their files, links to open (and project files to show), sessions, the agents
 * the user has, usage, and windows' ports to the core. Every service but the window map and the
 * ports knows canvases by their ids, never windows: a handler looks up the sender's canvas first.
 */
export interface IpcServices {
  /** What every adapter declares (sessions/adapters.ts): what the channels' arguments name. */
  catalog: Catalog;
  windows: Pick<Windows, 'canvasOf' | 'show'>;
  canvases: Pick<CanvasFiles, 'open' | 'save'>;
  runs: Pick<RunJournal, 'get' | 'save' | 'opened' | 'saved' | 'draft'>;
  shutdown: Pick<RunShutdown, 'ready'>;
  projects: Pick<ProjectFolders, 'choose' | 'restore' | 'of'>;
  files: Pick<ProjectFiles, 'find'>;
  links: Pick<LinkOpener, 'open'>;
  reveal: Pick<FileRevealer, 'reveal'>;
  sessions: Pick<
    SessionManager,
    | 'start'
    | 'send'
    | 'answer'
    | 'interrupt'
    | 'setMode'
    | 'setModel'
    | 'setEffort'
    | 'stopTask'
    | 'close'
    | 'fresh'
    | 'listSessions'
    | 'resumeSession'
    | 'mcpServers'
    | 'changeMcpServer'
    | 'settingsOptions'
    | 'previewRewind'
    | 'rewind'
    | 'projectChanged'
    | 'attachTerminal'
    | 'detachTerminal'
    | 'inputTerminal'
    | 'resizeTerminal'
    | 'dropOnTerminal'
  >;
  /** Which agents the user has, by adapter (sessions/installed.ts). */
  clis: { installed: () => Promise<InstalledClis> };
  usage: Pick<UsageReadings, 'state' | 'setRule' | 'simulate'>;
  /** Windows' ports to the core (host/ports.ts). */
  core: Pick<CorePorts, 'connect'>;
}

/**
 * Returns a typed `handle()` bound to the renderer's origin. Before any handler runs, every
 * message is checked:
 * 1. the sender must be the top-level frame of our own renderer (`trustedOrigin`);
 * 2. the arguments must pass the channel's `parseArgs`.
 * Errors thrown here reach the renderer as a rejected promise (message only).
 */
export function createIpcHandle(trustedOrigin: string) {
  return function handle<C extends IpcChannel>(
    channel: C,
    parseArgs: ArgsParser<C>,
    handler: IpcHandler<C>,
  ): void {
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]) => {
      if (!isTrustedSender(event.senderFrame, trustedOrigin)) {
        throw new Error(`Rejected ${channel}: untrusted sender`);
      }
      return handler({ contents: event.sender }, ...parseArgs(rawArgs));
    });
  };
}

/** Sends an event to a renderer, if it is still there. Only main sends events. */
export function sendEvent<E extends IpcEvent>(
  contents: WebContents,
  event: E,
  ...args: IpcEventArgs<E>
): void {
  if (!contents.isDestroyed()) contents.send(event, ...args);
}

/** `ArgsParser` for channels that take no arguments. */
export function noArgs(args: unknown[]): [] {
  if (args.length !== 0) throw new TypeError('Expected no arguments');
  return [];
}

/**
 * One entry per channel in the contract. The mapped type makes a missing channel a compile
 * error, and ties each channel's parser and handler to its contract types.
 */
type HandlerTable = {
  [C in IpcChannel]: { parseArgs: ArgsParser<C>; handler: IpcHandler<C> };
};

/** `ArgsParser` for canvas:save: the canvas's text (within the size limit), and `choose`. */
export function parseSaveArgs(args: unknown[]): IpcArgs<'canvas:save'> {
  const [text, choose] = args;
  if (args.length !== 2 || typeof text !== 'string' || typeof choose !== 'boolean') {
    throw new TypeError('Expected the canvas text and whether to choose a file');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CANVAS_BYTES) {
    throw new RangeError('The canvas is too large to save');
  }
  return [text, choose];
}

/**
 * `ArgsParser` for link:open and link:reveal: the URL clicked, a string within MAX_LINK_LENGTH.
 * Whether it may open (or its file be shown), and how, is main's to decide (host/links.ts, host/reveal.ts),
 * never the renderer's.
 */
export function parseLinkArgs(args: unknown[]): IpcArgs<'link:open' | 'link:reveal'> {
  const [url] = args;
  if (args.length !== 1 || typeof url !== 'string') throw new TypeError('Expected a link');
  if (url.length > MAX_LINK_LENGTH) throw new RangeError('The link is too long');
  return [url];
}

/** The usage backends the catalog lists: those whose usage corrallm reads. */
const backendsOf = (catalog: Catalog) => catalog.usageBackends.map((backend) => backend.id);

/** `ArgsParser` for usage:rule: a backend the catalog lists, and a rule or null. */
export function parseUsageRuleArgs(args: unknown[], catalog: Catalog): IpcArgs<'usage:rule'> {
  const [backend, rule] = args;
  if (args.length !== 2) throw new TypeError('Expected a backend and a rule (or null)');
  return [parseBackend(backend, backendsOf(catalog)), rule === null ? null : parseRule(rule)];
}

/** `ArgsParser` for usage:simulate: a backend, and its windows (checked as a reading's) or null. */
export function parseSimulateArgs(args: unknown[], catalog: Catalog): IpcArgs<'usage:simulate'> {
  const [backend, windows] = args;
  if (args.length !== 2) throw new TypeError('Expected a backend and its windows (or null)');
  return [
    parseBackend(backend, backendsOf(catalog)),
    windows === null ? null : parseWindows(windows, Date.now()),
  ];
}

function createHandlers({
  catalog,
  windows,
  canvases,
  runs,
  shutdown,
  projects,
  files,
  links,
  reveal,
  sessions,
  clis,
  usage,
  core,
}: IpcServices): HandlerTable {
  /** The canvas the sender's window shows: what every canvas's channel acts on. */
  const of = (contents: WebContents) => windows.canvasOf(contents);
  return {
    'core:connect': {
      parseArgs: noArgs,
      handler: ({ contents }) => {
        core.connect(contents);
        return null;
      },
    },
    'catalog:get': { parseArgs: noArgs, handler: () => catalog },
    'run:get': { parseArgs: noArgs, handler: async ({ contents }) => runs.get(await of(contents)) },
    'run:save': {
      parseArgs: (args) => {
        if (args.length !== 2 || typeof args[0] !== 'string' || args[0].length > 100) {
          throw new TypeError('Expected a canvas token and run checkpoint');
        }
        return [args[0], args[1] === null ? null : parseRunCheckpoint(args[1])];
      },
      handler: async ({ contents }, token, checkpoint) => {
        await runs.save(await of(contents), token, checkpoint);
        return null;
      },
    },
    'run:ready': {
      parseArgs: (args) => {
        const [id, error] = args;
        if (
          args.length !== 2 ||
          typeof id !== 'string' ||
          id.length > 100 ||
          !(error === null || (typeof error === 'string' && error.length <= 4096))
        ) {
          throw new TypeError('Expected a shutdown request and error (or null)');
        }
        return [id, error];
      },
      handler: ({ contents }, id, error) => {
        shutdown.ready(contents, id, error);
        return null;
      },
    },
    'canvas:open': {
      parseArgs: noArgs,
      handler: async ({ contents }) => {
        // It works even when the canvas before could not be restored.
        const opened = await canvases.open(contents.id);
        if (opened === null) return null;
        const { id, name, text, copy } = opened;
        await runs.opened(id, copy);
        // Another canvas: the old one's sessions end, and the new one's folder comes back.
        await windows.show(contents, id);
        const project = await projects.restore(id);
        return { id, name, text, ...(project ? { project } : {}) };
      },
    },
    'canvas:save': {
      parseArgs: parseSaveArgs,
      handler: async ({ contents }, text, choose) => {
        const canvas = await of(contents);
        const name = await canvases.save(contents.id, canvas, text, choose);
        if (name !== null) await runs.saved(canvas);
        return name;
      },
    },
    'canvas:forget': {
      parseArgs: noArgs,
      handler: async ({ contents }) => {
        // New keeps the canvas before as it was, even one that could not be restored.
        const draft = await runs.draft();
        await windows.show(contents, draft);
        return draft;
      },
    },
    'project:choose': {
      parseArgs: noArgs,
      handler: async ({ contents }) => {
        const canvas = await of(contents);
        const before = projects.of(canvas);
        const chosen = await projects.choose(contents.id, canvas);
        if (chosen !== null && chosen.path !== before) await sessions.projectChanged(canvas);
        return chosen;
      },
    },
    'project:files': {
      parseArgs: parseFilesArgs,
      handler: async ({ contents }, query) => {
        const folder = projects.of(await of(contents));
        return folder === undefined ? [] : files.find(folder, query, MAX_FILE_MATCHES);
      },
    },
    'session:start': {
      parseArgs: (args) => parseStartArgs(args, catalog),
      handler: async ({ contents }, agentId, options) => {
        await sessions.start(await of(contents), agentId, options);
        return null;
      },
    },
    'session:clis': { parseArgs: noArgs, handler: () => clis.installed() },
    'session:send': {
      parseArgs: parseSendArgs,
      handler: async ({ contents }, agentId, message) => {
        await sessions.send(await of(contents), agentId, message);
        return null;
      },
    },
    'session:answer': {
      parseArgs: parseAnswerArgs,
      handler: async ({ contents }, agentId, promptId, answer) => {
        await sessions.answer(await of(contents), agentId, promptId, answer);
        return null;
      },
    },
    'session:interrupt': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => {
        await sessions.interrupt(await of(contents), agentId);
        return null;
      },
    },
    'session:mode': {
      parseArgs: parseModeArgs,
      handler: async ({ contents }, agentId, mode) => {
        await sessions.setMode(await of(contents), agentId, mode);
        return null;
      },
    },
    'session:model': {
      parseArgs: parseModelArgs,
      handler: async ({ contents }, agentId, model) => {
        await sessions.setModel(await of(contents), agentId, model);
        return null;
      },
    },
    'session:effort': {
      parseArgs: parseEffortArgs,
      handler: async ({ contents }, agentId, effort) => {
        await sessions.setEffort(await of(contents), agentId, effort);
        return null;
      },
    },
    'session:stopTask': {
      parseArgs: parseStopTaskArgs,
      handler: async ({ contents }, agentId, taskId) => {
        await sessions.stopTask(await of(contents), agentId, taskId);
        return null;
      },
    },
    'session:close': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => {
        await sessions.close(await of(contents), agentId);
        return null;
      },
    },
    'session:fresh': {
      parseArgs: (args) => parseFreshArgs(args, catalog),
      handler: async ({ contents }, agentId, adapter) => {
        await sessions.fresh(await of(contents), agentId, adapter);
        return null;
      },
    },
    'session:list': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => sessions.listSessions(await of(contents), agentId),
    },
    'session:resume': {
      parseArgs: parseResumeArgs,
      handler: async ({ contents }, agentId, sessionId) => {
        await sessions.resumeSession(await of(contents), agentId, sessionId);
        return null;
      },
    },
    'session:rewind-preview': {
      parseArgs: parseRewindPreviewArgs,
      handler: async ({ contents }, agentId, messageId) =>
        sessions.previewRewind(await of(contents), agentId, messageId),
    },
    'session:rewind': {
      parseArgs: parseRewindArgs,
      handler: async ({ contents }, agentId, messageId, restore) =>
        sessions.rewind(await of(contents), agentId, messageId, restore),
    },
    'session:options': {
      parseArgs: (args) => parseOptionsArgs(args, catalog),
      handler: async ({ contents }, adapter) =>
        sessions.settingsOptions(await of(contents), adapter),
    },
    'session:mcp': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => sessions.mcpServers(await of(contents), agentId),
    },
    'session:mcp-change': {
      parseArgs: parseMcpChangeArgs,
      handler: async ({ contents }, agentId, server, change) =>
        sessions.changeMcpServer(await of(contents), agentId, server, change),
    },
    'terminal:attach': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => {
        sessions.attachTerminal(await of(contents), agentId);
        return null;
      },
    },
    'terminal:detach': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => {
        sessions.detachTerminal(await of(contents), agentId);
        return null;
      },
    },
    'terminal:input': {
      parseArgs: parseTerminalInputArgs,
      handler: async ({ contents }, agentId, data) => {
        await sessions.inputTerminal(await of(contents), agentId, data);
        return null;
      },
    },
    'link:open': {
      parseArgs: parseLinkArgs,
      handler: ({ contents }, url) => links.open(contents, url),
    },
    'link:reveal': {
      parseArgs: parseLinkArgs,
      handler: async ({ contents }, url) => reveal.reveal(await of(contents), url),
    },
    'terminal:resize': {
      parseArgs: parseTerminalResizeArgs,
      handler: async ({ contents }, agentId, cols, rows) => {
        await sessions.resizeTerminal(await of(contents), agentId, cols, rows);
        return null;
      },
    },
    'terminal:drop': {
      parseArgs: parseTerminalDropArgs,
      handler: async ({ contents }, agentId, paths) => {
        await sessions.dropOnTerminal(await of(contents), agentId, paths);
        return null;
      },
    },
    'usage:get': { parseArgs: noArgs, handler: () => usage.state() },
    'usage:rule': {
      parseArgs: (args) => parseUsageRuleArgs(args, catalog),
      handler: (_caller, backend, rule) => {
        usage.setRule(backend, rule);
        return null;
      },
    },
    'usage:simulate': {
      parseArgs: (args) => parseSimulateArgs(args, catalog),
      handler: (_caller, backend, windows) => {
        usage.simulate(backend, windows);
        return null;
      },
    },
  };
}

// Generic so each channel's parser and handler types stay linked while iterating the table.
function register<C extends IpcChannel>(
  handle: ReturnType<typeof createIpcHandle>,
  channel: C,
  { parseArgs, handler }: HandlerTable[C],
): void {
  handle(channel, parseArgs, handler);
}

/** Registers every channel in the IPC contract. Call once, after the app is ready. */
export function registerIpcHandlers(trustedOrigin: string, services: IpcServices): void {
  const handle = createIpcHandle(trustedOrigin);
  const handlers = createHandlers(services);
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    register(handle, channel, handlers[channel]);
  }
}
