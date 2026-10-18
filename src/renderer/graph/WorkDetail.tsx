import { useEffect, useRef } from 'react';

import { actionsOf, DEFAULT_AGENT } from './agents';
import type { GraphNode } from './graph';
import { editsOf } from './edits';
import type { QueueEdits } from './edits';
import { QueueEditor } from './QueueEditor';
import type { RowMarks } from './QueueEditor';
import { isWorkBetween } from './work';

/**
 * The work from one agent for another (an edge from `from` to `to`, see work.ts): the steps and
 * messages `from`'s queue aims at `to`, where ⊕ queues more, and the waits in `to`'s queue for
 * `from`. It is a view onto those queues, so what it changes, it changes there. Escape, the close
 * button or a click outside closes it.
 */
export function WorkDetail({
  from,
  to,
  nodes,
  edits,
  marks,
  onClose,
}: {
  from: string;
  to: string;
  /** Every node of the graph: the two agents, and what their steps can act on. */
  nodes: readonly GraphNode[];
  edits: QueueEdits;
  /** How each agent's tasks are marked (queues/marks.ts). */
  marks: (agent: string, item: string | null) => RowMarks;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const source = nodes.find((n) => n.id === from);
  const target = nodes.find((n) => n.id === to);
  if (!source || !target) return null;
  const name = (node: GraphNode) => node.data.label || 'Unnamed agent';
  const waits = target.data.queue?.some((item) => isWorkBetween(item, to, from, to)) ?? false;

  /** The part of `owner`'s queue that makes this work. */
  const part = (owner: GraphNode, add: 'nothing' | { workFor: string }) => {
    const agent = owner.data.adapter ?? DEFAULT_AGENT;
    return (
      <section className="graph-work-part" aria-label={`In ${name(owner)}'s queue`}>
        <h3>In {name(owner)}&apos;s queue</h3>
        <QueueEditor
          node={owner}
          nodes={nodes}
          agent={agent}
          actions={actionsOf(agent)}
          only={(item) => isWorkBetween(item, owner.id, from, to)}
          add={add}
          {...editsOf(edits, owner.id)}
          marks={(item) => marks(owner.id, item)}
        />
      </section>
    );
  };

  return (
    <div
      className="graph-detail-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="graph-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`Work from ${name(source)} for ${name(target)}`}
        tabIndex={-1}
      >
        <div className="graph-detail-content">
          <header className="graph-detail-header">
            <h2>
              {name(source)} → {name(target)}
            </h2>
            <button
              type="button"
              className="graph-detail-close"
              aria-label="Close"
              onClick={onClose}
            />
          </header>
          {part(source, { workFor: to })}
          {waits && part(target, 'nothing')}
        </div>
      </div>
    </div>
  );
}
