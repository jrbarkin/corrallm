import { useEffect, useId, useState } from 'react';
import type { RefObject } from 'react';

import type { LinkEnd, QueueLink } from './links';

/**
 * Lines between queues shown side by side (links.ts), drawn over `container`: each from one
 * column (an element with `data-column`, its box a `data-lane` element's if there is one) to
 * another, between the edges of the rows that face each other (`data-item`, or `data-end` for the
 * end of a queue), or to the other column's edge, level. They follow the rows as the columns
 * scroll or change.
 */
export function QueueLinks({
  container,
  links,
}: {
  container: RefObject<HTMLElement | null>;
  links: readonly QueueLink[];
}) {
  const arrow = useId();
  const [paths, setPaths] = useState<readonly { key: string; kind: string; d: string }[]>([]);

  // Measured after every render (rows move as queues change), and on scrolling and resizing; only
  // a change of path re-renders.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const base = root.getBoundingClientRect();
      const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
      const columnOf = (element: Element) => element.closest<HTMLElement>('[data-column]');
      const columnBox = (column: string) =>
        (
          all('[data-lane]').find((e) => e.dataset.lane === column) ??
          all('[data-column]').find((e) => e.dataset.column === column)
        )?.getBoundingClientRect();
      const rowOf = (end: LinkEnd) =>
        all(end.item === null ? '[data-end]' : '[data-item]').find(
          (e) =>
            columnOf(e)?.dataset.column === end.column &&
            (end.item === null || e.dataset.item === end.item),
        );
      /** Where a line meets `end`, on its `side` (facing the other column), `level` for an edge. */
      const at = (end: LinkEnd, side: 'left' | 'right', level: number | undefined) => {
        if (end.item === undefined) {
          const box = columnBox(end.column);
          if (!box || level === undefined) return undefined;
          return { x: box[side] - base.left, y: level };
        }
        const row = rowOf(end);
        if (!row) return undefined;
        const box = row.getBoundingClientRect();
        const bounds = columnOf(row)?.getBoundingClientRect() ?? box;
        const y = Math.min(Math.max(box.top + box.height / 2, bounds.top), bounds.bottom);
        return { x: box[side] - base.left, y: y - base.top };
      };
      const next = links.flatMap((link) => {
        const fromBox = columnBox(link.from.column);
        const toBox = columnBox(link.to.column);
        if (!fromBox || !toBox) return [];
        const rightwards = fromBox.left < toBox.left;
        const from = at(link.from, rightwards ? 'right' : 'left', undefined);
        const to = from && at(link.to, rightwards ? 'left' : 'right', from.y);
        if (!from || !to) return [];
        const bend = (to.x - from.x) / 2;
        const d = `M ${String(from.x)} ${String(from.y)} C ${String(from.x + bend)} ${String(from.y)} ${String(to.x - bend)} ${String(to.y)} ${String(to.x)} ${String(to.y)}`;
        return [{ key: link.key, kind: link.kind ?? 'wait', d }];
      });
      setPaths((now) => (JSON.stringify(now) === JSON.stringify(next) ? now : next));
    };
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    root.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
    };
  });

  return (
    <svg className="agent-links" aria-hidden="true">
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={path.key}
          data-link={path.key}
          data-kind={path.kind}
          d={path.d}
          markerEnd={`url(#${arrow})`}
        />
      ))}
    </svg>
  );
}
