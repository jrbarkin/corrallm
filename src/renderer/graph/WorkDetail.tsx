import { useEffect, useRef } from 'react';

import { AGENT_ACTIONS, DEFAULT_AGENT } from './agents';
import type { GraphNode } from './graph';
import type { Condition, WaitTarget } from './queue';
import { QueueEditor } from './QueueEditor';
import type { QueueEntry } from './QueueEditor';
import { isWorkBetween } from './work';

/** What a panel does to the queue of agent `owner`: QueueEditor's changes, by agent. */
export interface QueueEdits {
  add: (owner: string, entry: QueueEntry, into?: string) => void;
  remove: (owner: string, itemId: string) => void;
  move: (owner: string, itemId: string, index: number) => void;
  retarget: (owner: string, itemId: string, target: string | undefined) => void;
  editMessage: (owner: string, itemId: string, message: string) => void;
  setCondition: (owner: string, ifId: string, condition: Condition) => void;
  setWaitFor: (owner: string, waitId: string, targets: WaitTarget[]) => void;
}

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
  onClose,
}: {
  from: string;
  to: string;
  /** Every node of the graph: the two agents, and what their steps can act on. */
  nodes: readonly GraphNode[];
  edits: QueueEdits;
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
    const agent = owner.data.agent ?? DEFAULT_AGENT;
    return (
      <section className="graph-work-part" aria-label={`In ${name(owner)}'s queue`}>
        <h3>In {name(owner)}&apos;s queue</h3>
        <QueueEditor
          node={owner}
          nodes={nodes}
          agent={agent}
          actions={AGENT_ACTIONS[agent]}
          only={(item) => isWorkBetween(item, owner.id, from, to)}
          add={add}
          onAdd={(entry, into) => {
            edits.add(owner.id, entry, into);
          }}
          onRemove={(itemId) => {
            edits.remove(owner.id, itemId);
          }}
          onMove={(itemId, index) => {
            edits.move(owner.id, itemId, index);
          }}
          onRetarget={(itemId, agentId) => {
            edits.retarget(owner.id, itemId, agentId);
          }}
          onEditMessage={(itemId, message) => {
            edits.editMessage(owner.id, itemId, message);
          }}
          onCondition={(ifId, condition) => {
            edits.setCondition(owner.id, ifId, condition);
          }}
          onWaitFor={(waitId, targets) => {
            edits.setWaitFor(owner.id, waitId, targets);
          }}
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
