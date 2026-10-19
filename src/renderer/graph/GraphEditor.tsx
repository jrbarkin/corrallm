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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { CanvasFile, ProjectFolder } from '../../shared/ipc';
import { UNASKING_MODES } from '../../shared/session';
import type { AgentSettingsChange, InstalledClis } from '../../shared/session';
import { NO_USAGE } from '../../shared/usage';
import { AgentView } from '../agent/AgentView';
import { AgentSettingsPanel } from '../agent/AgentSettings';
import { NO_BACKEND } from '../../shared/engine/transcript/receive';
import type { SessionBackend } from '../../shared/engine/transcript/receive';
import { adapterOf, catalog, continuesIn } from '../catalog';
import { ipcErrorMessage } from '../ipc-error';
import { flushDrafts } from '../useDraft';
import { QueuesView } from '../queues/QueuesView';
import { lanesOf } from '../queues/lanes';
import { queueMarks } from '../queues/marks';
import { withSubmissions } from '../queues/submissions';
import { Engine } from '../../shared/engine/engine';
import { NEW_SESSION } from '../../shared/model/session';
import { needsOf } from '../../shared/engine/needs';
import { heldAsks } from '../../shared/engine/run/asks';
import {
  groupControlText,
  groupPaused,
  individualPaused,
  queueControlText,
} from '../../shared/engine/run/controls';
import { RunPersistence } from '../run/persistence';
import type { RunSource } from '../run/persistence';
import { UsageStore } from '../usage/store';
import type { UsageSource } from '../usage/store';
import { UsageGauges } from '../usage/UsageGauge';
import { backendsOf } from '../usage/usage';
import { NO_TERMINAL } from '../terminal/backend';
import type { TerminalBackend } from '../terminal/backend';
import { GraphActionsContext } from './actions';
import { agentLabel, connectionOf, DEFAULT_AGENT, runCatalog } from './agents';
import type { GraphActions } from './actions';
import {
  absolutePosition,
  addAgent,
  addParent,
  addToQueue,
  autosize,
  canConnect,
  canvasNodes,
  connect,
  deleteEdge,
  deleteSelection,
  documentOf,
  editMessage,
  EMPTY_GRAPH,
  graphOf,
  groupColors,
  groupMembers,
  groupSelection,
  moveInQueue,
  removeFromQueue,
  renameNode,
  retarget,
  selectOnly,
  setAgent,
  setApproval,
  setCondition,
  setConnection,
  setExpect,
  setInstruction,
  setRepeat,
  setRole,
  setSettings,
  setTime,
  setWaitFor,
  spawnAgent,
  ungroupSelection,
} from './graph';
import { areLinked, groupMembers as groupAgentIds, isGroup } from '../../shared/model/queries';
import type { Graph } from './graph';
import { ExampleGallery } from './ExampleGallery';
import type { TemplateChoices } from './ExampleGallery';
import { exampleOf } from '../../shared/examples';
import type { Example } from '../../shared/examples';
import { FileBar } from './FileBar';
import { fromFile, toFile } from '../../shared/model/file';
import { fillTemplate } from '../../shared/templates';
import { withAgents, withConnections } from './templates';
import { insertGraph } from './insert';
import { fileAction, keyAction, SHORTCUTS } from './keys';
import { arrange } from './layout';
import type { KeyAction } from './keys';
import { ConnectMenu } from './ConnectMenu';
import type { MenuPlace } from './ConnectMenu';
import { AgentNodeView, GroupNodeView, LinkView, WorkEdgeView } from './nodes';
import { AgentContextMenu } from './AgentContextMenu';
import type { WorkFlowEdge } from './nodes';
import { QuestionsSidebar } from './Questions';
import { workEdges } from './work';
import { WorkDetail } from './WorkDetail';
import type { QueueEdits } from './edits';
import './GraphEditor.css';

const nodeTypes = { agent: AgentNodeView, frame: GroupNodeView } satisfies NodeTypes;
const edgeTypes = { default: LinkView, work: WorkEdgeView } satisfies EdgeTypes;
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
  /** Begins a new canvas, with no file (the next save asks where): resolves with its id. */
  forget: () => Promise<CanvasId>;
  /** Asks for the folder the canvas's agents work in: resolves with it, or null if cancelled. */
  chooseProject?: () => Promise<ProjectFolder | null>;
}

/**
 * The editor, with (given `files`) a bar to open and save canvases as `.corral` files, (given
 * `sessionBackend`, and `terminalBackend` for their terminals) agents connected to the real CLI
 * through the main process, and (given `usageSource`) the usage readings and rules main keeps.
 */
export function GraphEditor({
  initialGraph = EMPTY_GRAPH,
  files,
  sessionBackend,
  terminalBackend = NO_TERMINAL,
  usageSource,
  runSource,
}: {
  initialGraph?: Graph;
  files?: CanvasFiles;
  sessionBackend?: SessionBackend;
  terminalBackend?: TerminalBackend;
  usageSource?: UsageSource;
  runSource?: RunSource;
}) {
  return (
    <ReactFlowProvider>
      <Editor
        initialGraph={initialGraph}
        files={files}
        sessionBackend={sessionBackend}
        terminalBackend={terminalBackend}
        usageSource={usageSource}
        runSource={runSource}
      />
    </ReactFlowProvider>
  );
}

