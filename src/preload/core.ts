import { ipcRenderer } from 'electron';

import { CORE_PORT } from '../shared/gui-link';
import type { CoreGuiSide, GuiSide } from '../shared/gui-link';
import type { IpcChannel } from '../shared/ipc';
import { CoreLink } from '../shared/link';

/*
 * The window's link to the core (B8 Design §3): the preload asks main for its port as it loads
 * (core:connect, through main's sender check) and keeps the port main posts back (core:port)
 * inside a CoreLink, in the preload's isolated world: the page never gets the port, only the
 * functions window.api makes of it. A call made before the port comes waits for it; a new port (a
 * core that restarted) takes the old one's place, and what still waited on the old one fails.
 */

export interface CoreConnection {
  /** Calls a GUI operation as you: its result, or a rejection with the sentence saying why. */
  call(op: string, args: unknown): Promise<unknown>;
}

interface Linked {
  link: CoreLink<GuiSide, CoreGuiSide>;
  /** Closes the port and fails what still waits on it, saying why. */
  close(why: string): void;
}

/** A link over the port main posted. */
function linkOver(port: MessagePort): Linked {
  let end: ((why: string) => void) | undefined;
  const link = new CoreLink<GuiSide, CoreGuiSide>(
    {
      post: (message) => {
        port.postMessage(message);
      },
      start: (receive, gone) => {
        end = gone;
        port.addEventListener('message', (event) => {
          receive(event.data);
        });
        port.start();
      },
    },
    {},
  );
  return {
    link,
    close: (why) => {
      port.close();
      end?.(why);
    },
  };
}

export function connectCore(): CoreConnection {
  let linked: Linked | undefined;
  /** Why main gave no port, if it refused. */
  let refused: Error | undefined;
  const waiting: { resolve: (linked: Linked) => void; reject: (error: Error) => void }[] = [];

  ipcRenderer.on(CORE_PORT, (event) => {
    const [port] = event.ports;
    if (port === undefined) return;
    linked?.close('corrallm’s core restarted.');
    linked = linkOver(port);
    for (const { resolve } of waiting.splice(0)) resolve(linked);
  });
  ipcRenderer.invoke('core:connect' satisfies IpcChannel).catch((error: unknown) => {
    refused = error instanceof Error ? error : new Error(String(error));
    for (const { reject } of waiting.splice(0)) reject(refused);
  });

  const ready = (): Promise<Linked> => {
    if (linked) return Promise.resolve(linked);
    if (refused) return Promise.reject(refused);
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
    });
  };

  return {
    call: async (op, args) => {
      const answer = await (await ready()).link.request('call', op, args);
      if (!answer.ok) throw new Error(answer.error.message);
      if (!answer.value.ok) throw new Error(answer.value.error.sentence);
      return answer.value.value;
    },
  };
}
