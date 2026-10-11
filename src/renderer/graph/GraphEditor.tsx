import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  NodeToolbar,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import type { EdgeTypes, NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { GraphActionsContext } from './actions';
import type { GraphActions } from './actions';
import {
  addNode,
  addParent,
  addToQueue,
  autosize,
  canConnect,
  connect,
  deleteEdge,
  deleteSelection,
  EMPTY_GRAPH,
  groupMembers,
  groupSelection,
  removeFromQueue,
  renameNode,
  selectOnly,
  ungroupSelection,
} from './graph';
import type { Graph } from './graph';
import { keyAction, SHORTCUTS } from './keys';
import type { KeyAction } from './keys';
import { NodeDetail } from './NodeDetail';
import { EdgeView, FrameNodeView, ItemNodeView } from './nodes';
import './GraphEditor.css';

const nodeTypes = { item: ItemNodeView, frame: FrameNodeView } satisfies NodeTypes;
const edgeTypes = { default: EdgeView } satisfies EdgeTypes;
/** Middle and right mouse buttons pan; the left button draws the selection box. */
const PAN_BUTTONS = [1, 2];
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];

type Command = Exclude<KeyAction, 'rename'>;

/** The graph operation behind a shortcut or button. New ids are made here, not in updaters. */
function operation(command: Command): (graph: Graph) => Graph {
  switch (command) {
    case 'delete':
      return deleteSelection;
    case 'ungroup':
      return ungroupSelection;
    case 'group': {
      const id = crypto.randomUUID();
      return (graph) => groupSelection(graph, 'frame', id);
    }
    case 'groupUnderParent': {
      const id = crypto.randomUUID();
      return (graph) => groupSelection(graph, 'item', id);
    }
  }
}

export function GraphEditor({ initialGraph = EMPTY_GRAPH }: { initialGraph?: Graph }) {
  return (
    <ReactFlowProvider>
      <Editor initialGraph={initialGraph} />
    </ReactFlowProvider>
  );
}

