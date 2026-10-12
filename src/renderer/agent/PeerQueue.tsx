import type { GraphNode } from '../graph/graph';
import { itemLabel } from '../graph/labels';

/**
 * Another agent's queue, beside the open agent's (AgentView), to see how they wait on each other
 * (QueueLinks.tsx). While a wait's target is being picked (`picking`: what it is now, `undefined`
 * for all of the agent's work), each of its items, and all of its work, is a button that picks it.
 */
export function PeerQueue({
  node,
  picking,
  onPick,
  onClose,
}: {
  node: GraphNode;
  picking: { item: string | undefined } | undefined;
  onPick: (item: string | undefined) => void;
  onClose: () => void;
}) {
  const name = node.data.label || 'Unnamed agent';
  const queue = node.data.queue ?? [];
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
        <>
          <p className="agent-peer-hint">Pick what to wait for:</p>
          <button
            type="button"
            className="agent-peer-all"
            aria-label={`Wait for all of ${name}'s work`}
            aria-pressed={picking.item === undefined}
            onClick={() => {
              onPick(undefined);
            }}
          >
            All of {name}&apos;s work
          </button>
        </>
      )}
      <ol className="graph-queue agent-peer-queue">
        {queue.map((item) => (
          <li key={item.id} data-item={item.id}>
            {picking ? (
              <button
                type="button"
                className="graph-queue-row agent-peer-item"
                aria-label={`Wait for ${name}: ${itemLabel(item)}`}
                aria-pressed={picking.item === item.id}
                onClick={() => {
                  onPick(item.id);
                }}
              >
                {itemLabel(item)}
              </button>
            ) : (
              <div className="graph-queue-row agent-peer-item">{itemLabel(item)}</div>
            )}
          </li>
        ))}
      </ol>
      <p className="agent-queue-end" data-end>
        End of {name}&apos;s queue
      </p>
    </aside>
  );
}
