import type { CanvasId } from '../../shared/canvas';
import type { WindowId } from './host';

/** The effective launch identity, never a desired worktree plan or a native turn's state. */
export interface ViewedSession {
  owner: object;
  key: string;
  held?: string;
}

interface Lease {
  canvas: CanvasId;
  agent: string;
  windows: Map<WindowId, ReturnType<typeof setTimeout> | undefined>;
  stop: () => void;
  dirty: boolean;
  checking: boolean;
  seen?: ViewedSession;
  failure?: string;
}

export interface SessionViewsDeps {
  inspect(canvas: CanvasId, agent: string): Promise<ViewedSession | undefined>;
  /** False defers a launch across a shutdown barrier without remembering a refusal. */
  open(canvas: CanvasId, agent: string): Promise<boolean>;
  say(canvas: CanvasId, agent: string, text: string, held: boolean): void;
  watch(canvas: CanvasId, changed: () => void): () => void;
}

/** A view asks for an open session, but never owns its lifetime or retries a refused generation. */
export class SessionViews {
  readonly #deps: SessionViewsDeps;
  readonly #leases = new Map<string, Lease>();
  #closed = false;

  constructor(deps: SessionViewsDeps) {
    this.#deps = deps;
  }

  acquire(window: WindowId, canvas: CanvasId, agent: string): () => void {
    if (this.#closed) return () => undefined;
    const key = JSON.stringify([canvas, agent]);
    let lease = this.#leases.get(key);
    if (!lease) {
      lease = {
        canvas,
        agent,
        windows: new Map(),
        stop: () => undefined,
        dirty: true,
        checking: false,
      };
      this.#leases.set(key, lease);
      const current = lease;
      lease.stop = this.#deps.watch(canvas, () => {
        this.#changed(key, current);
      });
    }
    clearTimeout(lease.windows.get(window));
    lease.windows.set(window, undefined);
    this.#changed(key, lease);
    const current = lease;
    let released = false;
    return () => {
      if (released || this.#leases.get(key) !== current) return;
      released = true;
      // React's rehearsal can remove and re-add this window/topic within the same turn.
      const timer = setTimeout(() => {
        current.windows.delete(window);
        if (current.windows.size > 0) return;
        current.stop();
        this.#leases.delete(key);
      }, 0);
      timer.unref();
      current.windows.set(window, timer);
    };
  }

  /** A cancelled shutdown makes deferred view admission possible again. */
  changed(): void {
    for (const [key, lease] of this.#leases) this.#changed(key, lease);
  }

  close(): void {
    this.#closed = true;
    for (const lease of this.#leases.values()) {
      lease.stop();
      for (const timer of lease.windows.values()) clearTimeout(timer);
    }
    this.#leases.clear();
  }

  #changed(key: string, lease: Lease): void {
    lease.dirty = true;
    if (lease.checking) return;
    lease.checking = true;
    void this.#check(key, lease).finally(() => {
      lease.checking = false;
      if (lease.dirty && !this.#closed && this.#leases.get(key) === lease)
        this.#changed(key, lease);
    });
  }

  async #check(key: string, lease: Lease): Promise<void> {
    const current = () => !this.#closed && this.#leases.get(key) === lease;
    // Availability callbacks can dirty the lease during either awaited read or launch.
    const dirty = () => lease.dirty;
    while (current() && dirty()) {
      lease.dirty = false;
      try {
        const state = await this.#deps.inspect(lease.canvas, lease.agent);
        if (!current()) return;
        if (dirty()) continue;
        if (!state) {
          delete lease.seen;
          delete lease.failure;
          continue;
        }
        if (lease.seen?.owner === state.owner && lease.seen.key === state.key) {
          if (lease.failure !== undefined) {
            this.#deps.say(lease.canvas, lease.agent, lease.failure, false);
            delete lease.failure;
          }
          continue;
        }
        delete lease.failure;
        lease.seen = state;
        if (state.held !== undefined) this.#deps.say(lease.canvas, lease.agent, state.held, true);
        else if (!(await this.#deps.open(lease.canvas, lease.agent))) delete lease.seen;
      } catch (error) {
        if (!current()) return;
        lease.failure = error instanceof Error ? error.message : String(error);
        if (!dirty()) {
          this.#deps.say(lease.canvas, lease.agent, lease.failure, false);
          delete lease.failure;
        }
      }
    }
  }
}
