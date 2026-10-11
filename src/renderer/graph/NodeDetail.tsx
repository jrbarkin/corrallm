import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import type { GraphNode } from './graph';
import { QueueItemKind } from './queue';

/**
 * A node opened up, the way an iOS folder opens: the panel grows out of the node's card to fill
 * most of the editor, over a blurred canvas, and shrinks back into it when closed (Escape, the
 * close button, or a click outside). It renames the node and edits its queue.
 */
export function NodeDetail({
  node,
  origin,
  onRename,
  onAdd,
  onRemove,
  onClose,
}: {
  node: GraphNode;
  /** Where the node's card is on screen: the panel grows from it and shrinks back into it. */
  origin: () => DOMRect | undefined;
  onRename: (label: string) => void;
  onAdd: (kind: QueueItemKind) => void;
  onRemove: (itemId: string) => void;
  onClose: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    panel.current?.focus();
    const from = origin();
    if (!from || !panel.current || !content.current || !backdrop.current) return;
    morph(panel.current, from, 'open');
    animate(backdrop.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    animate(content.current, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      delay: 160,
      fill: 'backwards',
    });
  }, [origin]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const to = origin();
    const shrinking = (
      to && panel.current && content.current && backdrop.current
        ? [
            morph(panel.current, to, 'close'),
            animate(content.current, [{ opacity: 1 }, { opacity: 0 }], {
              duration: 100,
              fill: 'forwards',
            }),
            animate(backdrop.current, [{ opacity: 1 }, { opacity: 0 }], {
              duration: 260,
              fill: 'forwards',
            }),
          ]
        : []
    ).filter((animation) => animation !== undefined);
    if (shrinking.length === 0) onClose();
    else void Promise.all(shrinking.map((animation) => animation.finished)).then(onClose, onClose);
  }, [origin, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close]);

  const label = node.data.label;
  const queue = node.data.queue ?? [];
  return (
    <div
      ref={backdrop}
      className="graph-detail-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        className="graph-detail"
        role="dialog"
        aria-modal="true"
        aria-label={label || 'Unnamed node'}
        tabIndex={-1}
      >
        <div ref={content} className="graph-detail-content">
          <header className="graph-detail-header">
            <input
              aria-label="Name"
              value={label}
              placeholder="Unnamed node"
              onChange={(event) => {
                onRename(event.target.value);
              }}
            />
            <button
              type="button"
              className="graph-detail-close"
              aria-label="Close"
              onClick={close}
            />
          </header>
          <h2>Queue</h2>
          {queue.length === 0 ? (
            <p className="graph-queue-empty">Nothing queued yet.</p>
          ) : (
            <ol className="graph-queue">
              {queue.map((item) => (
                <li key={item.id}>
                  {item.kind}
                  <button
                    type="button"
                    className="graph-queue-remove"
                    aria-label={`Remove ${item.kind}`}
                    onClick={() => {
                      onRemove(item.id);
                    }}
                  />
                </li>
              ))}
            </ol>
          )}
          <div className="graph-queue-add" role="group" aria-label="Add to queue">
            {Object.values(QueueItemKind).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-label={`Add ${kind}`}
                onClick={() => {
                  onAdd(kind);
                }}
              >
                + {kind}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Animates the panel between the node's card (`card`, on screen) and its own box: growing out of
 * the card when opening, shrinking back into it when closing.
 */
function morph(element: HTMLElement, card: DOMRect, direction: 'open' | 'close') {
  const box = element.getBoundingClientRect();
  const atCard = {
    transform: `translate(${String(card.left - box.left)}px, ${String(card.top - box.top)}px) scale(${String(card.width / box.width)}, ${String(card.height / box.height)})`,
  };
  const atBox = { transform: 'none' };
  return direction === 'open'
    ? animate(element, [atCard, atBox], { duration: 380, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' })
    : animate(element, [atBox, atCard], {
        duration: 260,
        easing: 'cubic-bezier(0.4, 0, 0.8, 0.4)',
        fill: 'forwards',
      });
}

/** `element.animate`, unless the user asked for reduced motion or there is no Web Animations API. */
function animate(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | undefined {
  if (!('animate' in element)) return undefined;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
  return element.animate(keyframes, options);
}
