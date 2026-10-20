import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { flushSync } from 'react-dom';

/** What a row's drag handle needs: spread onto the handle button. */
export interface HandleProps {
  'data-handle': string;
  onPointerDown: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * A drag previews an order locally and sends one move at drop; cancellation drops the preview.
 * Arrow keys send a move immediately. `ordered` projects the preview onto the latest item objects.
 */
export function useSortable<T extends { id: string }>(
  items: readonly T[],
  onMove: (itemId: string, before: string | null) => void | Promise<void>,
  rows: () => readonly Element[],
): {
  ordered: readonly T[];
  dragging: string | undefined;
  handle: (item: T, index: number) => HandleProps;
} {
  const [drag, setDrag] = useState<{ id: string; order: string[]; dropping?: boolean }>();
  const latest = useRef({ items, onMove, rows, drag });
  useLayoutEffect(() => {
    latest.current = { items, onMove, rows, drag };
  });
  const dragging = drag?.id;
  useEffect(() => {
    if (dragging === undefined) return;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const { drag, rows } = latest.current;
      if (!drag || drag.dropping) return;
      const elements = rows();
      const from = drag.order.indexOf(drag.id);
      const over = elements.findIndex((row) => {
        const box = row.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
      const to = over === -1 ? elements.length - 1 : over;
      if (from < 0 || to < 0 || to === from) return;
      const order = drag.order.filter((id) => id !== drag.id);
      order.splice(to, 0, drag.id);
      const next = { ...drag, order };
      latest.current.drag = next;
      setDrag(next);
    };
    const cancel = () => {
      latest.current.drag = undefined;
      setDrag(undefined);
    };
    const drop = () => {
      const { drag, items, onMove } = latest.current;
      if (!drag || drag.dropping) return;
      const order = preview(items, drag.order);
      const to = order.findIndex((item) => item.id === drag.id);
      const from = items.findIndex((item) => item.id === drag.id);
      const before = order[to + 1]?.id ?? null;
      if (to < 0 || from < 0 || before === (items[from + 1]?.id ?? null)) {
        cancel();
        return;
      }
      const pending = { ...drag, dropping: true };
      latest.current.drag = pending;
      setDrag(pending);
      // Operations resolve only once the mirror reached their revisions; keep the preview until then.
      const finished = () => {
        if (latest.current.drag === pending) cancel();
      };
      void Promise.resolve(onMove(drag.id, before)).then(finished, finished);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [dragging]);

  const ordered = drag ? preview(items, drag.order) : items;
  const handle = (item: T, index: number): HandleProps => ({
    'data-handle': item.id,
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const next = { id: item.id, order: items.map((item) => item.id) };
      latest.current.drag = next;
      setDrag(next);
    },
    onKeyDown: (event) => {
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const to = Math.min(Math.max(index + step, 0), items.length - 1);
      if (to === index) return;
      const button = event.currentTarget;
      flushSync(() => {
        void onMove(item.id, items.filter((one) => one.id !== item.id)[to]?.id ?? null);
      });
      if (button instanceof HTMLElement) button.focus();
    },
  });
  return { ordered, dragging, handle };
}

/** Keep the preview's order while using current objects, dropping removals and including additions. */
function preview<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): readonly T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return [
    ...order.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    }),
    ...items.filter((item) => !order.includes(item.id)),
  ];
}
