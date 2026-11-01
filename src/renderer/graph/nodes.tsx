import {
  BaseEdge,
  EdgeToolbar,
  getBezierPath,
  Handle,
  NodeToolbar,
  Position,
  useStore,
} from '@xyflow/react';
import type { Edge, EdgeProps, NodeProps } from '@xyflow/react';
import { startTransition, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { AdapterLogo } from '../AdapterLogo';
import { WorkspaceBadge } from '../workspaces/Workspace';
import { BranchControls } from '../workspaces/BranchReview';
import { useLabel } from '../useDraft';
import { useGraphActions } from './actions';
import { pointOnBezier } from './curve';
import { agentLabel, connectionOf, DEFAULT_AGENT } from './agents';
import type { GraphNode } from './flow';
import { SHORTCUTS } from './keys';
import { isBlank } from '../../shared/model/queue';

/**
 * An item: a card with a dot on top and one at the bottom. An edge runs from the dot a drag starts
 * at to the dot it ends at, so both dots are sources (React Flow's loose connection mode). While
 * the item has children React Flow adds the `parent` class, and GraphEditor.css draws a box around
 * them with the card centred on its top border. Hovering the card shows its actions.
 */
export function AgentNodeView({ id, data, parentId }: NodeProps<GraphNode>) {
  const hover = useHover();
  const isParent = useStore((state) => state.parentLookup.has(id));
  const { remove, ungroup, queueState, groupState, card: cardOf } = useGraphActions();
  const card = cardOf?.(id) ?? { status: 'Idle', line: 'Idle', completed: 0, total: 0 };
  const progress = card.total === 0 ? 0 : Math.round((card.completed / card.total) * 100);
  const state = queueState?.(id);
  const group = isParent ? groupState?.(id) : undefined;
  return (
    <div
      className="graph-card"
      data-agent={data.adapter ?? DEFAULT_AGENT}
      data-status={card.status}
      title={`Agent: ${agentLabel(data.adapter ?? DEFAULT_AGENT, connectionOf(data))}`}
      {...hover.target}
    >
      <Handle type="source" id="top" position={Position.Top} />
      <div className="graph-card-top">
        <AdapterLogo adapter={data.adapter ?? DEFAULT_AGENT} size={15} />
        <Label id={id} label={data.label} />
        <span className="graph-card-status-dot" aria-hidden="true" />
      </div>
      <div className="graph-card-status" title={card.line}>
        {card.line}
      </div>
      <WorkspaceBadge agent={id} card />
      <div
        className="graph-card-progress"
        role="progressbar"
        aria-label={`${data.label || 'Unnamed agent'} queue progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={`${String(card.completed)} of ${String(card.total)} queued items finished`}
      >
        <i style={{ width: `${String(progress)}%` }} />
      </div>
      <QueueCount count={data.queue?.filter((item) => !isBlank(item)).length ?? 0} />
      {state && (
        <span
          className="graph-agent-control"
          aria-label={`${data.label || 'Unnamed agent'} queue ${state.toLowerCase()}`}
        >
          {state}
        </span>
      )}
      {group && (
        <span
          className="graph-group-control"
          aria-label={`${data.label || 'Unnamed group'} group ${group.toLowerCase()}`}
        >
          Group {group.toLowerCase()}
        </span>
      )}
      <Handle type="source" id="bottom" position={Position.Bottom} />
      <NodeToolbar isVisible={hover.active} className="graph-actions" {...hover.target}>
        <BranchControls agent={id} />
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
            title={`Move this agent out of its group (${SHORTCUTS.ungroup})`}
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
              ? "Delete this agent (Delete). Its group's nodes are kept."
              : 'Delete this agent (Delete)'
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
export function GroupNodeView({ id, data, selected }: NodeProps<GraphNode>) {
  const hover = useHover();
  const { addParent, remove, ungroup, groupState } = useGraphActions();
  const state = groupState?.(id);
  return (
    <>
      <div className="graph-frame-title" data-held={state ? '' : undefined} {...hover.target}>
        <Label id={id} label={data.label} />
        {state && (
          <span
            className="graph-frame-control"
            aria-label={`${data.label || 'Unnamed group'} group ${state.toLowerCase()}`}
          >
            {state}
          </span>
        )}
      </div>
      <button
        type="button"
        className={`graph-add-parent nodrag nopan${hover.active || selected ? ' shown' : ''}`}
        aria-label="Add a parent agent"
        title="Add a parent agent"
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
/** A link between two agents that can talk to each other: a line, and while selected, its delete button. */
export function LinkView({ id, interactionWidth, ...geometry }: EdgeProps) {
  const { removeEdge } = useGraphActions();
  const [path, labelX, labelY] = getBezierPath(geometry);
  return (
    <>
      <BaseEdge path={path} {...(interactionWidth ? { interactionWidth } : {})} />
      <EdgeToolbar edgeId={id} x={labelX} y={labelY} className="graph-actions">
        <ActionButton
          title="Delete this link (Delete)"
          aria-label="Delete link"
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

/** How far apart (px) two arrows between the same agents run, each this far from the middle. */
const LANE_GAP = 6;

/** Work queued from one agent for another (work.ts), as React Flow draws it. */
export type WorkFlowEdge = Edge<
  {
    count: number;
    conditional: boolean;
    /**
     * When work flows the other way too, which side of the line between the two this arrow runs
     * on (1 or -1), so that the two run side by side; otherwise 0.
     */
    lane: -1 | 0 | 1;
    fromName: string;
    toName: string;
  },
  'work'
>;

/**
 * Work from one agent for another: an arrow, and a button with how many items (marked "if" when all
 * of them wait on a condition), which opens them.
 */
export function WorkEdgeView({
  id,
  source,
  target,
  data,
  markerEnd,
  interactionWidth,
  ...geometry
}: EdgeProps<WorkFlowEdge>) {
  const { openWork } = useGraphActions();
  // Two arrows between the same agents run side by side, each count nearer its arrow's sender.
  const lane = (data?.lane ?? 0) * LANE_GAP;
  const ends = { ...geometry, sourceX: geometry.sourceX + lane, targetX: geometry.targetX + lane };
  const [path, labelX, labelY] = getBezierPath(ends);
  const at = lane === 0 ? { x: labelX, y: labelY } : pointOnBezier(ends, 0.35);
  const count = data?.count ?? 0;
  const conditional = data?.conditional ?? false;
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        {...(interactionWidth ? { interactionWidth } : {})}
      />
      <EdgeToolbar edgeId={id} x={at.x} y={at.y} isVisible>
        <button
          type="button"
          className={conditional ? 'graph-work-count conditional' : 'graph-work-count'}
          aria-label={`Open the work from ${data?.fromName ?? ''} for ${data?.toName ?? ''}`}
          title={`${String(count)} queued${conditional ? ', on a condition' : ''}. Click to open.`}
          onClick={() => {
            openWork(source, target);
          }}
        >
          {conditional && <span className="graph-work-if">if</span>}
          {conditional && ' '}
          {count}
        </button>
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
  const { problem, ...draft } = useLabel(label, (text) => {
    return rename(id, text);
  });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <>
      <input
        ref={input}
        className="graph-label nodrag"
        aria-label="Label"
        {...draft}
        onKeyDown={(event) => {
          const kept = draft.onKeyDown(event);
          if (!event.nativeEvent.isComposing && (event.key === 'Enter' || event.key === 'Escape')) {
            if (kept instanceof Promise)
              void kept.then((ok) => {
                if (ok) stopEditing();
              });
            else if (kept !== false) stopEditing();
          }
        }}
        onBlur={() => {
          const kept = draft.onBlur();
          if (kept instanceof Promise)
            void kept.then((ok) => {
              if (ok) stopEditing();
            });
          else if (kept) stopEditing();
        }}
      />
      {problem && <span role="alert">{problem}</span>}
    </>
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
