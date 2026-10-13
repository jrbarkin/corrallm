// Runs sandboxed: only 'electron' may be imported, and Vite bundles this into one CJS file.
// Never expose ipcRenderer itself; expose one typed function per contract channel, and one per
// event that listens for it (never passing Electron's event object on).
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import {
  API_CHANNELS,
  API_EVENTS,
  type AppApi,
  type IpcArgs,
  type IpcChannel,
  type IpcEvent,
  type IpcEventArgs,
  type IpcResult,
} from '../shared/ipc';

function invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>;
}

/** Calls `listener` with each `event` main sends; returns a function that stops it. */
function listen<E extends IpcEvent>(
  event: E,
  listener: (...args: IpcEventArgs<E>) => void,
): () => void {
  const receive = (_event: IpcRendererEvent, ...args: unknown[]) => {
    listener(...(args as IpcEventArgs<E>));
  };
  ipcRenderer.on(event, receive);
  return () => {
    ipcRenderer.removeListener(event, receive);
  };
}

const api: AppApi = {
  ping: () => invoke(API_CHANNELS.ping),
  openCanvas: () => invoke(API_CHANNELS.openCanvas),
  saveCanvas: (text, choose) => invoke(API_CHANNELS.saveCanvas, text, choose),
  forgetCanvas: () => invoke(API_CHANNELS.forgetCanvas),
  chooseProject: () => invoke(API_CHANNELS.chooseProject),
  findProjectFiles: (query) => invoke(API_CHANNELS.findProjectFiles, query),
  startSession: (agentId, options) => invoke(API_CHANNELS.startSession, agentId, options),
  sendToSession: (agentId, message) => invoke(API_CHANNELS.sendToSession, agentId, message),
  answerSession: (agentId, promptId, answer) =>
    invoke(API_CHANNELS.answerSession, agentId, promptId, answer),
  interruptSession: (agentId) => invoke(API_CHANNELS.interruptSession, agentId),
  setSessionMode: (agentId, mode) => invoke(API_CHANNELS.setSessionMode, agentId, mode),
  setSessionModel: (agentId, model) => invoke(API_CHANNELS.setSessionModel, agentId, model),
  setSessionEffort: (agentId, effort) => invoke(API_CHANNELS.setSessionEffort, agentId, effort),
  stopSessionTask: (agentId, taskId) => invoke(API_CHANNELS.stopSessionTask, agentId, taskId),
  closeSession: (agentId) => invoke(API_CHANNELS.closeSession, agentId),
  attachTerminal: (agentId) => invoke(API_CHANNELS.attachTerminal, agentId),
  detachTerminal: (agentId) => invoke(API_CHANNELS.detachTerminal, agentId),
  writeTerminal: (agentId, data) => invoke(API_CHANNELS.writeTerminal, agentId, data),
  resizeTerminal: (agentId, cols, rows) => invoke(API_CHANNELS.resizeTerminal, agentId, cols, rows),
  onSessionEvent: (listener) => listen(API_EVENTS.onSessionEvent, listener),
  onTerminalEvent: (listener) => listen(API_EVENTS.onTerminalEvent, listener),
};

contextBridge.exposeInMainWorld('api', api);
