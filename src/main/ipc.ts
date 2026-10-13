import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';

import { MAX_CANVAS_BYTES, MAX_LINK_LENGTH } from '../shared/ipc';
import type { IpcArgs, IpcChannel, IpcEvent, IpcEventArgs, IpcResult } from '../shared/ipc';
import { MAX_FILE_MATCHES } from '../shared/session';
import { forgetCanvas, openCanvas, saveCanvas } from './canvas';
import type { ProjectFiles } from './files';
import type { LinkOpener } from './links';
import type { ProjectFolders } from './project';
import { isTrustedSender } from './security';
import {
  parseAgentArgs,
  parseAnswerArgs,
  parseFilesArgs,
  parseModeArgs,
  parseModelArgs,
  parseResumeArgs,
  parseSendArgs,
  parseStartArgs,
  parseTerminalInputArgs,
  parseTerminalResizeArgs,
} from './sessions/args';
import type { SessionManager } from './sessions/manager';

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
 * What the handlers act on besides canvas files: project folders, their files, links to open, and
 * sessions.
 */
export interface IpcServices {
  projects: Pick<ProjectFolders, 'choose' | 'restore' | 'remember' | 'forget' | 'of'>;
  files: Pick<ProjectFiles, 'find'>;
  links: Pick<LinkOpener, 'open'>;
  sessions: Pick<
    SessionManager,
    | 'start'
    | 'send'
    | 'answer'
    | 'interrupt'
    | 'setMode'
    | 'setModel'
    | 'close'
    | 'listSessions'
    | 'resumeSession'
    | 'canvasOpened'
    | 'canvasForgotten'
    | 'canvasSaved'
    | 'projectChanged'
    | 'attachTerminal'
    | 'detachTerminal'
    | 'inputTerminal'
    | 'resizeTerminal'
  >;
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

export function getVersionString(): string {
  const { electron, chrome, node } = process.versions;
  return `${app.getName()} ${app.getVersion()} (Electron ${electron}, Chromium ${chrome}, Node ${node})`;
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
 * `ArgsParser` for link:open: the URL clicked, a string within MAX_LINK_LENGTH. Whether it may
 * open, and how, is main's to decide (links.ts), never the renderer's.
 */
export function parseLinkArgs(args: unknown[]): IpcArgs<'link:open'> {
  const [url] = args;
  if (args.length !== 1 || typeof url !== 'string') throw new TypeError('Expected a link');
  if (url.length > MAX_LINK_LENGTH) throw new RangeError('The link is too long');
  return [url];
}

function createHandlers({ projects, files, links, sessions }: IpcServices): HandlerTable {
  return {
    'app:ping': { parseArgs: noArgs, handler: getVersionString },
    'canvas:open': {
      parseArgs: noArgs,
      handler: async ({ contents }) => {
        const file = await openCanvas(contents);
        if (file === null) return null;
        // Another canvas: the old one's sessions end, and the new one's folder comes back.
        await sessions.canvasOpened(contents);
        const project = await projects.restore(contents);
        return project ? { ...file, project } : file;
      },
    },
    'canvas:save': {
      parseArgs: parseSaveArgs,
      handler: async ({ contents }, text, choose) => {
        const name = await saveCanvas(contents, text, choose);
        if (name !== null) {
          await projects.remember(contents);
          await sessions.canvasSaved(contents);
        }
        return name;
      },
    },
    'canvas:forget': {
      parseArgs: noArgs,
      handler: async ({ contents }) => {
        forgetCanvas(contents);
        projects.forget(contents);
        await sessions.canvasForgotten(contents);
        return null;
      },
    },
    'project:choose': {
      parseArgs: noArgs,
      handler: async ({ contents }) => {
        const before = projects.of(contents);
        const chosen = await projects.choose(contents);
        if (chosen !== null && chosen.path !== before) await sessions.projectChanged(contents);
        return chosen;
      },
    },
    'project:files': {
      parseArgs: parseFilesArgs,
      handler: async ({ contents }, query) => {
        const folder = projects.of(contents);
        return folder === undefined ? [] : files.find(folder, query, MAX_FILE_MATCHES);
      },
    },
    'session:start': {
      parseArgs: parseStartArgs,
      handler: async ({ contents }, agentId, options) => {
        await sessions.start(contents, agentId, options);
        return null;
      },
    },
    'session:send': {
      parseArgs: parseSendArgs,
      handler: async ({ contents }, agentId, message) => {
        await sessions.send(contents, agentId, message);
        return null;
      },
    },
    'session:answer': {
      parseArgs: parseAnswerArgs,
      handler: async ({ contents }, agentId, promptId, answer) => {
        await sessions.answer(contents, agentId, promptId, answer);
        return null;
      },
    },
    'session:interrupt': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => {
        await sessions.interrupt(contents, agentId);
        return null;
      },
    },
    'session:mode': {
      parseArgs: parseModeArgs,
      handler: async ({ contents }, agentId, mode) => {
        await sessions.setMode(contents, agentId, mode);
        return null;
      },
    },
    'session:model': {
      parseArgs: parseModelArgs,
      handler: async ({ contents }, agentId, model) => {
        await sessions.setModel(contents, agentId, model);
        return null;
      },
    },
    'session:close': {
      parseArgs: parseAgentArgs,
      handler: async ({ contents }, agentId) => {
        await sessions.close(contents, agentId);
        return null;
      },
    },
    'session:list': {
      parseArgs: parseAgentArgs,
      handler: ({ contents }, agentId) => sessions.listSessions(contents, agentId),
    },
    'session:resume': {
      parseArgs: parseResumeArgs,
      handler: async ({ contents }, agentId, sessionId) => {
        await sessions.resumeSession(contents, agentId, sessionId);
        return null;
      },
    },
    'terminal:attach': {
      parseArgs: parseAgentArgs,
      handler: ({ contents }, agentId) => {
        sessions.attachTerminal(contents, agentId);
        return null;
      },
    },
    'terminal:detach': {
      parseArgs: parseAgentArgs,
      handler: ({ contents }, agentId) => {
        sessions.detachTerminal(contents, agentId);
        return null;
      },
    },
    'terminal:input': {
      parseArgs: parseTerminalInputArgs,
      handler: async ({ contents }, agentId, data) => {
        await sessions.inputTerminal(contents, agentId, data);
        return null;
      },
    },
    'link:open': {
      parseArgs: parseLinkArgs,
      handler: ({ contents }, url) => links.open(contents, url),
    },
    'terminal:resize': {
      parseArgs: parseTerminalResizeArgs,
      handler: async ({ contents }, agentId, cols, rows) => {
        await sessions.resizeTerminal(contents, agentId, cols, rows);
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
