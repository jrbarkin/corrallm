import { useEffect, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { flushSync } from 'react-dom';

/** What a row's drag handle needs: spread onto the handle button. */
export interface HandleProps {
  'data-handle': string;
  onPointerDown: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * Reordering items from a handle: dragged (an item moves to wherever the pointer is over, among
 * `rows()`, an element per item in order), or with the arrow keys while the handle has focus
 * (which it keeps). `handle(item, index)` gives what to spread onto an item's handle.
 */
export function useSortable<T extends { id: string }>(
  items: readonly T[],
  onMove: (itemId: string, index: number) => void,
  rows: () => readonly Element[],
): { dragging: string | undefined; handle: (item: T, index: number) => HandleProps } {
  /** The item being dragged by its handle. */
  const [dragging, setDragging] = useState<string>();

  // Listening on the window rather than capturing the pointer: React moves the row in the DOM as it
  // reorders, which would release a capture.
  useEffect(() => {
    if (dragging === undefined) return;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const elements = rows();
      const from = items.findIndex((item) => item.id === dragging);
      const over = elements.findIndex((row) => {
        const box = row.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
      const to = over === -1 ? elements.length - 1 : over;
      if (from !== -1 && to !== from) onMove(dragging, to);
    };
    const onPointerUp = () => {
      setDragging(undefined);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [dragging, items, onMove, rows]);

  const handle = (item: T, index: number): HandleProps => ({
    'data-handle': item.id,
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(item.id);
    },
    onKeyDown: (event) => {
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (step === 0) return;
      event.preventDefault();
      // Moving the row in the DOM loses the handle's focus: move it now, then focus it again.
      const button = event.currentTarget;
      flushSync(() => {
        onMove(item.id, index + step);
      });
      if (button instanceof HTMLElement) button.focus();
    },
  });
  return { dragging, handle };
}
