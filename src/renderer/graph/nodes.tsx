import {
  BaseEdge,
  EdgeToolbar,
  getBezierPath,
  Handle,
  NodeToolbar,
  Position,
  useStore,
} from '@xyflow/react';
import type { EdgeProps, NodeProps } from '@xyflow/react';
import { startTransition, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useGraphActions } from './actions';
import type { GraphNode } from './graph';
import { SHORTCUTS } from './keys';

/**
 * An item: a card with a dot on top and one at the bottom. An edge runs from the dot a drag starts
 * at to the dot it ends at, so both dots are sources (React Flow's loose connection mode). While
 * the item has children React Flow adds the `parent` class, and GraphEditor.css draws a box around
 * them with the card centred on its top border. Hovering the card shows its actions.
 */
export function ItemNodeView({ id, data, parentId }: NodeProps<GraphNode>) {
  const hover = useHover();
  const isParent = useStore((state) => state.parentLookup.has(id));
  const { remove, ungroup } = useGraphActions();
  return (
    <div className="graph-card" {...hover.target}>
      <Handle type="source" id="top" position={Position.Top} />
      <Label id={id} label={data.label} />
      <QueueCount count={data.queue?.length ?? 0} />
      <Handle type="source" id="bottom" position={Position.Bottom} />
      <NodeToolbar isVisible={hover.active} className="graph-actions" {...hover.target}>
        {isParent && (
          <ActionButton
            title={`Release the nodes in this group (${SHORTCUTS.ungroup})`}
            onClick={() => {
              ungroup(id);
            }}
          >
            Ungroup
          </ActionButton>
        )}
        {!isParent && parentId !== undefined && (
          <ActionButton
            title={`Move this node out of its group (${SHORTCUTS.ungroup})`}
            onClick={() => {
              ungroup(id);
            }}
          >
            Remove from group
          </ActionButton>
        )}
        <ActionButton
          title={
            isParent
              ? "Delete this node (Delete). Its group's nodes are kept."
              : 'Delete this node (Delete)'
          }
          onClick={() => {
            remove(id);
          }}
        >
          Delete
        </ActionButton>
      </NodeToolbar>
    </div>
  );
}

/**
 * A frame: a label bar over a see-through body. No dots, so it cannot be connected. Hovering the
 * label bar shows its actions, and a '+' on the middle of its top border that gives it a parent node.
 */
export function FrameNodeView({ id, data, selected }: NodeProps<GraphNode>) {
  const hover = useHover();
  const { addParent, remove, ungroup } = useGraphActions();
  return (
    <>
      <div className="graph-frame-title" {...hover.target}>
        <Label id={id} label={data.label} />
      </div>
      <button
        type="button"
        className={`graph-add-parent nodrag nopan${hover.active || selected ? ' shown' : ''}`}
        aria-label="Add a parent node"
        title="Add a parent node"
        onClick={() => {
          addParent(id);
        }}
        {...hover.target}
      ></button>
      <NodeToolbar isVisible={hover.active} align="end" className="graph-actions" {...hover.target}>
        <ActionButton
          title={`Release the nodes in this group (${SHORTCUTS.ungroup})`}
          onClick={() => {
            ungroup(id);
          }}
        >
          Ungroup
        </ActionButton>
        <ActionButton
          title="Delete this group (Delete). Its nodes are kept."
          onClick={() => {
            remove(id);
          }}
        >
          Delete
        </ActionButton>
      </NodeToolbar>
    </>
  );
}

/** An edge with an arrowhead at its target. When it is selected, a button on it deletes it. */
export function EdgeView({ id, markerEnd, interactionWidth, ...geometry }: EdgeProps) {
  const { removeEdge } = useGraphActions();
  const [path, labelX, labelY] = getBezierPath(geometry);
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        {...(interactionWidth ? { interactionWidth } : {})}
      />
      <EdgeToolbar edgeId={id} x={labelX} y={labelY} className="graph-actions">
        <ActionButton
          title="Delete this edge (Delete)"
          aria-label="Delete edge"
          onClick={() => {
            removeEdge(id);
          }}
        >
          ×
        </ActionButton>
      </EdgeToolbar>
    </>
  );
}

/** A node's label. Double-click or F2 edits it in place: Enter or leaving the field keeps the text, Escape restores it. */
function Label({ id, label }: { id: string; label: string }) {
  const { editing } = useGraphActions();
  if (editing === id) return <LabelInput id={id} label={label} />;
  return (
    <div className="graph-label" title={label}>
      {label}
    </div>
  );
}

function LabelInput({ id, label }: { id: string; label: string }) {
  const { rename, stopEditing } = useGraphActions();
  const [original] = useState(label);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="graph-label nodrag"
      aria-label="Label"
      value={label}
      onChange={(event) => {
        rename(id, event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') stopEditing();
        if (event.key === 'Escape') {
          rename(id, original);
          stopEditing();
        }
      }}
      onBlur={stopEditing}
    />
  );
}

/** How many items are queued on a node. The number is drawn by CSS, so it is not part of the label. */
function QueueCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="graph-queue-count" data-count={count} title={`${String(count)} queued`} />
  );
}

function ActionButton({
  onClick,
  children,
  ...rest
}: {
  onClick: () => void;
  children: ReactNode;
  title: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      className="nodrag nopan"
      onClick={(event) => {
        // The toolbar renders in a portal, but React still bubbles the click to the node.
        event.stopPropagation();
        onClick();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Hover over a node or its toolbar. Leaving keeps it for a moment, so the pointer can cross the gap
 * between them. The updates are transitions, so React handles a press first: a hover render that
 * ran ahead of a press on a dot made React Flow drop about one connection in ten (seen with
 * Playwright's back-to-back input).
 */
function useHover() {
  const [active, setActive] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );
  const target = {
    onMouseEnter: () => {
      window.clearTimeout(timer.current);
      startTransition(() => {
        setActive(true);
      });
    },
    onMouseLeave: () => {
      timer.current = window.setTimeout(() => {
        startTransition(() => {
          setActive(false);
        });
      }, 200);
    },
  };
  return { active, target };
}
