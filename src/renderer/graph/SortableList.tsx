import { useRef } from 'react';
import type { ReactNode } from 'react';

import { useSortable } from './sortable';
import type { HandleProps } from './sortable';

export type { HandleProps } from './sortable';

/** A list whose rows are reordered from a handle (useSortable). */
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
  const list = useRef<HTMLOListElement>(null);
  const { dragging, handle } = useSortable(items, onMove, () => [
    ...(list.current?.children ?? []),
  ]);
  return (
    <ol ref={list} className={className} {...(label === undefined ? {} : { 'aria-label': label })}>
      {items.map((item, index) => (
        <li
          key={item.id}
          className={item.id === dragging ? 'dragging' : undefined}
          // Where an item is, for what points at it (the links between queues, QueueLinks.tsx).
          data-item={item.id}
        >
          {renderItem(item, handle(item, index))}
        </li>
      ))}
    </ol>
  );
}
