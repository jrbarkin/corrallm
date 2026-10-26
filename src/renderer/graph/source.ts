import type { CanvasId } from '../../shared/canvas';
import type { TopicMirror } from '../api/topics';
import { CanvasFlow } from './flow';
import type { Flow } from './flow';

/** The shown canvas's live subscription, kept through run restore and canvas transitions. */
export class CanvasSource {
  readonly #mirror: TopicMirror;
  readonly #flow = new CanvasFlow();
  readonly #listeners = new Set<() => void>();
  #canvas: CanvasId;
  #last: Flow | undefined;
  #stop: (() => void) | undefined;
  #topics() {
    const c = this.#canvas;
    return [`canvas:${c}`, `run:${c}`, `needs:${c}`, `sessions:${c}`, `messages:${c}`] as const;
  }
  failure = (): string | undefined =>
    this.#topics()
      .map((topic) => this.#mirror.failure(topic))
      .find((error) => error !== undefined);
  available = (): boolean =>
    this.failure() === undefined &&
    this.#topics().every((topic) => this.#mirror.revision(topic) !== undefined);
  constructor(canvas: CanvasId, mirror: TopicMirror) {
    this.#canvas = canvas;
    this.#mirror = mirror;
  }
  get canvas(): CanvasId {
    return this.#canvas;
  }
  get topic(): `canvas:${CanvasId}` {
    return `canvas:${this.#canvas}`;
  }
  read = (): Flow | undefined => {
    const rows = this.#mirror.snapshot(this.topic),
      rev = this.#mirror.revision(this.topic);
    if (rows !== undefined && rev !== undefined)
      this.#last = this.#flow.read(this.#canvas, rev, rows);
    return this.#last;
  };
  required(): Flow {
    const flow = this.read();
    if (!flow) throw new Error('The canvas has not loaded.');
    return flow;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#listen();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop?.();
        this.#stop = undefined;
      }
    };
  };
  bind(canvas: CanvasId): void {
    if (canvas === this.#canvas) return;
    this.#stop?.();
    this.#stop = undefined;
    this.#canvas = canvas;
    this.#last = undefined;
    this.#listen();
    this.#tell();
  }
  ready(): Promise<void> {
    return Promise.all(this.#topics().map((topic) => this.#mirror.whenAt(topic, 0))).then(
      () => undefined,
    );
  }
  #listen(): void {
    if (this.#listeners.size > 0)
      this.#stop ??= (() => {
        const stops = this.#topics().map((topic) =>
          this.#mirror.subscribe(topic, () => {
            this.#tell();
          }),
        );
        return () => {
          for (const stop of stops) stop();
        };
      })();
  }
  #tell(): void {
    for (const listener of this.#listeners) listener();
  }
}
