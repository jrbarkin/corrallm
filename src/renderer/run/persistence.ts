import type { CanvasId } from '../../shared/canvas';
import type { RunCheckpoint, RunRestore } from '../../shared/run';

/**
 * The core owns storage, the canvas's document and native conversation identity; the renderer
 * supplies run metadata only. Document gestures use operations.
 */
export interface RunSource {
  get: () => Promise<RunRestore>;
  save: (token: string, checkpoint: RunCheckpoint | null) => Promise<unknown>;
  ready: (request: string, error: string | null) => Promise<null>;
  onStopping: (listener: (request: string) => void) => () => void;
}

interface Owner {
  capture: () => RunCheckpoint;
  /** Resolves once the mirror holds the shown canvas: its run is read only after (B9 Design §9). */
  ready: () => Promise<void>;
  beforeSave?: () => Promise<void>;
  restore: (context: RunRestore) => void | Promise<void>;
  freeze: () => void | Promise<void>;
  error: (error: unknown) => void;
}

/** Serial checkpoint writes and an acknowledged freeze before main closes native sessions. */
export class RunPersistence {
  #token: string | undefined;
  #context: Promise<RunRestore> | undefined;
  #loading: Promise<RunRestore> | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #last = '';
  #changing: Promise<void> | undefined;
  #failedInitialization = false;
  #failedBaseline: string | undefined;
  readonly #source: RunSource;
  readonly #owner: Owner;
  #unsubscribe: (() => void) | undefined;

  constructor(source: RunSource, owner: Owner) {
    this.#source = source;
    this.#owner = owner;
  }

  /** Starts hearing main again after cleanup, without restoring over current work. */
  initialize(): Promise<RunRestore> {
    this.#disposed = false;
    const source = this.#source;
    const owner = this.#owner;
    this.#unsubscribe ??= source.onStopping((request) => {
      if (this.#failedInitialization) {
        const unchanged = this.#failedBaseline === contentsKey(owner);
        const error = unchanged
          ? null
          : 'Run progress could not be loaded. Use New or Open before closing changed work.';
        if (error !== null) owner.error(new Error(error));
        void source.ready(request, error).catch(owner.error);
        return;
      }
      void Promise.resolve()
        .then(() => owner.freeze())
        .then(() => this.flush())
        .then(
          () => source.ready(request, null),
          (error: unknown) => {
            owner.error(error);
            return source.ready(request, error instanceof Error ? error.message : String(error));
          },
        )
        .catch(owner.error);
    });
    return this.#load();
  }

  #load(): Promise<RunRestore> {
    this.#loading ??= (this.#context ??= this.#owner.ready().then(() => this.#source.get()))
      .then(async (context) => {
        if (this.#disposed) {
          this.#loading = undefined;
          return context;
        }
        await this.#owner.restore(context);
        this.#token = context.token;
        this.#last = '';
        return context;
      })
      .catch((error: unknown) => {
        if (!this.#failedInitialization) {
          this.#failedInitialization = true;
          this.#failedBaseline = contentsKey(this.#owner);
        }
        throw error;
      });
    return this.#loading;
  }

  failedInitialization(): boolean {
    return this.#failedInitialization;
  }

  changed(): void {
    if (!this.#token || this.#disposed) return;
    void this.flush().catch(this.#owner.error);
  }

  /** The switch under way, if any: a flush saves under the token it installs. */
  #switching(): Promise<void> | undefined {
    return this.#changing;
  }

  async flush(): Promise<void> {
    for (let changing = this.#switching(); changing; changing = this.#switching()) await changing;
    await this.#load();
    if (this.#owner.beforeSave) await this.#owner.beforeSave();
    for (let changing = this.#switching(); changing; changing = this.#switching()) await changing;
    if (this.#disposed || !this.#token) throw new Error('The run storage is not available.');
    const token = this.#token;
    const checkpoint = this.#owner.capture();
    const key = JSON.stringify([token, checkpoint.state, checkpoint.messages]);
    if (key === this.#last) {
      await this.#writes;
      return;
    }
    this.#last = key;
    const write = this.#writes
      .catch(() => undefined)
      .then(() => this.#source.save(token, checkpoint))
      .catch((error: unknown) => {
        if (this.#last === key) this.#last = '';
        throw error;
      });
    this.#writes = write;
    await write;
  }

  /**
   * A switch (B9 Design §9): drafts flushed and the old run saved, then `action`, the one op that
   * switches (null: cancelled, keeping the canvas and its token), then `open` (the stores reset and
   * the new canvas's mirror awaited), then its run read and restored under its new token. A flush
   * asked for meanwhile waits for it.
   */
  async switch(
    action: () => Promise<CanvasId | null>,
    open: (canvas: CanvasId) => Promise<void>,
  ): Promise<void> {
    const before = this.#changing;
    const done = Promise.withResolvers<undefined>();
    this.#changing = done.promise;
    try {
      await before;
      try {
        await this.#load();
        await this.#owner.beforeSave?.();
        // This switch owns the barrier; a public flush waits until the new token is installed.
        if (this.#token && !this.#disposed) {
          const token = this.#token,
            checkpoint = this.#owner.capture();
          this.#writes = this.#writes
            .catch(() => undefined)
            .then(() => this.#source.save(token, checkpoint));
          await this.#writes;
        }
      } catch (error) {
        if (!this.#failedInitialization) throw error;
      }
      const canvas = await action();
      if (canvas === null) return;
      this.#token = undefined;
      try {
        await open(canvas);
        const context = await this.#source.get();
        if (this.#disposed) return;
        await this.#owner.restore(context);
        this.#token = context.token;
        this.#last = '';
        this.#context = this.#loading = Promise.resolve(context);
        this.#failedInitialization = false;
        this.#failedBaseline = undefined;
      } catch (error) {
        this.#failedInitialization = true;
        this.#failedBaseline = contentsKey(this.#owner);
        this.#context = this.#loading = Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        void this.#loading.catch(() => undefined);
        throw error;
      }
    } finally {
      if (this.#changing === done.promise) this.#changing = undefined;
      done.resolve(undefined);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}

function contentsKey(owner: Owner): string {
  const { state, messages } = owner.capture();
  return JSON.stringify([state, messages]);
}
