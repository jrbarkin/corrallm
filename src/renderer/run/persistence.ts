import type { RunCheckpoint, RunContext } from '../../shared/run';

/** Main owns storage and native conversation identity; the renderer supplies queue metadata. */
export interface RunSource {
  get: () => Promise<RunContext>;
  save: (token: string, checkpoint: RunCheckpoint | null) => Promise<null>;
  ready: (request: string, error: string | null) => Promise<null>;
  onStopping: (listener: (request: string) => void) => () => void;
}

interface Owner {
  capture: () => RunCheckpoint;
  restore: (context: RunContext) => void;
  freeze: () => void;
  error: (error: unknown) => void;
}

/** Serial checkpoint writes and an acknowledged freeze before main closes native sessions. */
export class RunPersistence {
  #token: string | undefined;
  #loading: Promise<RunContext> | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #last = '';
  #changing: Promise<void> | undefined;
  #failedInitialization = false;
  #failedBaseline: string | undefined;
  readonly #source: RunSource;
  readonly #owner: Owner;
  readonly #unsubscribe: () => void;

  constructor(source: RunSource, owner: Owner) {
    this.#source = source;
    this.#owner = owner;
    this.#unsubscribe = source.onStopping((request) => {
      if (this.#failedInitialization) {
        const unchanged = this.#failedBaseline === contentsKey(owner.capture());
        const error = unchanged
          ? null
          : 'Run progress could not be loaded. Use New or Open before closing changed work.';
        if (error !== null) owner.error(new Error(error));
        void source.ready(request, error).catch(owner.error);
        return;
      }
      owner.freeze();
      void this.flush()
        .then(
          () => source.ready(request, null),
          (error: unknown) => {
            owner.error(error);
            return source.ready(request, error instanceof Error ? error.message : String(error));
          },
        )
        .catch(owner.error);
    });
  }

  initialize(): Promise<RunContext> {
    this.#loading ??= this.#source
      .get()
      .then((context) => {
        if (this.#disposed) return context;
        this.#owner.restore(context);
        this.#token = context.token;
        this.#last = '';
        return context;
      })
      .catch((error: unknown) => {
        this.#failedInitialization = true;
        this.#failedBaseline = contentsKey(this.#owner.capture());
        throw error;
      });
    return this.#loading;
  }

  /** A rejected restore stays untouched until the user explicitly chooses another canvas. */
  async prepareForReplacement(): Promise<void> {
    try {
      await this.flush();
    } catch (error) {
      if (!this.#failedInitialization) throw error;
    }
  }

  failedInitialization(): boolean {
    return this.#failedInitialization;
  }

  /** Call after main opens/saves/forgets a canvas: it rotates the storage generation. */
  async rebind(restore: boolean): Promise<RunContext> {
    await this.#writes.catch(() => undefined);
    this.#token = undefined;
    const context = await this.#source.get();
    if (this.#disposed) return context;
    if (restore) this.#owner.restore(context);
    this.#token = context.token;
    this.#last = '';
    this.#loading = Promise.resolve(context);
    this.#failedInitialization = false;
    this.#failedBaseline = undefined;
    return context;
  }

  changed(): void {
    if (!this.#token || this.#disposed) return;
    void this.flush().catch(this.#owner.error);
  }

  async flush(): Promise<void> {
    await this.initialize();
    while (this.#changing) await this.#changing;
    if (this.#disposed || !this.#token) throw new Error('The run storage is not available.');
    const token = this.#token;
    const checkpoint = this.#owner.capture();
    const key = JSON.stringify([token, checkpoint.workflow, checkpoint.state, checkpoint.messages]);
    if (key === this.#last) {
      await this.#writes;
      return;
    }
    this.#last = key;
    const write = this.#writes
      .catch(() => undefined)
      .then(async () => {
        await this.#source.save(token, checkpoint);
      })
      .catch((error: unknown) => {
        if (this.#last === key) this.#last = '';
        throw error;
      });
    this.#writes = write;
    await write;
  }

  /** Hold writes/sends across main's canvas-token change, without interrupting native work. */
  async transition<T>(
    action: () => Promise<T>,
    restore: boolean | ((value: T) => boolean),
    rejectedRestore?: () => Promise<unknown>,
  ): Promise<T> {
    let release: (() => void) | undefined;
    const before = this.#changing;
    const changing = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#changing = changing;
    try {
      await before;
      await this.#writes;
      const result = await action();
      const shouldRestore = typeof restore === 'function' ? restore(result) : restore;
      let context: RunContext;
      try {
        context = await this.#source.get();
        if (shouldRestore) this.#owner.restore(context);
      } catch (error) {
        // The selected file is already main's canvas. Detach it before the retained
        // renderer state can save, then bind that state to the recovered draft.
        if (shouldRestore && rejectedRestore) {
          this.#token = undefined;
          await rejectedRestore();
          const recovered = await this.#source.get();
          this.#token = recovered.token;
          this.#last = '';
          this.#loading = Promise.resolve(recovered);
          this.#failedInitialization = false;
          this.#failedBaseline = undefined;
        }
        throw error;
      }
      this.#token = context.token;
      this.#last = '';
      this.#loading = Promise.resolve(context);
      this.#failedInitialization = false;
      this.#failedBaseline = undefined;
      return result;
    } finally {
      if (this.#changing === changing) this.#changing = undefined;
      release?.();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
  }
}

function contentsKey(checkpoint: RunCheckpoint): string {
  return JSON.stringify([checkpoint.workflow, checkpoint.state, checkpoint.messages]);
}
