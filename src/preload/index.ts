// Runs sandboxed: only 'electron' may be imported, and Vite bundles this into one CJS file.
// Never expose ipcRenderer itself, the core's port or a function that takes a channel or an
// operation; expose one typed function per contract channel, one per event that listens for it
// (never passing Electron's event object on), and one per GUI operation, generated from the
// registry's fixed list (GUI_OPS), each calling its own operation over the window's port.
import { contextBridge, webUtils } from 'electron';

import { GUI_OPS } from '../shared/api/surface';
import { guiFunction } from '../shared/gui-link';
import type { GuiBridge } from '../shared/gui-link';
import type { AppApi } from '../shared/gui-link';
import { connectCore } from './core';

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
  terminalOnEvent: (listener) => core.listen('terminal', listener),
};

contextBridge.exposeInMainWorld('api', api);
