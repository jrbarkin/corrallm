import type { CanvasId } from '../../shared/canvas';
import type { GuiEventArgs } from '../../shared/gui-link';
import type { TerminalEvent } from '../../shared/terminal';
import type { Windows } from './windows';
import type { WindowId } from './host';

/** Canvas-scoped terminal screen events, independent of runtime topics and operations. */
export class TerminalEvents {
  readonly #windows: Pick<Windows, 'showing'>;
  readonly #listeners = new Map<
    WindowId,
    Set<(name: 'terminal', args: GuiEventArgs<'terminal'>) => void>
  >();
  constructor(windows: Pick<Windows, 'showing'>) {
    this.#windows = windows;
  }
  listen(
    window: WindowId,
    listener: (name: 'terminal', args: GuiEventArgs<'terminal'>) => void,
  ): () => void {
    const listeners = this.#listeners.get(window) ?? new Set();
    this.#listeners.set(window, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(window);
    };
  }
  emit(canvas: CanvasId, agent: string, event: TerminalEvent): void {
    for (const window of this.#windows.showing(canvas))
      for (const listener of this.#listeners.get(window) ?? [])
        listener('terminal', [agent, event]);
  }
}
