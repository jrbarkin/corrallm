import { randomUUID } from 'node:crypto';

import type { WebContents } from 'electron';

interface Pending {
  id: string;
  promise: Promise<void>;
  finish(error?: Error): void;
}

/** Freeze/persist acknowledgements precede CLI shutdown and the final journal flush. */
export class RunShutdown {
  readonly #pending = new Map<WebContents, Pending>();
  readonly #send: (contents: WebContents, requestId: string) => void;
  readonly #timeout: number;

  constructor(send: (contents: WebContents, requestId: string) => void, timeout = 3000) {
    this.#send = send;
    this.#timeout = timeout;
  }

  stop(contents: WebContents): Promise<void> {
    if (contents.isDestroyed() || contents.isCrashed()) return Promise.resolve();
    const existing = this.#pending.get(contents);
    if (existing !== undefined) return existing.promise;
    const id = randomUUID();
    let finish: Pending['finish'] = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new Error('The window did not finish saving its run before closing'));
      }, this.#timeout);
      finish = (error) => {
        clearTimeout(timer);
        this.#pending.delete(contents);
        if (error === undefined) resolve();
        else reject(error);
      };
    });
    this.#pending.set(contents, { id, promise, finish });
    this.#send(contents, id);
    return promise;
  }

  ready(contents: WebContents, requestId: string, error: string | null): void {
    const pending = this.#pending.get(contents);
    if (pending?.id !== requestId) throw new Error('No matching run shutdown was requested');
    pending.finish(error === null ? undefined : new Error(error));
  }
}