function Editor({ initialGraph }: { initialGraph: Graph }) {
  const [graph, setGraph] = useState(initialGraph);
  const [editing, setEditing] = useState<string>();
  /** The node opened in a panel by a double-click, if any. */
  const [opened, setOpened] = useState<string>();
  const store = useStoreApi();
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // The keyboard handler reads these without re-subscribing on every change.
  const latest = useRef({ graph, opened });
  useEffect(() => {
    latest.current = { graph, opened };
  });

  const nodeElement = useCallback(
    (id: string) =>
      wrapper.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`) ?? null,
    [],
  );
  const openedCard = useCallback(
    () =>
      opened === undefined
        ? undefined
        : nodeElement(opened)?.querySelector('.graph-card')?.getBoundingClientRect(),
    [opened, nodeElement],
  );
  const closeOpened = useCallback(() => {
    if (opened !== undefined) nodeElement(opened)?.focus();
    setOpened(undefined);
  }, [opened, nodeElement]);

  // Also dismisses React Flow's selection rectangle, which would keep covering the old selection.
  const apply = useCallback(
    (op: (graph: Graph) => Graph) => {
      setGraph(op);
      store.setState({ nodesSelectionActive: false });
    },
    [store],
  );

  const actions = useMemo<GraphActions>(
    () => ({
      editing,
      startEditing: setEditing,
      stopEditing: () => {
        setEditing(undefined);
      },
      rename: (id, label) => {
        setGraph((g) => renameNode(g, id, label));
      },
      remove: (id) => {
        apply((g) => deleteSelection(selectOnly(g, id)));
      },
      ungroup: (id) => {
        apply((g) => ungroupSelection(selectOnly(g, id)));
      },
      addParent: (id) => {
        apply((g) => addParent(g, id));
      },
      removeEdge: (id) => {
        setGraph((g) => deleteEdge(g, id));
      },
    }),
    [apply, editing],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // An open node panel has the keyboard (Escape closes it).
      if (latest.current.opened !== undefined) return;
      const action = keyAction(event);
      if (action === null) return;
      event.preventDefault();
      if (action !== 'rename') {
        apply(operation(action));
        return;
      }
      const [only, ...others] = latest.current.graph.nodes.filter((n) => n.selected);
      if (only && others.length === 0) setEditing(only.id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [apply]);

  const onDoubleClick = (event: ReactMouseEvent) => {
    // The empty canvas, or a container's see-through body (the event then targets the pane too).
    if (event.target instanceof Element && event.target.classList.contains('react-flow__pane')) {
      const id = crypto.randomUUID();
      const center = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      apply((g) => addNode(g, id, center));
    }
  };

  // React Flow names an edge after its node ids (random UUIDs); use the labels for screen readers.
  const edges = useMemo(() => {
    const labels = new Map(graph.nodes.map((n) => [n.id, n.data.label || 'unnamed node']));
    const name = (id: string) => labels.get(id) ?? 'unknown node';
    return graph.edges.map((e) => ({
      ...e,
      ariaLabel: `Edge from ${name(e.source)} to ${name(e.target)}`,
    }));
  }, [graph.nodes, graph.edges]);

  const selectedIds = graph.nodes.filter((n) => n.selected).map((n) => n.id);
  const openedNode = graph.nodes.find((n) => n.id === opened);
  const canGroup = groupMembers(graph.nodes).length > 0;

  return (
    <GraphActionsContext value={actions}>
      <div className="graph-editor" ref={wrapper}>
        <ReactFlow
          nodes={graph.nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes) => {
            // Containers fit their children, so a dragged child resizes every container around it.
            setGraph((g) => ({ ...g, nodes: autosize(applyNodeChanges(changes, g.nodes)) }));
          }}
          onEdgesChange={(changes) => {
            setGraph((g) => ({ ...g, edges: applyEdgeChanges(changes, g.edges) }));
          }}
          onConnect={(connection) => {
            setGraph((g) => connect(g, connection));
          }}
          isValidConnection={(connection) => canConnect(graph, connection)}
          connectionMode={ConnectionMode.Loose}
          onDoubleClick={onDoubleClick}
          onNodeDoubleClick={(_event, node) => {
            // A plain click keeps a multi-selection; this is about the double-clicked node only.
            apply((g) => selectOnly(g, node.id));
            // A node opens in a panel; a group, which has no queue, is renamed in place.
            if (node.type === 'frame') {
              setEditing(node.id);
            } else {
              setEditing(undefined);
              setOpened(node.id);
            }
          }}
          zoomOnDoubleClick={false}
          selectionOnDrag
          panOnDrag={PAN_BUTTONS}
          panOnScroll
          selectionKeyCode={null}
          multiSelectionKeyCode={MULTI_SELECT_KEYS}
          deleteKeyCode={null}
          defaultMarkerColor={null}
          colorMode="system"
        >
          <Background />
          <Controls showInteractive={false} />
          <NodeToolbar
            nodeId={selectedIds}
            isVisible={selectedIds.length > 1}
            className="graph-actions"
          >
            <button
              type="button"
              disabled={!canGroup}
              title={
                canGroup
                  ? `Put the selected nodes in a group (${SHORTCUTS.group})`
                  : 'Only nodes in the same group can be grouped'
              }
              onClick={() => {
                apply(operation('group'));
              }}
            >
              Group
            </button>
            <button
              type="button"
              title="Delete the selected nodes (Delete). A deleted group's nodes are kept."
              onClick={() => {
                apply(operation('delete'));
              }}
            >
              Delete
            </button>
          </NodeToolbar>
          <Panel position="bottom-center" className="graph-panel graph-hint">
            Double-click the canvas to add a node, or a node to open it · Drag between dots to
            connect · Drag on empty space to select · Hover for actions · F2 to rename
          </Panel>
        </ReactFlow>
        {openedNode && (
          <NodeDetail
            key={openedNode.id}
            node={openedNode}
            origin={openedCard}
            onRename={(label) => {
              setGraph((g) => renameNode(g, openedNode.id, label));
            }}
            onAdd={(kind) => {
              const item = { id: crypto.randomUUID(), kind };
              setGraph((g) => addToQueue(g, openedNode.id, item));
            }}
            onRemove={(itemId) => {
              setGraph((g) => removeFromQueue(g, openedNode.id, itemId));
            }}
            onClose={closeOpened}
          />
        )}
      </div>
    </GraphActionsContext>
  );
}
