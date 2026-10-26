// Runs sandboxed: only 'electron' may be imported, and Vite bundles this into one CJS file.
// Never expose ipcRenderer itself, the core's port or a function that takes a channel or an
// operation; expose one typed function per contract channel, one per event that listens for it
// (never passing Electron's event object on), and one per GUI operation, generated from the
// registry's fixed list (GUI_OPS), each calling its own operation over the window's port.
import { contextBridge, webUtils } from 'electron';

import { GUI_OPS } from '../shared/api/surface';
import { guiFunction } from '../shared/gui-link';
import type { GuiBridge } from '../shared/gui-link';
import {
  API_CHANNELS,
  API_EVENTS,
  type AppApi,
  type IpcArgs,
  type CoreChannel,
  type IpcResult,
} from '../shared/ipc';
import { connectCore } from './core';

function invoke<C extends CoreChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
  return core.channel(channel, args);
}

const core = connectCore();

/** A function per GUI operation, by its camel-cased name (app.info → appInfo). */
const ops = Object.fromEntries(
  GUI_OPS.filter((op) => op !== 'terminal.drop').map((op) => [
    guiFunction(op),
    (args?: unknown) => core.call(op, args),
  ]),
) as Omit<GuiBridge, 'terminalDrop' | 'terminalOnEvent' | 'topicsOnChange' | 'topicsOnEpoch'>;

const api: AppApi = {
  ...ops,
  topicsOnChange: (listener) => core.onTopic(listener),
  topicsOnEpoch: (listener) => core.onEpoch(listener),
  draftsOnFlush: (listener) => core.onDraftsFlush(listener),
  sendToSession: (agentId, message) => invoke(API_CHANNELS.sendToSession, agentId, message),
  recordSessionCommand: (agentId, message) =>
    invoke(API_CHANNELS.recordSessionCommand, agentId, message),
  unqueueSession: (agentId, id) => invoke(API_CHANNELS.unqueueSession, agentId, id),
  answerSession: (agentId, promptId, answer) =>
    invoke(API_CHANNELS.answerSession, agentId, promptId, answer),
  interruptSession: (agentId) => invoke(API_CHANNELS.interruptSession, agentId),
  setSessionMode: (agentId, mode) => invoke(API_CHANNELS.setSessionMode, agentId, mode),
  setSessionModel: (agentId, model) => invoke(API_CHANNELS.setSessionModel, agentId, model),
  setSessionEffort: (agentId, effort) => invoke(API_CHANNELS.setSessionEffort, agentId, effort),
  stopSessionTask: (agentId, taskId) => invoke(API_CHANNELS.stopSessionTask, agentId, taskId),
  listSessions: (agentId) => invoke(API_CHANNELS.listSessions, agentId),
  resumeSession: (agentId, sessionId) => invoke(API_CHANNELS.resumeSession, agentId, sessionId),
  sessionAvailability: (agent) => invoke(API_CHANNELS.sessionAvailability, agent),
  settingsOptions: (cli, agent) =>
    invoke(API_CHANNELS.settingsOptions, cli, ...(agent === undefined ? [] : [agent])),
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
      ? Promise.resolve({ ok: true, value: { revs: {} } } as const)
      : (core.call('terminal.drop', {
          agent,
          paths,
          ...(request === undefined ? {} : { request }),
        }) as ReturnType<GuiBridge['terminalDrop']>);
  },
  onSessionEvent: (listener) => core.listen(API_EVENTS.onSessionEvent, listener),
  onSessionAvailability: (listener) => core.listen(API_EVENTS.onSessionAvailability, listener),
  terminalOnEvent: (listener) => core.listen('terminal', listener),
};

contextBridge.exposeInMainWorld('api', api);
