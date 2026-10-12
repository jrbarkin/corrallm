import { useEffect, useId, useState } from 'react';
import type { RefObject } from 'react';

import type { LinkEnd, QueueLink } from './links';

/**
 * Lines between two queues side by side (links.ts): each from what a wait waits for to the wait,
 * across the gap between the columns (`[data-column="own"]` on the left, `"peer"` on the right),
 * drawn over `container`. They follow the rows as the columns scroll or change.
 */
export function QueueLinks({
  container,
  links,
}: {
  container: RefObject<HTMLElement | null>;
  links: readonly QueueLink[];
}) {
  const arrow = useId();
  const [paths, setPaths] = useState<readonly { key: string; d: string }[]>([]);

  // Measured after every render (rows move as queues change), and on scrolling and resizing; only
  // a change of path re-renders.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const base = root.getBoundingClientRect();
      /** Where a link meets an end: the row's edge facing the other column, kept in its column. */
      const point = (end: LinkEnd) => {
        const column = root.querySelector(`[data-column="${end.column}"]`);
        const row =
          end.item === null
            ? column?.querySelector('[data-end]')
            : [...(column?.querySelectorAll<HTMLElement>('[data-item]') ?? [])].find(
                (element) => element.dataset.item === end.item,
              );
        if (!column || !row) return undefined;
        const box = row.getBoundingClientRect();
        const bounds = column.getBoundingClientRect();
        const y = Math.min(Math.max(box.top + box.height / 2, bounds.top), bounds.bottom);
        return { x: (end.column === 'own' ? box.right : box.left) - base.left, y: y - base.top };
      };
      const next = links.flatMap((link) => {
        const from = point(link.from);
        const to = point(link.to);
        if (!from || !to) return [];
        const bend = (to.x - from.x) / 2;
        const d = `M ${String(from.x)} ${String(from.y)} C ${String(from.x + bend)} ${String(from.y)} ${String(to.x - bend)} ${String(to.y)} ${String(to.x)} ${String(to.y)}`;
        return [{ key: link.key, d }];
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
        <path key={path.key} data-link={path.key} d={path.d} markerEnd={`url(#${arrow})`} />
      ))}
    </svg>
  );
}
