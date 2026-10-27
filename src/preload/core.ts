import { ipcRenderer } from 'electron';

import type { OpResult } from '../shared/api/errors';
import type { TopicUpdate } from '../shared/api/topics';
import { CORE_PORT, WindowShow } from '../shared/gui-link';
import type { CoreGuiSide, GuiSide, GuiEvent, GuiEventArgs } from '../shared/gui-link';
import { CoreLink } from '../shared/link';

/*
 * The window's link to the core (B8 Design §3): the preload asks main for its port as it loads
 * (core:connect, through main's sender check) and keeps the port main posts back (core:port)
 * inside a CoreLink, in the preload's isolated world: the page never gets the port, only the
 * functions window.api makes of it. A call made before the port comes waits up to 10 seconds for
 * it; a new port (a core that restarted) takes the old one's place, and what still waited on the
 * old one fails. Results cross contextBridge whole, so an error's code and sentence survive.
 */

const WAIT_MS = 10_000;
const NOT_ANSWERING = 'corrallm’s core isn’t answering yet.';

export interface CoreConnection {
  onShow(listener: (target: WindowShow) => void): () => void;
  onTopic(listener: (changes: TopicUpdate[]) => void): () => void;
  onEpoch(listener: (epoch: string) => void): () => void;
  /** Hears the core's `drafts.flush`: answered once every listener's promise settles. */
  onDraftsFlush(listener: () => Promise<void>): () => void;
  /** Calls a GUI operation as you: its whole result, with transport failures unavailable. */
  call(op: string, args: unknown): Promise<OpResult<unknown>>;
  listen<E extends GuiEvent>(name: E, listener: (...args: GuiEventArgs<E>) => void): () => void;
}

interface Linked {
  link: CoreLink<GuiSide, CoreGuiSide>;
  /** Closes the port and fails what still waits on it, saying why. */
  close(why: string): void;
}

/** A link over the port main posted. */
function linkOver(
  port: MessagePort,
  closed: () => void,
  receive: (name: GuiEvent, args: GuiEventArgs<GuiEvent>) => void,
  topic: (changes: TopicUpdate[]) => void,
  epoch: (epoch: string) => void,
  flush: () => Promise<null>,
  show: (target: WindowShow) => void,
): Linked {
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
        port.addEventListener('close', () => {
          gone('corrallm’s core connection closed.');
          closed();
        });
        port.start();
      },
    },
    { 'drafts.flush': flush },
  );
  link.on('event', receive);
  link.on('topic', topic);
  link.on('epoch', epoch);
  link.on('show', show);
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
  let epoch: string | undefined;
  const epochs = new Set<(epoch: string) => void>();
  const shows = new Set<(target: WindowShow) => void>();
  const topics = new Set<(changes: TopicUpdate[]) => void>();
  const flushes = new Set<() => Promise<void>>();
  // What the page composes is finished before main's quit (B11 Design §16.5): view state only.
  const flush = async (): Promise<null> => {
    await Promise.all([...flushes].map((listener) => listener()));
    return null;
  };
  const listeners = new Map<GuiEvent, Set<(...args: unknown[]) => void>>();
  const receive = (name: GuiEvent, args: GuiEventArgs<GuiEvent>) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };
  const waiting = new Set<{ resolve: (linked: Linked) => void; reject: (error: Error) => void }>();

  ipcRenderer.on(CORE_PORT, (event) => {
    const [port] = event.ports;
    if (port === undefined) return;
    linked?.close('corrallm’s core restarted.');
    const next: Linked = linkOver(
      port,
      () => {
        if (linked === next) linked = undefined;
      },
      receive,
      (changes) => {
        if (linked !== next) return;
        for (const listener of topics) listener(changes);
      },
      (nextEpoch) => {
        if (linked !== next) return;
        epoch = nextEpoch;
        for (const listener of epochs) listener(nextEpoch);
      },
      flush,
      (target) => {
        if (linked !== next) return;
        const parsed = WindowShow.safeParse(target);
        if (parsed.success) for (const listener of shows) listener(parsed.data);
      },
    );
    linked = next;
    refused = undefined;
    for (const pending of waiting) pending.resolve(next);
  });
  ipcRenderer.invoke('core:connect').catch((error: unknown) => {
    refused = error instanceof Error ? error : new Error(String(error));
    for (const pending of waiting) pending.reject(refused);
  });

  const ready = (): Promise<Linked> => {
    if (linked) return Promise.resolve(linked);
    if (refused) return Promise.reject(refused);
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: (connection: Linked) => {
          clearTimeout(timer);
          waiting.delete(pending);
          resolve(connection);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          waiting.delete(pending);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        pending.reject(new Error(NOT_ANSWERING));
      }, WAIT_MS);
      waiting.add(pending);
    });
  };

  return {
    onShow: (listener) => {
      shows.add(listener);
      return () => {
        shows.delete(listener);
      };
    },
    onTopic: (listener) => {
      topics.add(listener);
      return () => {
        topics.delete(listener);
      };
    },
    onEpoch: (listener) => {
      epochs.add(listener);
      if (epoch !== undefined) listener(epoch);
      return () => {
        epochs.delete(listener);
      };
    },
    onDraftsFlush: (listener) => {
      flushes.add(listener);
      return () => {
        flushes.delete(listener);
      };
    },
    listen: (name, listener) => {
      let listening = listeners.get(name);
      if (!listening) listeners.set(name, (listening = new Set()));
      const receive = listener as (...args: unknown[]) => void;
      listening.add(receive);
      return () => {
        listening.delete(receive);
      };
    },
    call: async (op, args) => {
      try {
        const answer = await (await ready()).link.request('call', op, args);
        if (!answer.ok) throw new Error(answer.error.message);
        return answer.value;
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'unavailable',
            sentence: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}
