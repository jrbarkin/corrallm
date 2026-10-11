import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  ControlButton,
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
import { DEFAULT_AGENT } from './agents';
import type { GraphActions } from './actions';
import {
  addAgent,
  addParent,
  addToQueue,
  answerQuestion,
  askUser,
  autosize,
  canConnect,
  connect,
  deleteEdge,
  deleteSelection,
  editMessage,
  EMPTY_GRAPH,
  groupColors,
  groupMembers,
  groupSelection,
  moveInQueue,
  pendingQuestions,
  removeFromQueue,
  renameNode,
  retarget,
  selectOnly,
  setAgent,
  setCondition,
  ungroupSelection,
} from './graph';
import type { Graph } from './graph';
import { keyAction, SHORTCUTS } from './keys';
import { arrange } from './layout';
import type { KeyAction } from './keys';
import { NodeDetail } from './NodeDetail';
import { EdgeView, GroupNodeView, AgentNodeView } from './nodes';
import type { Question } from './queue';
import { QuestionsSidebar } from './Questions';
import './GraphEditor.css';

const nodeTypes = { agent: AgentNodeView, frame: GroupNodeView } satisfies NodeTypes;
const edgeTypes = { default: EdgeView } satisfies EdgeTypes;
/** Middle and right mouse buttons pan; the left button draws the selection box. */
const PAN_BUTTONS = [1, 2];
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];

type Command = Exclude<KeyAction, 'rename'>;

