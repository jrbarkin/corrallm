import { actionsOf, DEFAULT_AGENT } from '../graph/agents';
import { editsOf } from '../graph/edits';
import type { QueueEdits } from '../graph/edits';
import type { GraphNode } from '../graph/graph';
import { QueueEditor } from '../graph/QueueEditor';
import type { RowMarks } from '../graph/QueueEditor';

/**
 * Another agent's queue, beside the open agent's (AgentView), to see how they wait on each other
 * (QueueLinks.tsx): the same queue, edited the same way, as everywhere else (QueueEditor). While a
 * wait's target is picked from it (`picking`: what it is now, `undefined` for all of the agent's
 * work), each of its items, and its end, picks.
 */
export function PeerQueue({
  node,
  nodes,
  edits,
  marks,
  picking,
  onPick,
  onClose,
}: {
  node: GraphNode;
  nodes: readonly GraphNode[];
  edits: QueueEdits;
  marks: (agent: string, item: string | null) => RowMarks;
  picking: { item: string | undefined } | undefined;
  onPick: (item: string | undefined) => void;
  onClose: () => void;
}) {
  const name = node.data.label || 'Unnamed agent';
  const agent = node.data.adapter ?? DEFAULT_AGENT;
  return (
    <aside className="agent-side agent-peer" data-column="peer" aria-label={`${name}'s queue`}>
      <header className="agent-peer-header">
        <h2 className="agent-side-title">{name}&apos;s queue</h2>
        <button
          type="button"
          className="graph-detail-close"
          aria-label={`Close ${name}'s queue`}
          onClick={onClose}
        />
      </header>
      {picking && (
        <p className="agent-peer-hint">
          Pick what to wait for: one of its tasks, or its end for all of its work.
        </p>
      )}
      <QueueEditor
        node={node}
        nodes={nodes}
        agent={agent}
        actions={actionsOf(agent)}
        {...editsOf(edits, node.id)}
        marks={(item) => marks(node.id, item)}
        addLabel={`Add to ${name}'s queue`}
        picking={picking && { name, current: picking.item, onPick }}
      />
    </aside>
  );
}
