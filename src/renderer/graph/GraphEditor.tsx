import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  ControlButton,
  Controls,
  MarkerType,
  NodeToolbar,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import type { Connection, Edge, EdgeTypes, NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { CanvasFile } from '../../shared/ipc';
import { GraphActionsContext } from './actions';
import { DEFAULT_AGENT } from './agents';
import type { GraphActions } from './actions';
import {
  absolutePosition,
  addAgent,
  addParent,
  addToQueue,
  answerQuestion,
  areLinked,
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
  setWaitFor,
  ungroupSelection,
} from './graph';
import type { Graph } from './graph';
import { ExampleGallery } from './ExampleGallery';
import { EXAMPLES } from './examples';
import type { Example } from './examples';
import { FileBar } from './FileBar';
import { fromFile, toFile } from './file';
import { fileAction, keyAction, SHORTCUTS } from './keys';
import { arrange } from './layout';
import type { KeyAction } from './keys';
import { ConnectMenu } from './ConnectMenu';
import type { MenuPlace } from './ConnectMenu';
import { NodeDetail } from './NodeDetail';
import { AgentNodeView, GroupNodeView, LinkView, WorkEdgeView } from './nodes';
import type { WorkFlowEdge } from './nodes';
import type { Question } from './queue';
import { QuestionsSidebar } from './Questions';
import { workEdges } from './work';
import { WorkDetail } from './WorkDetail';
import type { QueueEdits } from './WorkDetail';
import './GraphEditor.css';

const nodeTypes = { agent: AgentNodeView, frame: GroupNodeView } satisfies NodeTypes;
const edgeTypes = { default: LinkView, work: WorkEdgeView } satisfies EdgeTypes;
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

/** Where canvases are saved and opened from (window.api in the app; see src/main/canvas.ts). */
export interface CanvasFiles {
  /** Asks for a file to open: resolves with it, or null if cancelled. */
  open: () => Promise<CanvasFile | null>;
  /** Saves a canvas's text (to a file picked anew, if `choose`): resolves with its name, or null. */
  save: (text: string, choose: boolean) => Promise<string | null>;
  /** Forgets the canvas's file: the next save asks where. */
  forget: () => Promise<null>;
}

/** The editor, with (given `files`) a bar to open and save canvases as `.corral` files. */
export function GraphEditor({
  initialGraph = EMPTY_GRAPH,
  files,
}: {
  initialGraph?: Graph;
  files?: CanvasFiles;
}) {
  return (
    <ReactFlowProvider>
      <Editor initialGraph={initialGraph} files={files} />
    </ReactFlowProvider>
  );
}

/** Why opening or saving failed, without what IPC adds to a rejection from main. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

function Editor({ initialGraph, files }: { initialGraph: Graph; files: CanvasFiles | undefined }) {
  const [graph, setRawGraph] = useState(initialGraph);
  /** The canvas's file (its name; undefined if never saved) and the text last saved to it. */
  const [saved, setSaved] = useState(() => ({
    name: undefined as string | undefined,
    text: toFile(initialGraph),
  }));
  const text = useMemo(() => toFile(graph), [graph]);
  const edited = text !== saved.text;
  /** What would discard unsaved changes, while the user is asked first. */
  const [discarding, setDiscarding] = useState<{ run: () => void }>();
  /** Why the last open or save failed. */
  const [problem, setProblem] = useState<string>();
  /** Whether the examples gallery is open. */
  const [gallery, setGallery] = useState(false);
  /** Whether the graph is laid out automatically (and nodes cannot be dragged). */
  const [arranging, setArranging] = useState(false);
  const [editing, setEditing] = useState<string>();
  /** The node opened in a panel by a double-click, if any. */
  const [opened, setOpened] = useState<string>();
  /** The work between two agents opened in a panel, if any. */
  const [work, setWork] = useState<{ from: string; to: string }>();
  /** An edge just drawn between two agents, while its menu asks what it makes; where it ended. */
  const [drawn, setDrawn] = useState<Connection & { at?: MenuPlace }>();
  const store = useStoreApi();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  /** Whether a panel, menu or question is open, which has the keyboard (Escape closes it). */
  const modal =
    opened !== undefined ||
    work !== undefined ||
    drawn !== undefined ||
    discarding !== undefined ||
    gallery;
  // The keyboard handler and file commands read these without re-subscribing on every change.
  const latest = useRef({ graph, modal, arranging, text, edited });
  useEffect(() => {
    latest.current = { graph, modal, arranging, text, edited };
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
      openWork: (from, to) => {
        setWork({ from, to });
      },
    }),
    [apply, editing, setGraph],
  );

  const edits = useMemo<QueueEdits>(
    () => ({
      add: (owner, entry, into) => {
        const item = { ...entry, id: crypto.randomUUID() };
        setGraph((g) => addToQueue(g, owner, item, into));
      },
      remove: (owner, itemId) => {
        setGraph((g) => removeFromQueue(g, owner, itemId));
      },
      move: (owner, itemId, index) => {
        setGraph((g) => moveInQueue(g, owner, itemId, index));
      },
      retarget: (owner, itemId, target) => {
        setGraph((g) => retarget(g, owner, itemId, target));
      },
      editMessage: (owner, itemId, message) => {
        setGraph((g) => editMessage(g, owner, itemId, message));
      },
      setCondition: (owner, ifId, condition) => {
        setGraph((g) => setCondition(g, owner, ifId, condition));
      },
      setWaitFor: (owner, waitId, agents) => {
        setGraph((g) => setWaitFor(g, owner, waitId, agents));
      },
    }),
    [setGraph],
  );
  const closeWork = useCallback(() => {
    setWork(undefined);
  }, []);
  const closeGallery = useCallback(() => {
    setGallery(false);
  }, []);

  /** How many canvases have been loaded: the view fits each one, once React Flow has its nodes. */
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    // React Flow holds the new nodes by now (its effects run first); it fits once they are measured.
    if (loads > 0) void fitView({ padding: 0.2, maxZoom: 1 });
  }, [loads, fitView]);

  /** Replaces the canvas with one from a file (`name`), or a new one, and fits the view to it. */
  const load = useCallback((next: Graph, name: string | undefined) => {
    setLoads((n) => n + 1);
    setRawGraph(next);
    setSaved({ name, text: toFile(next) });
    setArranging(false);
    setEditing(undefined);
    setOpened(undefined);
    setWork(undefined);
    setDrawn(undefined);
    setProblem(undefined);
  }, []);
  /**
   * The file commands. New and Open replace the canvas, so while it has unsaved changes (`edited`)
   * they ask first; Save writes `text`, the canvas's file text.
   */
  const commands = useMemo(() => {
    if (!files) return undefined;
    /** Runs `run` now, or once the user agrees to discard unsaved changes. */
    const unless = (edited: boolean, run: () => void) => {
      if (edited) setDiscarding({ run });
      else run();
    };
    const failed = (doing: string) => (error: unknown) => {
      setProblem(`Could not ${doing}: ${reason(error)}`);
    };
    return {
      new: (edited: boolean) => {
        unless(edited, () => {
          load(EMPTY_GRAPH, undefined);
          files.forget().catch(failed('start a new canvas'));
        });
      },
      open: (edited: boolean) => {
        unless(edited, () => {
          files.open().then((file) => {
            if (!file) return;
            try {
              load(fromFile(file.text), file.name);
            } catch (error) {
              setProblem(`Could not open ${file.name}: ${reason(error)}`);
              // Main took it as the canvas's file: never save this canvas over it.
              files.forget().catch(failed('open the canvas'));
            }
          }, failed('open the canvas'));
        });
      },
      /** Opens an example as a new canvas, saved nowhere yet. */
      example: (example: Example, edited: boolean) => {
        unless(edited, () => {
          load(fromFile(example.text), undefined);
          files.forget().catch(failed('open the example'));
        });
      },
      save: (text: string, choose: boolean) => {
        files.save(text, choose).then((name) => {
          if (name !== null) setSaved({ name, text });
        }, failed('save the canvas'));
      },
    };
  }, [files, load]);
  useEffect(() => {
    if (files)
      document.title = `${saved.name ?? 'Untitled'}${edited ? ' (edited)' : ''} — corrallm`;
  }, [files, saved.name, edited]);
  const cancelDrawn = useCallback(() => {
    setDrawn(undefined);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const file = commands ? fileAction(event) : null;
      if (commands && file) {
        event.preventDefault();
        if (file === 'save' || file === 'saveAs') {
          commands.save(latest.current.text, file === 'saveAs');
        } else if (!latest.current.modal) {
          if (file === 'new') commands.new(latest.current.edited);
          else commands.open(latest.current.edited);
        }
        return;
      }
      if (latest.current.modal) return;
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
  }, [apply, commands]);

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

  // The links between agents that can talk (graph.edges, dashed), except where one hands the other
  // work: that is drawn from the queues as an arrow (work.ts), and implies they can talk. React Flow
  // names an edge after its node ids (random UUIDs); screen readers hear the agents' labels.
  const edges = useMemo(() => {
    const labels = new Map(graph.nodes.map((n) => [n.id, n.data.label || 'Unnamed agent']));
    const name = (id: string) => labels.get(id) ?? 'unknown node';
    const pair = (a: string, b: string) => JSON.stringify([a, b].sort());
    const work = workEdges(graph.nodes);
    const working = new Set(work.map(({ from, to }) => pair(from, to)));
    const directed = new Set(work.map(({ from, to }) => JSON.stringify([from, to])));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const top = (id: string) => {
      const node = byId.get(id);
      return node ? absolutePosition(node, byId).y : 0;
    };
    const links: Edge[] = graph.edges
      .filter((e) => !working.has(pair(e.source, e.target)))
      .map((e) => ({
        ...e,
        className: 'graph-link',
        ariaLabel: `${name(e.source)} and ${name(e.target)} can talk`,
      }));
    const arrows: WorkFlowEdge[] = work.map(({ from, to, count, conditional }) => {
      // Up to an agent above: out of the top dot and into the bottom one, so it does not loop.
      const upwards = top(from) > top(to);
      const both = directed.has(JSON.stringify([to, from]));
      return {
        id: `work:${from}->${to}`,
        type: 'work',
        source: from,
        target: to,
        sourceHandle: upwards ? 'top' : 'bottom',
        targetHandle: upwards ? 'bottom' : 'top',
        markerEnd: { type: MarkerType.ArrowClosed },
        selectable: false,
        deletable: false,
        className: 'graph-work',
        ariaLabel: `Work from ${name(from)} for ${name(to)}: ${String(count)} queued${conditional ? ', on a condition' : ''}`,
        data: {
          count,
          conditional,
          lane: both ? (from < to ? 1 : -1) : 0,
          fromName: name(from),
          toName: name(to),
        },
      };
    });
    return [...links, ...arrows];
  }, [graph.nodes, graph.edges]);

  const selectedIds = graph.nodes.filter((n) => n.selected).map((n) => n.id);
  const nameOf = (id: string) =>
    (graph.nodes.find((n) => n.id === id)?.data.label ?? '') || 'Unnamed agent';
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
          // A drawn edge asks what it makes (ConnectMenu), where the drag ended.
          onConnect={(connection) => {
            setDrawn(connection);
          }}
          onConnectEnd={(event) => {
            const point = 'changedTouches' in event ? event.changedTouches[0] : event;
            const editor = wrapper.current?.getBoundingClientRect();
            if (!point || !editor) return;
            // Above a top dot and below a bottom one, clear of the card it ends on.
            const x = Math.min(Math.max(point.clientX - editor.left, 150), editor.width - 150);
            const y = point.clientY - editor.top;
            setDrawn(
              (d) =>
                d && {
                  ...d,
                  at:
                    d.targetHandle === 'bottom'
                      ? { x, y: Math.min(y, editor.height - 150), above: false }
                      : { x, y: Math.max(y, 150), above: true },
                },
            );
          }}
          onEdgeDoubleClick={(_event, edge) => {
            if (edge.type === 'work') setWork({ from: edge.source, to: edge.target });
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
          {commands && (
            <Panel position="top-left">
              <FileBar
                name={saved.name}
                edited={edited}
                problem={problem}
                discarding={discarding !== undefined}
                onNew={() => {
                  commands.new(edited);
                }}
                onOpen={() => {
                  commands.open(edited);
                }}
                onSave={() => {
                  commands.save(text, false);
                }}
                onSaveAs={() => {
                  commands.save(text, true);
                }}
                onExamples={() => {
                  setGallery(true);
                }}
                onDiscard={() => {
                  discarding?.run();
                  setDiscarding(undefined);
                }}
                onKeep={() => {
                  setDiscarding(undefined);
                }}
                onDismiss={() => {
                  setProblem(undefined);
                }}
              />
            </Panel>
          )}
          {commands && graph.nodes.length === 0 && (
            <Panel position="top-center" className="graph-panel graph-start">
              <button
                type="button"
                onClick={() => {
                  setGallery(true);
                }}
              >
                Start from an example…
              </button>
            </Panel>
          )}
          <Panel position="bottom-center" className="graph-panel graph-hint">
            Double-click the canvas to add an agent, or an agent to open it · Drag between agents'
            dots to let them talk or queue work · Drag on empty space to select · F2 to rename
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
              edits.add(openedNode.id, entry, into);
            }}
            onRemove={(itemId) => {
              edits.remove(openedNode.id, itemId);
            }}
            onMove={(itemId, index) => {
              edits.move(openedNode.id, itemId, index);
            }}
            onRetarget={(itemId, target) => {
              edits.retarget(openedNode.id, itemId, target);
            }}
            onEditMessage={(itemId, message) => {
              edits.editMessage(openedNode.id, itemId, message);
            }}
            onCondition={(ifId, condition) => {
              edits.setCondition(openedNode.id, ifId, condition);
            }}
            onWaitFor={(waitId, agents) => {
              edits.setWaitFor(openedNode.id, waitId, agents);
            }}
            onClose={closeOpened}
          />
        )}
        {work && (
          <WorkDetail
            key={`${work.from}->${work.to}`}
            from={work.from}
            to={work.to}
            nodes={graph.nodes}
            edits={edits}
            onClose={closeWork}
          />
        )}
        {gallery && (
          <ExampleGallery
            examples={EXAMPLES}
            onPick={(example) => {
              setGallery(false);
              commands?.example(example, edited);
            }}
            onClose={closeGallery}
          />
        )}
        {drawn && (
          <ConnectMenu
            fromName={nameOf(drawn.source)}
            toName={nameOf(drawn.target)}
            linked={areLinked(graph, drawn.source, drawn.target)}
            at={drawn.at}
            onTalk={() => {
              setGraph((g) => connect(g, drawn));
              setDrawn(undefined);
            }}
            onWork={() => {
              setGraph((g) => connect(g, drawn));
              setDrawn(undefined);
              setWork({ from: drawn.source, to: drawn.target });
            }}
            onCancel={cancelDrawn}
          />
        )}
      </div>
    </GraphActionsContext>
  );
}
