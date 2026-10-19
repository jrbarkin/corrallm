// Runs sandboxed: only 'electron' may be imported, and Vite bundles this into one CJS file.
// Never expose ipcRenderer itself, the core's port or a function that takes a channel or an
// operation; expose one typed function per contract channel, one per event that listens for it
// (never passing Electron's event object on), and one per GUI operation, generated from the
// registry's fixed list (GUI_OPS), each calling its own operation over the window's port.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { GUI_OPS } from '../shared/api/surface';
import { guiFunction } from '../shared/gui-link';
import type { GuiBridge } from '../shared/gui-link';
import {
  API_CHANNELS,
  API_EVENTS,
  type AppApi,
  type IpcArgs,
  type CoreChannel,
  type IpcEventArgs,
  type IpcResult,
} from '../shared/ipc';
import { connectCore } from './core';

function invoke<C extends CoreChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
  return core.channel(channel, args);
}

/** Calls `listener` with each `event` main sends; returns a function that stops it. */
function listen(
  event: 'run:stopping',
  listener: (...args: IpcEventArgs<'run:stopping'>) => void,
): () => void {
  const receive = (_event: IpcRendererEvent, ...args: unknown[]) => {
    listener(...(args as IpcEventArgs<'run:stopping'>));
  };
  ipcRenderer.on(event, receive);
  return () => {
    ipcRenderer.removeListener(event, receive);
  };
}

const core = connectCore();

/** A function per GUI operation, by its camel-cased name (app.info → appInfo). */
const ops = Object.fromEntries(
  GUI_OPS.filter((op) => op !== 'terminal.drop').map((op) => [
    guiFunction(op),
    (args?: unknown) => core.call(op, args),
  ]),
) as Omit<GuiBridge, 'terminalDrop' | 'terminalOnEvent'>;

const api: AppApi = {
  ...ops,
  catalog: () => invoke(API_CHANNELS.catalog),
  getRun: () => invoke(API_CHANNELS.getRun),
  saveRun: (token, checkpoint) => invoke(API_CHANNELS.saveRun, token, checkpoint),
  runReady: (requestId, error) => invoke(API_CHANNELS.runReady, requestId, error),
  onRunStopping: (listener) => listen(API_EVENTS.onRunStopping, listener),
  openCanvas: () => invoke(API_CHANNELS.openCanvas),
  saveCanvas: (text, choose) => invoke(API_CHANNELS.saveCanvas, text, choose),
  forgetCanvas: () => invoke(API_CHANNELS.forgetCanvas),
  chooseProject: () => invoke(API_CHANNELS.chooseProject),
  findProjectFiles: (query) => invoke(API_CHANNELS.findProjectFiles, query),
  startSession: (agentId, options) => invoke(API_CHANNELS.startSession, agentId, options),
  installedClis: () => invoke(API_CHANNELS.installedClis),
  sendToSession: (agentId, message) => invoke(API_CHANNELS.sendToSession, agentId, message),
  answerSession: (agentId, promptId, answer) =>
    invoke(API_CHANNELS.answerSession, agentId, promptId, answer),
  interruptSession: (agentId) => invoke(API_CHANNELS.interruptSession, agentId),
  setSessionMode: (agentId, mode) => invoke(API_CHANNELS.setSessionMode, agentId, mode),
  setSessionModel: (agentId, model) => invoke(API_CHANNELS.setSessionModel, agentId, model),
  setSessionEffort: (agentId, effort) => invoke(API_CHANNELS.setSessionEffort, agentId, effort),
  stopSessionTask: (agentId, taskId) => invoke(API_CHANNELS.stopSessionTask, agentId, taskId),
  closeSession: (agentId) => invoke(API_CHANNELS.closeSession, agentId),
  freshSession: (agentId, cli) => invoke(API_CHANNELS.freshSession, agentId, cli),
  listSessions: (agentId) => invoke(API_CHANNELS.listSessions, agentId),
  resumeSession: (agentId, sessionId) => invoke(API_CHANNELS.resumeSession, agentId, sessionId),
  previewRewind: (agentId, messageId) => invoke(API_CHANNELS.previewRewind, agentId, messageId),
  rewindSession: (agentId, messageId, restore) =>
    invoke(API_CHANNELS.rewindSession, agentId, messageId, restore),
  settingsOptions: (cli) => invoke(API_CHANNELS.settingsOptions, cli),
  mcpServers: (agentId) => invoke(API_CHANNELS.mcpServers, agentId),
  changeMcpServer: (agentId, server, change) =>
    invoke(API_CHANNELS.changeMcpServer, agentId, server, change),
  // The paths of the files dropped, as the files say (a file the page made has none): the page
  // never names a path, and the core checks these again.
  terminalDrop: ({ agent, files, request }) => {
    const paths = Array.from(files, (file) => webUtils.getPathForFile(file)).filter(
      (file) => file !== '',
    );
    return paths.length === 0
      ? Promise.resolve({ ok: true, value: {} } as const)
      : (core.call('terminal.drop', {
          agent,
          paths,
          ...(request === undefined ? {} : { request }),
        }) as ReturnType<GuiBridge['terminalDrop']>);
  },
  getUsage: () => invoke(API_CHANNELS.getUsage),
  setUsageRule: (backend, rule) => invoke(API_CHANNELS.setUsageRule, backend, rule),
  simulateUsage: (backend, windows) => invoke(API_CHANNELS.simulateUsage, backend, windows),
  onSessionEvent: (listener) => core.listen(API_EVENTS.onSessionEvent, listener),
  terminalOnEvent: (listener) => core.listen('terminal', listener),
  onUsageChanged: (listener) => core.listen(API_EVENTS.onUsageChanged, listener),
};

contextBridge.exposeInMainWorld('api', api);
