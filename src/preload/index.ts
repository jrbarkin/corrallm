// Runs sandboxed: only 'electron' may be imported, and Vite bundles this into one CJS file.
// Never expose ipcRenderer itself; expose one typed function per contract channel.
import { contextBridge, ipcRenderer } from 'electron';

import type { AppApi, IpcArgs, IpcChannel, IpcResult } from '../shared/ipc';

function invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>;
}

const api: AppApi = {
  ping: () => invoke('app:ping'),
};

contextBridge.exposeInMainWorld('api', api);
