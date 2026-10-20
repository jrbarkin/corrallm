import type { CanvasDocument } from '../../shared/model/canvas';
import { ApiError } from '../api/bridge';

type Build = (document: CanvasDocument) => CanvasDocument;
interface Pending {
  build: Build;
  resolve: () => void;
  reject: (error: unknown) => void;
}
interface EditSource {
  read: () => { document: CanvasDocument; rev: number };
  write: (document: CanvasDocument, rev: number) => Promise<number>;
  refresh: () => Promise<void>;
  changed: () => void;
}
/** Temporary queue/settings writers until tasks 11–12: guarded, serial and rebased on conflict. */
export class CanvasEdits {
  readonly #deps: EditSource;
  readonly #pending: Pending[] = [];
  #running: Promise<void> | undefined;
  #cached:
    { base: CanvasDocument; last: Pending | undefined; document: CanvasDocument } | undefined;
  constructor(deps: EditSource) {
    this.#deps = deps;
  }
  document(): CanvasDocument {
    const base = this.#deps.read().document;
    const last = this.#pending.at(-1);
    if (this.#cached?.base === base && this.#cached.last === last) return this.#cached.document;
    const document = this.#pending.reduce((doc, { build }) => build(doc), base);
    this.#cached = { base, last, document };
    return document;
  }
  edit(build: Build): Promise<void> {
    const done = Promise.withResolvers<undefined>();
    this.#pending.push({
      build,
      resolve: () => {
        done.resolve(undefined);
      },
      reject: done.reject,
    });
    this.#cached = undefined;
    this.#deps.changed();
    this.#start();
    return done.promise;
  }
  #start(): void {
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#pending.length > 0) this.#start();
    });
  }
  async flush(): Promise<void> {
    while (this.#running) await this.#running;
  }
  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const pending = [...this.#pending];
      try {
        for (let retry = 0; ; retry++) {
          const { document, rev } = this.#deps.read();
          const next = pending.reduce((doc, { build }) => build(doc), document);
          try {
            await this.#deps.write(next, rev);
            break;
          } catch (error) {
            if (!(error instanceof ApiError) || error.code !== 'conflict' || retry >= 1)
              throw error;
            await this.#deps.refresh();
          }
        }
        pending.forEach((p) => {
          p.resolve();
        });
      } catch (error) {
        pending.forEach((p) => {
          p.reject(error);
        });
      }
      this.#pending.splice(0, pending.length);
      this.#cached = undefined;
      this.#deps.changed();
    }
  }
}