/** A template as a canvas: its blanks filled in, its agents given their types and connections. */
function fromTemplate(example: Example, { values, agents, connections }: TemplateChoices): Graph {
  return withConnections(
    withAgents(
      fillTemplate(graphOf(fromFile(example.text, catalog(), DEFAULT_AGENT)), values),
      agents,
    ),
    connections,
  );
}

function Editor({
  initialGraph,
  files,
  sessionBackend,
  terminalBackend,
  usageSource,
  runSource,
}: {
  initialGraph: Graph;
  files: CanvasFiles | undefined;
  sessionBackend: SessionBackend | undefined;
  terminalBackend: TerminalBackend;
  usageSource: UsageSource | undefined;
  runSource: RunSource | undefined;
}) {
  const [graph, setRawGraph] = useState(initialGraph);
  /** The canvas's id: main's (a file's, or a draft's), which its file's text holds. */
  const [canvasId, setCanvasId] = useState(newCanvasId);
  /**
   * The canvas's file (its name; undefined if never saved) and the graph last saved to it, whose
   * text is the canvas's, by its id.
   */
  const [saved, setSaved] = useState(() => ({
    name: undefined as string | undefined,
    graph: initialGraph,
  }));
  /** Why the last open or save failed. */
  const [problem, setProblem] = useState<string>();
  /** The folder the canvas's agents work in (main keeps it; this is what the file bar shows). */
  const [project, setProject] = useState<ProjectFolder | null>(null);
  /** How many canvases have been loaded: the view fits each one, once React Flow has its nodes. */
  const [loads, setLoads] = useState(0);
  /** Every backend's usage reading and rule (main's: one per backend, for every canvas). */
  const usageStore = useRef<UsageStore | undefined>(undefined);
  const usage = useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        const store = new UsageStore(usageSource);
        usageStore.current = store;
        const unsubscribe = store.subscribe(changed);
        return () => {
          unsubscribe();
          store.dispose();
        };
      },
      [usageSource],
    ),
    useCallback(() => usageStore.current?.snapshot() ?? NO_USAGE, []),
  );
  /**
   * Every agent's queue, run: messages go to the agents' sessions, and so do connected agents'
   * steps and questions through their native connections. An agent whose session would not
   * start is switched to the connection the user chose for it there.
   */
  const [{ engine, sessionStore, runStore, persistence, documentState }] = useState(() => {
    let persistence: RunPersistence | undefined = undefined;
    let workflow = toFile(documentOf(initialGraph, canvasId));
    const documentState = {
      read: () => workflow,
      write: (next: string) => {
        workflow = next;
      },
    };
    const engine = new Engine({
      catalog: runCatalog(),
      backend: sessionBackend ?? NO_BACKEND,
      ...(runSource
        ? {
            beforeSend: () => {
              if (!persistence)
                return Promise.reject(new Error('Run storage has not initialized.'));
              return persistence.flush();
            },
          }
        : {}),
      connect: (agent, connection) => {
        // How an agent runs changes nothing laid out.
        setRawGraph((g) => setConnection(g, agent, connection));
      },
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      // The real clock, read when asked: delays and time limits use the real clock.
      now: () => Date.now(),
      usage: () => usageStore.current?.snapshot() ?? NO_USAGE,
    });
    const { sessions: sessionStore, run: runStore } = engine;
    if (runSource)
      persistence = new RunPersistence(runSource, {
        capture: () => ({
          version: 2,
          ...engine.checkpoint(),
          updatedAt: Date.now(),
        }),
        document: () => documentState.read(),
        freeze: () => {
          flushDrafts();
          runStore.pause();
        },
        error: (error) => {
          setProblem(`Could not save or restore run progress: ${ipcErrorMessage(error)}`);
        },
        restore: (context) => {
          const checkpoint = context.checkpoint;
          // The core's document, with its edits since it was saved: none for an empty draft.
          const next = context.document
            ? graphOf(fromFile(context.document, catalog(), DEFAULT_AGENT))
            : undefined;
          const savedGraph = context.savedText
            ? graphOf(fromFile(context.savedText, catalog(), DEFAULT_AGENT))
            : EMPTY_GRAPH;
          if (checkpoint) Engine.check(checkpoint);
          setCanvasId(context.id);
          if (next) {
            engine.reset();
            documentState.write(toFile(documentOf(next, context.id)));
            setLoads((n) => n + 1);
            setRawGraph(next);
            engine.update(canvasNodes(next.nodes));
            if (checkpoint) engine.restore(checkpoint);
            setSaved({ name: context.name ?? undefined, graph: savedGraph });
          }
          setProject(context.project ?? null);
          if (context.warning) setProblem(context.warning);
        },
      });
    return { engine, sessionStore, runStore, persistence, documentState };
  });
  const sessions = useSyncExternalStore(sessionStore.subscribe, sessionStore.snapshot);
  const run = useSyncExternalStore(runStore.subscribe, runStore.snapshot);
  const [restoring, setRestoring] = useState(runSource !== undefined);
  const [restoreFailed, setRestoreFailed] = useState(false);
  useEffect(() => {
    if (!persistence) return;
    let mounted = true;
    void persistence.initialize().then(
      () => {
        if (!mounted) return;
        setRestoring(false);
        persistence.changed();
      },
      (error: unknown) => {
        if (!mounted) return;
        setRestoring(false);
        setRestoreFailed(true);
        setProblem(`Could not restore run progress: ${ipcErrorMessage(error)}`);
      },
    );
    const runChanged = runStore.subscribe(() => {
      persistence.changed();
    });
    const sessionChanged = sessionStore.subscribe(() => {
      persistence.changed();
    });
    const unloading = () => {
      if (persistence.failedInitialization()) return;
      runStore.pause();
      void persistence.flush().catch(() => undefined);
    };
    window.addEventListener('beforeunload', unloading);
    return () => {
      mounted = false;
      runChanged();
      sessionChanged();
      window.removeEventListener('beforeunload', unloading);
      persistence.dispose();
    };
  }, [persistence, runStore, sessionStore]);
  useEffect(() => {
    documentState.write(toFile(documentOf(graph, canvasId)));
    persistence?.changed();
  }, [graph, canvasId, documentState, persistence]);
  /** Submitted messages are visible rows; the saved graph and the runner keep planned work only. */
  const displayNodes = useMemo(
    () => withSubmissions(graph.nodes, sessions),
    [graph.nodes, sessions],
  );
  /** The canvas's nodes as the run reads them (the model's, src/shared/model/canvas.ts). */
  const runNodes = useMemo(() => canvasNodes(graph.nodes), [graph.nodes]);
  /** What the run holds for the user (OKs), in graph order: shown on the canvas and in agents. */
  const asks = useMemo(() => heldAsks(runNodes, run, engine.catalog), [runNodes, run, engine]);
  /** How every queue's tasks are marked, wherever a queue is shown: links, and where the run is. */
  const layout = useMemo(() => lanesOf(displayNodes), [displayNodes]);
  const marks = useMemo(() => {
    const asking = new Set(
      Object.entries(sessions).flatMap(([id, session]) =>
        session.status === 'waiting' ? [id] : [],
      ),
    );
    return queueMarks(layout, run, asking, engine.catalog);
  }, [layout, run, sessions, engine]);
  // The engine follows the canvas as it is edited: its sessions the agents and how each runs, then
  // its run the queues.
  useEffect(() => {
    engine.update(runNodes);
  }, [runNodes, engine]);
  useEffect(
    () => () => {
      engine.reset();
    },
    [engine],
  );
  // Usage rules are checked again with each reading.
  useEffect(() => {
    runStore.usageChanged();
  }, [usage, runStore]);
  /** A usage gauge for each backend the agents use, with its rule and Simulate usage…. */
  const backends = useMemo(
    () =>
      backendsOf(
        catalog(),
        graph.nodes.flatMap((n) => (n.type === 'agent' ? [n.data.adapter ?? DEFAULT_AGENT] : [])),
      ),
    [graph.nodes],
  );
  const gauges = (
    <UsageGauges
      backends={backends}
      usage={usage}
      onRule={(backend, rule) => {
        usageStore.current?.setRule(backend, rule);
      }}
      onSimulate={(backend, windows) => {
        usageStore.current?.simulate(backend, windows);
      }}
    />
  );
  const text = useMemo(() => toFile(documentOf(graph, canvasId)), [graph, canvasId]);
  const savedText = useMemo(
    () => toFile(documentOf(saved.graph, canvasId)),
    [saved.graph, canvasId],
  );
  const edited = text !== savedText;
  /** What would discard unsaved changes, while the user is asked first. */
  const [discarding, setDiscarding] = useState<{ run: () => void }>();
  // What agents can be set to is read there (its own settings count): again for another folder.
  useEffect(() => {
    sessionStore.forgetOptions();
  }, [project?.path, sessionStore]);
  /** Whether the templates gallery is open. */
  const [gallery, setGallery] = useState(false);
  /** Which CLIs the user has, asked of main as the gallery opens: its agents' default connections. */
  const [installed, setInstalled] = useState<InstalledClis>();
  useEffect(() => {
    if (!gallery) return;
    let open = true;
    (sessionBackend ?? NO_BACKEND).installed().then(
      (found) => {
        if (open) setInstalled(found);
      },
      () => undefined,
    );
    return () => {
      open = false;
    };
  }, [gallery, sessionBackend]);
  /** Every agent's queue, side by side, if shown: opened from the canvas, or from an agent. */
  const [queues, setQueues] = useState<{ from?: string }>();
  /** The canvas's saved automatic layout setting (nodes cannot be dragged while it is on). */
  const arranging = graph.arrange ?? false;
  const [editing, setEditing] = useState<string>();
  /**
   * The agents opened in the agent view, by a double-click (or from a list of them) or from its
   * rail: the first is shown, and the rest wait in the rail's stack, most recent first. `from` is
   * where the one shown grew from when it came from the rail.
   */
  const [opened, setOpened] = useState<{
    ids: readonly string[];
    from?: { id: string; rect: DOMRect };
  }>({ ids: [] });
  /** Those still on the canvas (agents deleted meanwhile drop out), the one shown first. */
  const openedIds = useMemo(() => {
    const agents = new Set(graph.nodes.flatMap((n) => (n.type === 'agent' ? [n.id] : [])));
    return opened.ids.filter((id) => agents.has(id));
  }, [opened.ids, graph.nodes]);
  /** The agent shown in the agent view, if any. */
  const front = openedIds[0];
  /** How it runs: its session starts when its view opens, and again when that changes. */
  const frontNode = graph.nodes.find((n) => n.id === front);
  const frontConnection = frontNode ? connectionOf(frontNode.data) : undefined;
  useEffect(() => {
    if (front !== undefined && frontConnection !== undefined) sessionStore.open(front);
  }, [front, frontConnection, sessionStore]);
  /** The work between two agents opened in a panel, if any. */
  const [work, setWork] = useState<{ from: string; to: string }>();
  /** An edge just drawn between two agents, while its menu asks what it makes; where it ended. */
  const [drawn, setDrawn] = useState<Connection & { at?: MenuPlace }>();
  const [settingsAgent, setSettingsAgent] = useState<string>();
  const closeSettings = useCallback(() => {
    setSettingsAgent(undefined);
  }, []);
  const [agentMenu, setAgentMenu] = useState<{ id: string; x: number; y: number }>();
  const closeAgentMenu = useCallback(() => {
    setAgentMenu(undefined);
  }, []);
  const showAgentMenu = useCallback((event: ReactMouseEvent, id: string) => {
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, [contenteditable="true"]')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target instanceof HTMLElement)
      event.target
        .closest<HTMLElement>('.react-flow__node, button')
        ?.focus({ preventScroll: true });
    setDrawn(undefined);
    setAgentMenu({ id, x: event.clientX, y: event.clientY });
  }, []);
  const store = useStoreApi();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  /** Whether a panel, menu or question is open, which has the keyboard (Escape closes it). */
  const modal =
    front !== undefined ||
    work !== undefined ||
    drawn !== undefined ||
    agentMenu !== undefined ||
    settingsAgent !== undefined ||
    discarding !== undefined ||
    gallery ||
    queues !== undefined;
  // The keyboard handler and file commands read these without re-subscribing on every change.
  const latest = useRef({ graph, modal, text, edited });
  useEffect(() => {
    latest.current = { graph, modal, text, edited };
  });
  /** Every change to the graph goes through here, so it stays arranged while arranging is on. */
  const setGraph = useCallback((op: (graph: Graph) => Graph) => {
    setRawGraph((g) => {
      const next = op(g);
      return next.arrange ? arrange(next) : next;
    });
  }, []);

  const nodeElement = useCallback(
    (id: string) =>
      wrapper.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`) ?? null,
    [],
  );
  const openedCard = useCallback(
    () =>
      front === undefined
        ? undefined
        : nodeElement(front)?.querySelector('.graph-card')?.getBoundingClientRect(),
    [front, nodeElement],
  );
  /** Closes the agent view, stack and all; the agent shown has the keyboard on the canvas. */
  const closeOpened = useCallback(() => {
    if (front !== undefined) nodeElement(front)?.focus();
    setOpened({ ids: [] });
  }, [front, nodeElement]);

  /**
   * Changes what a connected agent is set to run with by the adapter it runs now (its settings,
   * saved with it). What it runs with changes nothing laid out; an unavailable connector has none to change.
   */
  const updateSettings = useCallback((id: string, change: AgentSettingsChange) => {
    setRawGraph((g) => {
      const node = g.nodes.find((n) => n.id === id);
      const connection = node ? connectionOf(node.data) : 'unavailable';
      if (!node || connection === 'unavailable') return g;
      const adapter = adapterOf(connection);
      return setSettings(g, id, adapter, change);
    });
  }, []);

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
      queueState: (id) => queueControlText(run, id),
      groupState: (id) => groupControlText(graph.nodes, run, id),
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
    [apply, editing, setGraph, graph.nodes, run],
  );

  const edits = useMemo<QueueEdits>(
    () => ({
      add: (owner, entry, into) => {
        const item = { id: crypto.randomUUID(), ...entry };
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
      setInstruction: (owner, itemId, instruction) => {
        setGraph((g) => setInstruction(g, owner, itemId, instruction));
      },
      setExpect: (owner, itemId, expect) => {
        setGraph((g) => setExpect(g, owner, itemId, expect));
      },
      setCondition: (owner, ifId, condition) => {
        setGraph((g) => setCondition(g, owner, ifId, condition));
      },
      setWaitFor: (owner, waitId, targets) => {
        setGraph((g) => setWaitFor(g, owner, waitId, targets));
      },
      setTime: (owner, itemId, time) => {
        setGraph((g) => setTime(g, owner, itemId, time));
      },
      setApproval: (owner, okId, approve) => {
        setGraph((g) => setApproval(g, owner, okId, approve));
      },
      setRepeat: (owner, repeatId, change) => {
        setGraph((g) => setRepeat(g, owner, repeatId, change));
      },
      goOn: (owner, itemId) => {
        runStore.goOn(owner, itemId);
      },
      decide: (owner, itemId, answer) => {
        runStore.decide(owner, itemId, answer);
      },
    }),
    [setGraph, runStore],
  );
  const closeWork = useCallback(() => {
    setWork(undefined);
  }, []);
  const closeGallery = useCallback(() => {
    setGallery(false);
  }, []);
  const closeQueues = useCallback(() => {
    setQueues(undefined);
  }, []);

  useEffect(() => {
    // React Flow holds the new nodes by now (its effects run first); it fits once they are measured.
    if (loads > 0) void fitView({ padding: 0.2, maxZoom: 1 });
  }, [loads, fitView]);
  /** The group a template was last inserted as: the view moves to show it. */
  const [inserted, setInserted] = useState<string>();
  useEffect(() => {
    if (inserted !== undefined)
      void fitView({ nodes: [{ id: inserted }], padding: 0.3, maxZoom: 1 });
  }, [inserted, fitView]);

  /**
   * Replaces the canvas with canvas `id` from a file (`name`), or a new one, and fits the view to
   * it.
   */
  const load = useCallback(
    (next: Graph, name: string | undefined, id: CanvasId) => {
      setCanvasId(id);
      documentState.write(toFile(documentOf(next, id)));
      setLoads((n) => n + 1);
      setRawGraph(next);
      runStore.reset();
      // Another canvas: main has ended the old one's connected sessions.
      sessionStore.reset();
      setSaved({ name, graph: next });
      setEditing(undefined);
      setOpened({ ids: [] });
      setSettingsAgent(undefined);
      setWork(undefined);
      setDrawn(undefined);
      setAgentMenu(undefined);
      setProblem(undefined);
    },
    [runStore, sessionStore, documentState],
  );
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
      setProblem(`Could not ${doing}: ${ipcErrorMessage(error)}`);
    };
    const { chooseProject } = files;
    return {
      new: (edited: boolean) => {
        unless(edited, () => {
          if (persistence) {
            runStore.pause();
            void persistence
              .prepareForReplacement()
              .then(() =>
                persistence.transition(async () => {
                  load(EMPTY_GRAPH, undefined, await files.forget());
                  setProject(null);
                }, false),
              )
              .then(() => {
                setRestoreFailed(false);
                persistence.changed();
              }, failed('start a new canvas'));
            return;
          }
          setProject(null);
          files.forget().then((id) => {
            load(EMPTY_GRAPH, undefined, id);
          }, failed('start a new canvas'));
        });
      },
      open: (edited: boolean) => {
        unless(edited, () => {
          if (persistence) {
            runStore.pause();
            void persistence
              .prepareForReplacement()
              .then(() =>
                persistence.transition(
                  files.open,
                  (file) => file !== null,
                  async () => {
                    const id = await files.forget();
                    setCanvasId(id);
                    setProject(null);
                    setSaved({ name: undefined, graph: EMPTY_GRAPH });
                  },
                ),
              )
              .then(
                () => {
                  setRestoreFailed(false);
                  persistence.changed();
                },
                (error: unknown) => {
                  setRestoreFailed(persistence.failedInitialization());
                  failed('open the canvas')(error);
                },
              );
            return;
          }
          // The core refuses a file that isn't a canvas, and sends the document it keeps.
          files
            .open()
            .then((file) => {
              if (!file) return;
              load(graphOf(fromFile(file.text, catalog(), DEFAULT_AGENT)), file.name, file.id);
              setProject(file.project ?? null);
            })
            .catch(failed('open the canvas'));
        });
      },
      /** Opens a template as a new canvas, saved nowhere yet, as `choices` fill it in. */
      example: (example: Example, choices: TemplateChoices, edited: boolean) => {
        unless(edited, () => {
          if (persistence) {
            runStore.pause();
            void persistence
              .prepareForReplacement()
              .then(() =>
                persistence.transition(async () => {
                  load(fromTemplate(example, choices), undefined, await files.forget());
                  setProject(null);
                }, false),
              )
              .then(() => {
                setRestoreFailed(false);
                persistence.changed();
              }, failed('open the template'));
            return;
          }
          setProject(null);
          files.forget().then((id) => {
            load(fromTemplate(example, choices), undefined, id);
          }, failed('open the template'));
        });
      },
      /** Asks for the folder the canvas's agents work in. */
      chooseProject:
        chooseProject &&
        (() => {
          chooseProject().then((folder) => {
            if (folder) setProject(folder);
            if (persistence)
              void persistence.rebind(false).then(() => {
                persistence.changed();
              }, failed('remember the project folder'));
          }, failed('choose the project folder'));
        }),
      save: (text: string, choose: boolean) => {
        if (persistence) {
          void persistence
            .flush()
            .then(() =>
              persistence.transition(async () => {
                const name = await files.save(text, choose);
                if (name !== null)
                  setSaved({ name, graph: graphOf(fromFile(text, catalog(), DEFAULT_AGENT)) });
              }, false),
            )
            .then(() => {
              persistence.changed();
            }, failed('save the canvas'));
          return;
        }
        files.save(text, choose).then((name) => {
          if (name !== null)
            setSaved({ name, graph: graphOf(fromFile(text, catalog(), DEFAULT_AGENT)) });
        }, failed('save the canvas'));
      },
    };
  }, [files, load, persistence, runStore]);
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
      if (restoreFailed && file !== 'new' && file !== 'open') return;
      if (commands && file) {
        event.preventDefault();
        flushDrafts();
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
      flushDrafts();
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
  }, [apply, commands, restoreFailed]);

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

  // Each node shows its group's colour, and an agent waiting on the user (a prompt of its session,
  // what the run holds for the user at an OK, or what its CLI asks in its terminal, such as whether
  // to trust the folder as it starts) glows, through classes React Flow puts on it (GraphEditor.css).
  // Screen readers hear an agent's type with its label.
  const nodes = useMemo(() => {
    const colors = groupColors(displayNodes);
    return displayNodes.map((n) => {
      const color = colors.get(n.id);
      const status = sessions[n.id]?.status ?? 'idle';
      // Waiting on a permission answer is asking too, as is what its CLI asks in its terminal.
      const asking =
        status === 'waiting' ||
        (sessions[n.id]?.asking?.length ?? 0) > 0 ||
        (run.running && run.agents[n.id]?.status === 'asking');
      const classes = [
        ...(color === undefined ? [] : [`group-color-${String(color)}`]),
        ...(asking ? ['asking'] : []),
        ...(status === 'idle' ? [] : ['working']),
      ];
      const name = n.data.label || 'Unnamed agent';
      const type = agentLabel(n.data.adapter ?? DEFAULT_AGENT, connectionOf(n.data), {
        short: true,
      });
      return {
        ...n,
        ...(classes.length === 0 ? {} : { className: classes.join(' ') }),
        ...(n.type === 'agent' ? { ariaLabel: `${name}, ${type}` } : {}),
      };
    });
  }, [displayNodes, sessions, run]);
  /** What needs the user, as the engine derives it: the run's holds, and what sessions ask. */
  const needed = useMemo(() => {
    const input = {
      canvas: canvasId,
      nodes: runNodes,
      run,
      sessions,
      catalog: engine.catalog,
    };
    return { input, needs: needsOf(input) };
  }, [canvasId, runNodes, run, sessions, engine]);

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
  const openedNode = displayNodes.find((n) => n.id === front);
  /** The other agents opened from the agent view's rail, as its stack shows them. */
  const stack = openedIds.slice(1).flatMap((id) => {
    const n = graph.nodes.find((other) => other.id === id);
    return n
      ? [
          {
            id,
            name: n.data.label || 'Unnamed agent',
            agent: n.data.adapter ?? DEFAULT_AGENT,
            status: sessions[id]?.status ?? 'idle',
          },
        ]
      : [];
  });
  const canGroup = groupMembers(graph.nodes).length > 0;

  if (restoreFailed) {
    return (
      <div className="graph-editor">
        <div className="graph-file-panel">
          <p className="graph-file-problem graph-panel" role="alert">
            {problem ?? 'Run progress could not be restored.'} The saved progress has been kept.
            Choose New or Open to continue.
          </p>
          {commands && (
            <div className="graph-file graph-panel" role="toolbar" aria-label="Canvas recovery">
              <button
                type="button"
                onClick={() => {
                  commands.new(false);
                }}
              >
                New
              </button>
              <button
                type="button"
                onClick={() => {
                  commands.open(false);
                }}
              >
                Open…
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const settingsNode = graph.nodes.find(
    (node) => node.id === settingsAgent && node.type === 'agent',
  );
  const menuNode = agentMenu && graph.nodes.find((node) => node.id === agentMenu.id);
  const menuIsGroup = menuNode && isGroup(graph.nodes, menuNode.id);
  const menuMembers = menuIsGroup ? groupAgentIds(graph.nodes, menuNode.id) : [];
  const pauseMenuGroup = () => {
    if (menuNode) runStore.pauseGroup(menuNode.id);
  };
  const killMenuGroup = () => {
    if (!menuNode) return;
    runStore.killGroup(menuNode.id);
    for (const id of menuMembers) sessionStore.stop(id);
  };
  const resumeMenuGroup = () => {
    if (menuNode) runStore.resumeGroup(menuNode.id);
  };

  return (
    <GraphActionsContext value={actions}>
      <div
        className="graph-editor"
        ref={wrapper}
        inert={restoring}
        aria-busy={restoring}
        onKeyDownCapture={(event) => {
          if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
          if (
            !(event.target instanceof HTMLElement) ||
            event.target.closest('input, textarea, [contenteditable="true"]')
          )
            return;
          const target = event.target.closest<HTMLElement>('[data-agent-menu], .react-flow__node');
          const id = target?.dataset.agentMenu ?? target?.dataset.id;
          if (!target || !id) return;
          event.preventDefault();
          event.stopPropagation();
          const box = target.getBoundingClientRect();
          setAgentMenu({ id, x: box.left + 16, y: box.bottom });
        }}
      >
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
          onNodeContextMenu={(event, node) => {
            showAgentMenu(event, node.id);
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
              setOpened({ ids: [node.id] });
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
                setGraph((g) => ({ ...g, arrange: !g.arrange }));
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 1h4v3H6zM1 11h4v3H1zM11 11h4v3h-4zM7.5 4h1v2.5h5V11h-1V7.5h-9V11h-1V6.5h5z" />
              </svg>
            </ControlButton>
            <ControlButton
              aria-label="Show all queues"
              title="All queues: every agent's, side by side"
              onClick={() => {
                setQueues({});
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1 2h4v12H1zM6 2h4v8H6zM11 2h4v10h-4z" />
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
          {needed.needs.length > 0 && (
            <Panel position="top-right">
              <QuestionsSidebar
                needs={needed.needs}
                input={needed.input}
                onDecide={edits.decide}
                onAnswer={(agentId, promptId, index, answer) => {
                  sessionStore.answerQuestion(agentId, promptId, index, answer);
                }}
                onOpen={(agentId) => {
                  apply((g) => selectOnly(g, agentId));
                  setOpened({ ids: [agentId] });
                }}
              />
            </Panel>
          )}
          {commands && (
            <Panel position="top-left">
              <FileBar
                name={saved.name}
                edited={edited}
                {...(commands.chooseProject
                  ? { project: { folder: project, onChoose: commands.chooseProject } }
                  : {})}
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
                extra={gauges}
              />
            </Panel>
          )}
          {!commands && backends.length > 0 && <Panel position="top-left">{gauges}</Panel>}
          {commands && graph.nodes.length === 0 && (
            <Panel position="top-center" className="graph-panel graph-start">
              <button
                type="button"
                onClick={() => {
                  setGallery(true);
                }}
              >
                Start from a template…
              </button>
            </Panel>
          )}
          <Panel position="bottom-center" className="graph-panel graph-hint">
            Double-click the canvas to add an agent, or an agent to open it · Drag between agents'
            dots to let them talk or queue work · Drag on empty space to select · F2 to rename
          </Panel>
        </ReactFlow>
        {openedNode && (
          <AgentView
            key={openedNode.id}
            node={openedNode}
            queueState={queueControlText(run, openedNode.id)}
            onAgentContextMenu={(event) => {
              showAgentMenu(event, openedNode.id);
            }}
            nodes={displayNodes}
            origin={openedCard}
            from={opened.from?.id === openedNode.id ? opened.from.rect : undefined}
            stack={stack}
            onNewAgent={(relation, from) => {
              const id = crypto.randomUUID();
              apply((g) => spawnAgent(g, openedNode.id, id, relation));
              setOpened(({ ids }) => ({ ids: [id, ...ids], from: { id, rect: from } }));
            }}
            onSwitch={(id, from) => {
              apply((g) => selectOnly(g, id));
              setOpened(({ ids }) => ({
                ids: [id, ...ids.filter((other) => other !== id)],
                from: { id, rect: from },
              }));
            }}
            onRename={(label) => {
              setGraph((g) => renameNode(g, openedNode.id, label));
            }}
            connection={connectionOf(openedNode.data)}
            project={project}
            terminal={terminalBackend}
            onAgent={(agent, connection) => {
              setGraph((g) =>
                setConnection(setAgent(g, openedNode.id, agent), openedNode.id, connection),
              );
            }}
            onOpenSettings={() => {
              setSettingsAgent(openedNode.id);
            }}
            onContinueInTerminal={(command) => {
              // Its terminal resumes the conversation (the connections share it), and runs the
              // command typed for it once the agent runs there.
              const terminal = continuesIn(connectionOf(openedNode.data));
              if (terminal === undefined) return;
              if (command !== undefined) {
                sessionStore.sendOnceIn(
                  openedNode.id,
                  terminal,
                  openedNode.data.adapter ?? DEFAULT_AGENT,
                  command,
                );
              }
              setGraph((g) => setConnection(g, openedNode.id, terminal));
            }}
            edits={edits}
            marks={marks}
            ask={asks.find((ask) => ask.agent.id === openedNode.id)}
            onShowQueues={() => {
              setQueues({ from: openedNode.id });
            }}
            session={sessions[openedNode.id] ?? NEW_SESSION}
            controls={{
              recordSubmission: (text, images) => {
                sessionStore.recordSubmission(openedNode.id, text, images);
              },
              open: () => {
                sessionStore.open(openedNode.id);
              },
              send: (text, images) => {
                sessionStore.send(
                  openedNode.id,
                  openedNode.data.adapter ?? DEFAULT_AGENT,
                  text,
                  undefined,
                  images,
                );
              },
              findFiles: (query) => sessionStore.findFiles(query),
              pastSessions: () => sessionStore.pastSessions(openedNode.id),
              resume: (sessionId) => sessionStore.resume(openedNode.id, sessionId),
              previewRewind: (messageId) => sessionStore.previewRewind(openedNode.id, messageId),
              rewind: (messageId, restore) =>
                sessionStore.rewind(openedNode.id, messageId, restore),
              mcpServers: () => sessionStore.mcpServers(openedNode.id),
              changeMcpServer: (server, change) =>
                sessionStore.changeMcpServer(openedNode.id, server, change),
              answerElicitation: (promptId, action, values) => {
                sessionStore.answerElicitation(openedNode.id, promptId, action, values);
              },
              answer: (permissionId, answer, feedback) => {
                sessionStore.answer(openedNode.id, permissionId, answer, feedback);
              },
              answerQuestion: (promptId, index, answer) => {
                sessionStore.answerQuestion(openedNode.id, promptId, index, answer);
              },
              answerPlan: (promptId, answer) => {
                sessionStore.answerPlan(openedNode.id, promptId, answer);
              },
              stop: () => {
                sessionStore.stop(openedNode.id);
              },
              unqueue: (queuedId) => {
                sessionStore.unqueue(openedNode.id, queuedId);
              },
              // What the composer chooses for a connected agent is what it is set to run with in
              // its CLI (saved with it), as well as what its session switches to; a mode that
              // never asks only for the session, never saved.
              setMode: (mode) => {
                sessionStore.setMode(openedNode.id, mode);
                updateSettings(openedNode.id, {
                  mode: UNASKING_MODES.includes(mode) ? null : mode,
                });
              },
              setModel: (model) => {
                sessionStore.setModel(openedNode.id, model);
                updateSettings(openedNode.id, { model });
              },
              setEffort: (effort) => {
                sessionStore.setEffort(openedNode.id, effort);
                updateSettings(openedNode.id, { effort });
              },
              settingsOptions: (adapter) => sessionStore.settingsOptions(adapter),
              restart: () => {
                void sessionStore.restart(openedNode.id);
              },
              stopTask: (taskId) => {
                sessionStore.stopTask(openedNode.id, taskId);
              },
            }}
            onClose={closeOpened}
          />
        )}
        {work && (
          <WorkDetail
            key={`${work.from}->${work.to}`}
            from={work.from}
            to={work.to}
            nodes={displayNodes}
            edits={edits}
            marks={marks}
            onClose={closeWork}
          />
        )}
        {queues && (
          <QueuesView
            nodes={displayNodes}
            sessions={sessions}
            run={run}
            edits={edits}
            gauges={gauges}
            onRun={() => {
              flushDrafts();
              runStore.start();
            }}
            onStop={() => {
              runStore.stop();
            }}
            onResume={() => {
              runStore.resume();
            }}
            onAgentContextMenu={showAgentMenu}
            onOpenSettings={setSettingsAgent}
            settingsOptions={(adapter) => sessionStore.settingsOptions(adapter)}
            {...(queues.from === undefined ? {} : { focus: queues.from })}
            backLabel={queues.from === undefined ? 'Canvas' : nameOf(queues.from)}
            onOpenAgent={(id) => {
              setQueues(undefined);
              apply((g) => selectOnly(g, id));
              setOpened({ ids: [id] });
            }}
            onClose={closeQueues}
          />
        )}
        {gallery && (
          <ExampleGallery
            canInsert={graph.nodes.length > 0}
            installed={installed}
            onPick={(template, choices, use) => {
              const example = exampleOf(template.id);
              if (!example) {
                setProblem('That template is no longer available in this build.');
                return;
              }
              setGallery(false);
              if (use === 'new') {
                commands?.example(example, choices, edited);
                return;
              }
              // Inserted as one group, beside what is there, and brought into view.
              const group = crypto.randomUUID();
              setGraph((g) =>
                insertGraph(g, fromTemplate(example, choices), {
                  group,
                  name: example.name,
                  newId: () => crypto.randomUUID(),
                }),
              );
              setInserted(group);
            }}
            onClose={closeGallery}
          />
        )}
        {drawn && (
          <ConnectMenu
            fromName={nameOf(drawn.source)}
            toName={nameOf(drawn.target)}
            linked={areLinked(graph.edges, drawn.source, drawn.target)}
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
        {settingsNode && (
          <AgentSettingsPanel
            key={`settings:${settingsNode.id}`}
            node={settingsNode}
            session={sessions[settingsNode.id] ?? NEW_SESSION}
            options={(adapter) => sessionStore.settingsOptions(adapter)}
            onRename={(name) => {
              setGraph((g) => renameNode(g, settingsNode.id, name));
            }}
            onRole={(role) => {
              setRawGraph((g) => setRole(g, settingsNode.id, role));
            }}
            onAgent={(agent, connection) => {
              setGraph((g) =>
                setConnection(setAgent(g, settingsNode.id, agent), settingsNode.id, connection),
              );
            }}
            onSettings={(adapter, settings) => {
              setRawGraph((g) =>
                setSettings(g, settingsNode.id, adapter, {
                  model: settings.model ?? null,
                  effort: settings.effort ?? null,
                  mode: settings.mode ?? null,
                }),
              );
            }}
            onRestart={() => {
              void sessionStore.restart(settingsNode.id);
            }}
            onFresh={() => {
              void sessionStore.fresh(settingsNode.id).catch((error: unknown) => {
                sessionStore.notice(settingsNode.id, 'error', ipcErrorMessage(error));
              });
            }}
            onClose={closeSettings}
          />
        )}
        {agentMenu && menuNode && (
          <AgentContextMenu
            key={agentMenu.id}
            name={nameOf(agentMenu.id)}
            at={agentMenu}
            scope={menuNode.type === 'frame' ? 'group' : 'agent'}
            paused={
              menuNode.type === 'frame'
                ? groupPaused(run, menuNode.id)
                : individualPaused(run, menuNode.id)
            }
            {...(menuNode.type === 'frame' ? { groupSize: menuMembers.length } : {})}
            {...(menuNode.type === 'agent'
              ? {
                  onSettings: () => {
                    setSettingsAgent(menuNode.id);
                  },
                }
              : {})}
            heldByGroups={[...new Set((run.groupPauses ?? []).map(({ id }) => id))]
              .filter((id) => groupAgentIds(graph.nodes, id).includes(menuNode.id))
              .map(nameOf)}
            {...(menuNode.type === 'agent' && menuIsGroup
              ? {
                  group: {
                    size: menuMembers.length,
                    paused: groupPaused(run, menuNode.id),
                    onPause: pauseMenuGroup,
                    onKill: killMenuGroup,
                    onResume: resumeMenuGroup,
                  },
                }
              : {})}
            onPause={() => {
              if (menuNode.type === 'frame') pauseMenuGroup();
              else runStore.pauseAgent(menuNode.id);
            }}
            onKill={() => {
              if (menuNode.type === 'frame') killMenuGroup();
              else {
                runStore.killAgent(menuNode.id);
                sessionStore.stop(menuNode.id);
              }
            }}
            onResume={() => {
              if (menuNode.type === 'frame') resumeMenuGroup();
              else runStore.resumeAgent(menuNode.id);
            }}
            onClose={closeAgentMenu}
          />
        )}
      </div>
    </GraphActionsContext>
  );
}
