import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';

/** What a row's drag handle needs: spread onto the handle button. */
export interface HandleProps {
  'data-handle': string;
  onPointerDown: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * A list whose rows are reordered from a handle: dragged (the row moves to wherever the pointer is
 * over), or with the arrow keys while the handle has focus (which it keeps).
 */
export function SortableList<T extends { id: string }>({
  items,
  className,
  label,
  onMove,
  renderItem,
}: {
  items: readonly T[];
  className: string;
  label?: string;
  onMove: (itemId: string, index: number) => void;
  renderItem: (item: T, handle: HandleProps) => ReactNode;
}) {
  /** The item being dragged by its handle. */
  const [dragging, setDragging] = useState<string>();
  const list = useRef<HTMLOListElement>(null);

  // Listening on the window rather than capturing the pointer: React moves the row in the DOM as it
  // reorders, which would release a capture.
  useEffect(() => {
    if (dragging === undefined) return;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const rows = [...(list.current?.children ?? [])];
      const from = items.findIndex((item) => item.id === dragging);
      const over = rows.findIndex((row) => {
        const box = row.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
      const to = over === -1 ? rows.length - 1 : over;
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
  }, [dragging, items, onMove]);

  return (
    <ol ref={list} className={className} {...(label === undefined ? {} : { 'aria-label': label })}>
      {items.map((item, index) => (
        <li
          key={item.id}
          className={item.id === dragging ? 'dragging' : undefined}
          // Where an item is, for what points at it (the links between queues, QueueLinks.tsx).
          data-item={item.id}
        >
          {renderItem(item, {
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
              // Moving the row in the DOM loses the handle's focus: move it now, then focus it
              // again.
              const handle = event.currentTarget;
              flushSync(() => {
                onMove(item.id, index + step);
              });
              if (handle instanceof HTMLElement) handle.focus();
            },
          })}
        </li>
      ))}
    </ol>
  );
}
