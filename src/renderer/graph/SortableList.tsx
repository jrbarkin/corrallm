import { useRef } from 'react';
import type { ReactNode } from 'react';

import { useSortable } from './sortable';
import type { HandleProps } from './sortable';

export type { HandleProps } from './sortable';

/**
 * A list whose rows are reordered from a handle (useSortable). With `rowOf`, each row sits in that
 * row of the list's grid (a subgrid of All queues' rows).
 */
export function SortableList<T extends { id: string }>({
  items,
  className,
  label,
  onMove,
  rowOf,
  renderItem,
  isMovable,
}: {
  items: readonly T[];
  className: string;
  label?: string;
  onMove: (itemId: string, before: string | null) => void | Promise<void>;
  rowOf?: (item: T) => number | undefined;
  renderItem: (item: T, handle: HandleProps) => ReactNode;
  /** Read-only rows stay visible but never become drag sources or reorder destinations. */
  isMovable?: (item: T) => boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const movable = isMovable ? items.filter(isMovable) : items;
  const { ordered, dragging, handle } = useSortable(movable, onMove, () =>
    [...(list.current?.children ?? [])].filter((row) => row.hasAttribute('data-sortable')),
  );
  let at = 0;
  const shown = items.map((item) => (movable.includes(item) ? (ordered[at++] ?? item) : item));
  return (
    <ol ref={list} className={className} {...(label === undefined ? {} : { 'aria-label': label })}>
      {shown.map((item) => (
        <li
          key={item.id}
          className={item.id === dragging ? 'dragging' : undefined}
          // Where an item is, for what points at it (the links between queues, QueueLinks.tsx).
          data-item={item.id}
          data-sortable={movable.includes(item) ? '' : undefined}
          {...(rowOf ? { style: { gridRow: rowOf(item) } } : {})}
        >
          {renderItem(item, handle(item, movable.indexOf(item)))}
        </li>
      ))}
    </ol>
  );
}
