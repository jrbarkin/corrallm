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
  #stop: (() => void) | undefined;
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
    return rows === undefined || rev === undefined
      ? undefined
      : this.#flow.read(this.#canvas, rev, rows);
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
    this.#listen();
    this.#tell();
  }
  ready(): Promise<void> {
    return this.#mirror.whenAt(this.topic, 0);
  }
  refresh(): Promise<void> {
    return this.#mirror.refresh(this.topic);
  }
  #listen(): void {
    if (this.#listeners.size > 0)
      this.#stop ??= this.#mirror.subscribe(this.topic, () => {
        this.#tell();
      });
  }
  #tell(): void {
    for (const listener of this.#listeners) listener();
  }
}
