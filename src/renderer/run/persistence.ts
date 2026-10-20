import type { RunCheckpoint, RunContext } from '../../shared/run';

/**
 * The core owns storage, the canvas's document and native conversation identity; the renderer
 * supplies queue metadata, and its edits to the document until they are operations of their own.
 */
export interface RunSource {
  get: () => Promise<RunContext>;
  save: (
    token: string,
    checkpoint: RunCheckpoint | null,
    document: string,
    rev: number,
  ) => Promise<number>;
  ready: (request: string, error: string | null) => Promise<null>;
  onStopping: (listener: (request: string) => void) => () => void;
}

interface Owner {
  capture: () => RunCheckpoint;
  /** The canvas as the renderer has it: its file's text. */
  document: () => string;
  revision: () => number;
  beforeSave?: () => Promise<void>;
  restore: (context: RunContext) => void | Promise<void>;
  freeze: () => void | Promise<void>;
  error: (error: unknown) => void;
}

/** Serial checkpoint writes and an acknowledged freeze before main closes native sessions. */
export class RunPersistence {
  #token: string | undefined;
  #context: Promise<RunContext> | undefined;
  #loading: Promise<RunContext> | undefined;
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
  initialize(): Promise<RunContext> {
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

  #load(): Promise<RunContext> {
    this.#loading ??= (this.#context ??= this.#source.get())
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

  /**
   * Call after main opens/saves/forgets a canvas: it rotates the storage generation. A flush asked
   * for meanwhile (as main quits) waits for it, then saves under the new token.
   */
  async rebind(restore: boolean): Promise<RunContext> {
    let release: (() => void) | undefined;
    const before = this.#changing;
    const changing = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#changing = changing;
    try {
      await before;
      await this.#writes.catch(() => undefined);
      this.#token = undefined;
      const context = await this.#source.get();
      if (this.#disposed) return context;
      if (restore) await this.#owner.restore(context);
      this.#token = context.token;
      this.#last = '';
      this.#context = this.#loading = Promise.resolve(context);
      this.#failedInitialization = false;
      this.#failedBaseline = undefined;
      return context;
    } finally {
      if (this.#changing === changing) this.#changing = undefined;
      release?.();
    }
  }

  changed(): void {
    if (!this.#token || this.#disposed) return;
    void this.flush().catch(this.#owner.error);
  }

  async flush(): Promise<void> {
    await this.#load();
    if (this.#owner.beforeSave) await this.#owner.beforeSave();
    while (this.#changing) await this.#changing;
    if (this.#disposed || !this.#token) throw new Error('The run storage is not available.');
    const token = this.#token;
    const checkpoint = this.#owner.capture();
    const document = this.#owner.document();
    const revision = this.#owner.revision();
    const key = JSON.stringify([token, document, checkpoint.state, checkpoint.messages]);
    if (key === this.#last) {
      await this.#writes;
      return;
    }
    this.#last = key;
    const write = this.#writes
      .catch(() => undefined)
      .then(async () => {
        await this.#source.save(token, checkpoint, document, revision);
      })
      .catch((error: unknown) => {
        if (this.#last === key) this.#last = '';
        throw error;
      });
    this.#writes = write;
    await write;
  }

  /** A temporary whole-document edit, guarded by the revision it was built from. */
  async editDocument(document: string, rev: number): Promise<number> {
    await this.#load();
    while (this.#changing) await this.#changing;
    const token = this.#token;
    if (this.#disposed || token === undefined) throw new Error('The run storage is not available.');
    const write = this.#writes
      .catch(() => undefined)
      .then(() => this.#source.save(token, this.#owner.capture(), document, rev));
    this.#writes = write;
    return write;
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
        if (shouldRestore) await this.#owner.restore(context);
      } catch (error) {
        // The selected file is already main's canvas. Detach it before the retained
        // renderer state can save, then bind that state to the recovered draft.
        if (shouldRestore && rejectedRestore) {
          this.#token = undefined;
          await rejectedRestore();
          const recovered = await this.#source.get();
          this.#token = recovered.token;
          this.#last = '';
          this.#context = this.#loading = Promise.resolve(recovered);
          this.#failedInitialization = false;
          this.#failedBaseline = undefined;
        }
        throw error;
      }
      this.#token = context.token;
      this.#last = '';
      this.#context = this.#loading = Promise.resolve(context);
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
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}

function contentsKey(owner: Owner): string {
  const { state, messages } = owner.capture();
  return JSON.stringify([owner.document(), state, messages]);
}