/** Stand-ins for what agents will ask, until agents are connected (see "Simulate a question"). */
const SAMPLE_QUESTIONS: readonly Omit<Question, 'id'>[] = [
  {
    text: 'Two tests fail after my change. Should I fix them before going on?',
    options: ['Fix them first', 'Go on'],
  },
  { text: 'Which branch should the pull request target?', options: ['main', 'develop'] },
  { text: 'What should the new module be called?' },
];

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
      return (graph) => groupSelection(graph, 'agent', id);
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
  const [graph, setRawGraph] = useState(initialGraph);
  /** Whether the graph is laid out automatically (and nodes cannot be dragged). */
  const [arranging, setArranging] = useState(false);
  const [editing, setEditing] = useState<string>();
  /** The node opened in a panel by a double-click, if any. */
  const [opened, setOpened] = useState<string>();
  const store = useStoreApi();
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // The keyboard handler reads these without re-subscribing on every change.
  const latest = useRef({ graph, opened, arranging });
  useEffect(() => {
    latest.current = { graph, opened, arranging };
  });
  /** Every change to the graph goes through here, so it stays arranged while arranging is on. */
  const setGraph = useCallback((op: (graph: Graph) => Graph) => {
    setRawGraph((g) => {
      const next = op(g);
      return latest.current.arranging ? arrange(next) : next;
    });
  }, []);

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
    [store, setGraph],
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
    [apply, editing, setGraph],
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

  /** Adds a node where the pointer is: into the innermost group there, if any. */
  const addAtPointer = (event: ReactMouseEvent) => {
    const id = crypto.randomUUID();
    const center = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    apply((g) => addAgent(g, id, center));
  };
  const onDoubleClick = (event: ReactMouseEvent) => {
    if (event.target instanceof Element && event.target.classList.contains('react-flow__pane')) {
      addAtPointer(event);
    }
  };

  // Each node shows its group's colour, and an agent with a question for the user glows, through
  // classes React Flow puts on it (GraphEditor.css). Screen readers hear an agent's type with its label.
  const nodes = useMemo(() => {
    const colors = groupColors(graph.nodes);
    return graph.nodes.map((n) => {
      const color = colors.get(n.id);
      const asking = n.data.questions?.some((q) => q.answer === undefined) ?? false;
      const classes = [
        ...(color === undefined ? [] : [`group-color-${String(color)}`]),
        ...(asking ? ['asking'] : []),
      ];
      const name = n.data.label || 'Unnamed agent';
      return {
        ...n,
        ...(classes.length === 0 ? {} : { className: classes.join(' ') }),
        ...(n.type === 'agent' ? { ariaLabel: `${name}, ${n.data.agent ?? DEFAULT_AGENT}` } : {}),
      };
    });
  }, [graph.nodes]);
  const pending = pendingQuestions(graph.nodes);

  // React Flow names an edge after its node ids (random UUIDs); use the labels for screen readers.
  const edges = useMemo(() => {
    const labels = new Map(graph.nodes.map((n) => [n.id, n.data.label || 'unnamed agent']));
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
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={!arranging}
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
          onNodeDoubleClick={(event, node) => {
            // A group's body (not its label bar, card or '+') adds a node into it, like the canvas.
            const isGroup =
              node.type === 'frame' || graph.nodes.some((n) => n.parentId === node.id);
            const onBody =
              isGroup &&
              event.target instanceof Element &&
              !event.target.closest('.graph-frame-title, .graph-card, .graph-add-parent');
            if (onBody) {
              addAtPointer(event);
              return;
            }
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
          <Controls showInteractive={false}>
            <ControlButton
              className="graph-arrange"
              aria-label="Arrange automatically"
              aria-pressed={arranging}
              title={
                arranging
                  ? 'Arranging automatically. Click to arrange by hand.'
                  : 'Arrange automatically'
              }
              onClick={() => {
                if (!arranging) setRawGraph(arrange);
                setArranging(!arranging);
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 1h4v3H6zM1 11h4v3H1zM11 11h4v3h-4zM7.5 4h1v2.5h5V11h-1V7.5h-9V11h-1V6.5h5z" />
              </svg>
            </ControlButton>
          </Controls>
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
                  ? `Put the selected agents in a group (${SHORTCUTS.group})`
                  : 'Only agents in the same group can be grouped'
              }
              onClick={() => {
                apply(operation('group'));
              }}
            >
              Group
            </button>
            <button
              type="button"
              title="Delete the selected agents (Delete). A deleted group's nodes are kept."
              onClick={() => {
                apply(operation('delete'));
              }}
            >
              Delete
            </button>
          </NodeToolbar>
          {pending.length > 0 && (
            <Panel position="top-right">
              <QuestionsSidebar
                pending={pending.map(({ agent, question }) => ({
                  agentId: agent.id,
                  agentName: agent.data.label || 'Unnamed agent',
                  agentType: agent.data.agent ?? DEFAULT_AGENT,
                  question,
                }))}
                onAnswer={(agentId, questionId, answer) => {
                  setGraph((g) => answerQuestion(g, agentId, questionId, answer));
                }}
                onOpen={(agentId) => {
                  apply((g) => selectOnly(g, agentId));
                  setOpened(agentId);
                }}
              />
            </Panel>
          )}
          <Panel position="bottom-center" className="graph-panel graph-hint">
            Double-click the canvas to add an agent, or an agent to open it · Drag between dots to
            connect · Drag on empty space to select · Hover for actions · F2 to rename
          </Panel>
        </ReactFlow>
        {openedNode && (
          <NodeDetail
            key={openedNode.id}
            node={openedNode}
            nodes={graph.nodes}
            origin={openedCard}
            onRename={(label) => {
              setGraph((g) => renameNode(g, openedNode.id, label));
            }}
            onAgent={(agent) => {
              setGraph((g) => setAgent(g, openedNode.id, agent));
            }}
            onAnswer={(questionId, answer) => {
              setGraph((g) => answerQuestion(g, openedNode.id, questionId, answer));
            }}
            onSimulateQuestion={() => {
              const asked = openedNode.data.questions?.length ?? 0;
              const sample = SAMPLE_QUESTIONS[asked % SAMPLE_QUESTIONS.length];
              if (!sample) return;
              const question = { ...sample, id: crypto.randomUUID() };
              setGraph((g) => askUser(g, openedNode.id, question));
            }}
            onAdd={(entry, into) => {
              const item = { ...entry, id: crypto.randomUUID() };
              setGraph((g) => addToQueue(g, openedNode.id, item, into));
            }}
            onRemove={(itemId) => {
              setGraph((g) => removeFromQueue(g, openedNode.id, itemId));
            }}
            onMove={(itemId, index) => {
              setGraph((g) => moveInQueue(g, openedNode.id, itemId, index));
            }}
            onRetarget={(itemId, target) => {
              setGraph((g) => retarget(g, openedNode.id, itemId, target));
            }}
            onEditMessage={(itemId, message) => {
              setGraph((g) => editMessage(g, openedNode.id, itemId, message));
            }}
            onCondition={(ifId, condition) => {
              setGraph((g) => setCondition(g, openedNode.id, ifId, condition));
            }}
            onClose={closeOpened}
          />
        )}
      </div>
    </GraphActionsContext>
  );
}
