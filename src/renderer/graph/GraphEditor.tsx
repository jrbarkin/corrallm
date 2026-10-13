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

import type { CanvasFile, ProjectFolder } from '../../shared/ipc';
import { CONNECTION_CLI, TERMINAL_CONNECTIONS, UNASKING_MODES } from '../../shared/session';
import type { AgentSettings, InstalledClis } from '../../shared/session';
import { AgentView } from '../agent/AgentView';
import { NO_BACKEND } from '../agent/connected';
import type { SessionBackend } from '../agent/connected';
import { NEW_SESSION, pendingSessionQuestions } from '../agent/session';
import type { AskedInSession } from '../agent/session';
import { SessionStore } from '../agent/sessions';
import { ipcErrorMessage } from '../ipc-error';
import { QueuesView } from '../queues/QueuesView';
import { lanesOf } from '../queues/lanes';
import { queueMarks } from '../queues/marks';
import { heldAsks } from '../run/asks';
import { RunStore } from '../run/runner';
import { UsageStore } from '../usage/store';
import type { UsageSource } from '../usage/store';
import { UsageGauges } from '../usage/UsageGauge';
import { backendsOf } from '../usage/usage';
import { NO_TERMINAL } from '../terminal/backend';
import type { TerminalBackend } from '../terminal/backend';
import { GraphActionsContext } from './actions';
import { agentLabel, connectionOf, DEFAULT_AGENT } from './agents';
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
  setApproval,
  setRepeat,
  setCondition,
  setConnection,
  setExpect,
  setSettings,
  setInstruction,
  setTime,
  setWaitFor,
  spawnAgent,
  ungroupSelection,
} from './graph';
import type { Graph, GraphNode } from './graph';
import { ExampleGallery } from './ExampleGallery';
import type { TemplateChoices } from './ExampleGallery';
import { EXAMPLES } from './examples';
import type { Example } from './examples';
import { FileBar } from './FileBar';
import { fromFile, toFile } from './file';
import { fillTemplate, withAgents, withConnections } from './templates';
import { insertGraph } from './insert';
import { fileAction, keyAction, SHORTCUTS } from './keys';
import { arrange } from './layout';
import type { KeyAction } from './keys';
import { ConnectMenu } from './ConnectMenu';
import type { MenuPlace } from './ConnectMenu';
import { AgentNodeView, GroupNodeView, LinkView, WorkEdgeView } from './nodes';
import type { WorkFlowEdge } from './nodes';
import type { Question } from './queue';
import { QuestionsSidebar } from './Questions';
import type { CardQuestion } from './Questions';
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
}: {
  initialGraph?: Graph;
  files?: CanvasFiles;
  sessionBackend?: SessionBackend;
  terminalBackend?: TerminalBackend;
  usageSource?: UsageSource;
}) {
  return (
    <ReactFlowProvider>
      <Editor
        initialGraph={initialGraph}
        files={files}
        sessionBackend={sessionBackend}
        terminalBackend={terminalBackend}
        usageSource={usageSource}
      />
    </ReactFlowProvider>
  );
}

/** A template as a canvas: its blanks filled in, its agents given their types and connections. */
function fromTemplate(example: Example, { values, agents, connections }: TemplateChoices): Graph {
  return withConnections(
    withAgents(fillTemplate(fromFile(example.text), values), agents),
    connections,
  );
}

function Editor({
  initialGraph,
  files,
  sessionBackend,
  terminalBackend,
  usageSource,
}: {
  initialGraph: Graph;
  files: CanvasFiles | undefined;
  sessionBackend: SessionBackend | undefined;
  terminalBackend: TerminalBackend;
  usageSource: UsageSource | undefined;
}) {
  const [graph, setRawGraph] = useState(initialGraph);
  /** Every backend's usage reading and rule (main's: one per backend, for every canvas). */
  const [usageStore] = useState(() => new UsageStore(usageSource));
  const usage = useSyncExternalStore(usageStore.subscribe, usageStore.snapshot);
  /** Every agent's session, playing on while its view is closed: scripted, or connected. */
  const [sessionStore] = useState(() => new SessionStore(sessionBackend));
  const sessions = useSyncExternalStore(sessionStore.subscribe, sessionStore.snapshot);
  /**
   * Every agent's queue, run: messages go to the agents' sessions, and so do connected agents'
   * steps and questions; a simulated agent's steps are simulated. An agent whose session would not
   * start is switched to the connection the user chose for it there.
   */
  const [runStore] = useState(
    () =>
      new RunStore({
        send: (agent, text, done, images, refused) =>
          sessionStore.send(
            agent.id,
            agent.data.agent ?? DEFAULT_AGENT,
            text,
            (failed, reply) => {
              done({ failed, reply });
            },
            images && [...images],
            refused,
          ),
        tell: (agent, text) => {
          sessionStore.notice(agent.id, 'warning', text);
        },
        connect: (agent, connection) => {
          // How an agent runs changes nothing laid out.
          setRawGraph((g) => setConnection(g, agent.id, connection));
        },
        later: (run, ms) => {
          const timer = setTimeout(run, ms);
          return () => {
            clearTimeout(timer);
          };
        },
        // The real clock, read when asked: delays and time limits are real, even simulated.
        now: () => Date.now(),
        chance: Math.random,
        usage: () => usageStore.snapshot(),
      }),
  );
  const run = useSyncExternalStore(runStore.subscribe, runStore.snapshot);
  /** What the run holds for the user (OKs), in graph order: shown on the canvas and in agents. */
  const asks = useMemo(() => heldAsks(graph.nodes, run), [graph.nodes, run]);
  /** How every queue's tasks are marked, wherever a queue is shown: links, and where the run is. */
  const layout = useMemo(() => lanesOf(graph.nodes), [graph.nodes]);
  const marks = useMemo(() => {
    const asking = new Set(
      Object.entries(sessions).flatMap(([id, session]) =>
        session.status === 'waiting' ? [id] : [],
      ),
    );
    return queueMarks(layout, run, asking);
  }, [layout, run, sessions]);
  // Sessions follow the agents on the canvas, and how each runs. Before the run reads the queues,
  // which may send agents messages.
  useEffect(() => {
    sessionStore.sync(
      graph.nodes.flatMap((n) =>
        n.type === 'agent'
          ? [{ id: n.id, connection: connectionOf(n.data), settings: n.data.settings }]
          : [],
      ),
    );
  }, [graph.nodes, sessionStore]);
  useEffect(
    () => () => {
      sessionStore.reset();
    },
    [sessionStore],
  );
  // The run reads the queues as they are edited.
  useEffect(() => {
    runStore.update(graph.nodes);
  }, [graph.nodes, runStore]);
  useEffect(
    () => () => {
      runStore.reset();
    },
    [runStore],
  );
  // Usage rules are checked again with each reading.
  useEffect(() => {
    runStore.usageChanged();
  }, [usage, runStore]);
  useEffect(
    () => () => {
      usageStore.dispose();
    },
    [usageStore],
  );
  /** A usage gauge for each backend the agents use, with its rule and Simulate usage…. */
  const backends = useMemo(
    () => backendsOf(graph.nodes.flatMap((n) => (n.type === 'agent' ? [n.data] : []))),
    [graph.nodes],
  );
  const gauges = (
    <UsageGauges
      backends={backends}
      usage={usage}
      onRule={(backend, rule) => {
        usageStore.setRule(backend, rule);
      }}
      onSimulate={(backend, windows) => {
        usageStore.simulate(backend, windows);
      }}
    />
  );
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
  /** The folder the canvas's agents work in (main keeps it; this is what the file bar shows). */
  const [project, setProject] = useState<ProjectFolder | null>(null);
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
  /** Whether the graph is laid out automatically (and nodes cannot be dragged). */
  const [arranging, setArranging] = useState(false);
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
  const store = useStoreApi();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  /** Whether a panel, menu or question is open, which has the keyboard (Escape closes it). */
  const modal =
    front !== undefined ||
    work !== undefined ||
    drawn !== undefined ||
    discarding !== undefined ||
    gallery ||
    queues !== undefined;
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
   * Changes what a connected agent is set to run with in the CLI it runs now (its settings, saved
   * with it). What it runs with changes nothing laid out; a simulated agent has none to change.
   */
  const updateSettings = useCallback(
    (id: string, change: (settings: AgentSettings) => AgentSettings) => {
      setRawGraph((g) => {
        const node = g.nodes.find((n) => n.id === id);
        const connection = node ? connectionOf(node.data) : 'simulated';
        if (!node || connection === 'simulated') return g;
        const cli = CONNECTION_CLI[connection];
        return setSettings(g, id, cli, change(node.data.settings?.[cli] ?? {}));
      });
    },
    [],
  );

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

  /** How many canvases have been loaded: the view fits each one, once React Flow has its nodes. */
  const [loads, setLoads] = useState(0);
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

  /** Replaces the canvas with one from a file (`name`), or a new one, and fits the view to it. */
  const load = useCallback(
    (next: Graph, name: string | undefined) => {
      setLoads((n) => n + 1);
      setRawGraph(next);
      runStore.reset();
      // Another canvas: main has ended the old one's connected sessions.
      sessionStore.reset();
      setSaved({ name, text: toFile(next) });
      setArranging(false);
      setEditing(undefined);
      setOpened({ ids: [] });
      setWork(undefined);
      setDrawn(undefined);
      setProblem(undefined);
    },
    [runStore, sessionStore],
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
          load(EMPTY_GRAPH, undefined);
          setProject(null);
          files.forget().catch(failed('start a new canvas'));
        });
      },
      open: (edited: boolean) => {
        unless(edited, () => {
          files.open().then((file) => {
            if (!file) return;
            try {
              load(fromFile(file.text), file.name);
              setProject(file.project ?? null);
            } catch (error) {
              setProblem(`Could not open ${file.name}: ${ipcErrorMessage(error)}`);
              // Main took it as the canvas's file: never save this canvas over it.
              setProject(null);
              files.forget().catch(failed('open the canvas'));
            }
          }, failed('open the canvas'));
        });
      },
      /** Opens a template as a new canvas, saved nowhere yet, as `choices` fill it in. */
      example: (example: Example, choices: TemplateChoices, edited: boolean) => {
        unless(edited, () => {
          load(fromTemplate(example, choices), undefined);
          setProject(null);
          files.forget().catch(failed('open the template'));
        });
      },
      /** Asks for the folder the canvas's agents work in. */
      chooseProject:
        chooseProject &&
        (() => {
          chooseProject().then((folder) => {
            if (folder) setProject(folder);
          }, failed('choose the project folder'));
        }),
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

  // Each node shows its group's colour, and an agent with a question for the user (or one the run
  // holds for the user, at an OK; or what its CLI asks in its terminal, such as whether to trust
  // the folder as it starts) glows, through classes React Flow puts on it (GraphEditor.css).
  // Screen readers hear an agent's type with its label.
  const nodes = useMemo(() => {
    const colors = groupColors(graph.nodes);
    return graph.nodes.map((n) => {
      const color = colors.get(n.id);
      const status = sessions[n.id]?.status ?? 'idle';
      // Waiting on a permission answer is asking too, as is what its CLI asks in its terminal.
      const asking =
        status === 'waiting' ||
        (sessions[n.id]?.asking?.length ?? 0) > 0 ||
        (run.running && run.agents[n.id]?.status === 'asking') ||
        (n.data.questions?.some((q) => q.answer === undefined) ?? false);
      const classes = [
        ...(color === undefined ? [] : [`group-color-${String(color)}`]),
        ...(asking ? ['asking'] : []),
        ...(status === 'idle' ? [] : ['working']),
      ];
      const name = n.data.label || 'Unnamed agent';
      const type = agentLabel(n.data.agent ?? DEFAULT_AGENT, connectionOf(n.data), { short: true });
      return {
        ...n,
        ...(classes.length === 0 ? {} : { className: classes.join(' ') }),
        ...(n.type === 'agent' ? { ariaLabel: `${name}, ${type}` } : {}),
      };
    });
  }, [graph.nodes, sessions, run]);
  /** What Terminal agents' CLIs ask in their terminals: listed, answered there. */
  const inTerminal = graph.nodes.flatMap((agent) => {
    const connection = connectionOf(agent.data);
    return agent.type === 'agent' &&
      connection !== 'simulated' &&
      TERMINAL_CONNECTIONS.includes(connection)
      ? (sessions[agent.id]?.asking ?? []).map((ask) => ({ agent, ask }))
      : [];
  });
  /** The questions agents wait on: asked on the canvas, and asked in their sessions. */
  const pending: { agent: GraphNode; question: CardQuestion; asked?: AskedInSession }[] = [
    ...pendingQuestions(graph.nodes),
    ...graph.nodes.flatMap((agent) =>
      pendingSessionQuestions(sessions[agent.id] ?? NEW_SESSION).map((asked) => ({
        agent,
        question: asked.question,
        asked,
      })),
    ),
  ];

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
  const openedNode = graph.nodes.find((n) => n.id === front);
  /** The other agents opened from the agent view's rail, as its stack shows them. */
  const stack = openedIds.slice(1).flatMap((id) => {
    const n = graph.nodes.find((other) => other.id === id);
    return n
      ? [
          {
            id,
            name: n.data.label || 'Unnamed agent',
            agent: n.data.agent ?? DEFAULT_AGENT,
            status: sessions[id]?.status ?? 'idle',
          },
        ]
      : [];
  });
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
                if (!arranging) setRawGraph(arrange);
                setArranging(!arranging);
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
          {(pending.length > 0 || asks.length > 0 || inTerminal.length > 0) && (
            <Panel position="top-right">
              <QuestionsSidebar
                asks={asks}
                onDecide={edits.decide}
                pending={pending.map(({ agent, question }) => ({
                  agentId: agent.id,
                  agentName: agent.data.label || 'Unnamed agent',
                  agentType: agent.data.agent ?? DEFAULT_AGENT,
                  question,
                }))}
                inTerminal={inTerminal.map(({ agent, ask }) => ({
                  agentId: agent.id,
                  agentName: agent.data.label || 'Unnamed agent',
                  agentType: agent.data.agent ?? DEFAULT_AGENT,
                  ask,
                }))}
                onAnswer={(agentId, questionId, answer) => {
                  const asked = pending.find(
                    (p) => p.agent.id === agentId && p.question.id === questionId,
                  );
                  if (asked?.asked) {
                    sessionStore.answerQuestion(
                      agentId,
                      asked.asked.prompt,
                      asked.asked.index,
                      answer,
                    );
                  } else {
                    setGraph((g) => answerQuestion(g, agentId, questionId, answer));
                  }
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
            nodes={graph.nodes}
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
            onSettings={(cli, settings) => {
              setRawGraph((g) => setSettings(g, openedNode.id, cli, settings));
            }}
            onContinueInTerminal={(command) => {
              // Its terminal resumes the conversation (the connections share it), and runs the
              // command typed for it once the agent runs there.
              if (command !== undefined) {
                sessionStore.sendOnceIn(
                  openedNode.id,
                  'terminal',
                  openedNode.data.agent ?? DEFAULT_AGENT,
                  command,
                );
              }
              setGraph((g) => setConnection(g, openedNode.id, 'terminal'));
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
            edits={edits}
            marks={marks}
            ask={asks.find((ask) => ask.agent.id === openedNode.id)}
            onShowQueues={() => {
              setQueues({ from: openedNode.id });
            }}
            session={sessions[openedNode.id] ?? NEW_SESSION}
            controls={{
              open: () => {
                sessionStore.open(openedNode.id);
              },
              send: (text, images) => {
                sessionStore.send(
                  openedNode.id,
                  openedNode.data.agent ?? DEFAULT_AGENT,
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
                updateSettings(openedNode.id, (settings) => {
                  const next = { ...settings };
                  delete next.mode;
                  return UNASKING_MODES.includes(mode) ? next : { ...next, mode };
                });
              },
              setModel: (model) => {
                sessionStore.setModel(openedNode.id, model);
                updateSettings(openedNode.id, (settings) => ({ ...settings, model }));
              },
              setEffort: (effort) => {
                sessionStore.setEffort(openedNode.id, effort);
                updateSettings(openedNode.id, (settings) => {
                  const next = { ...settings };
                  delete next.effort;
                  return effort === null ? next : { ...next, effort };
                });
              },
              settingsOptions: (cli) => sessionStore.settingsOptions(cli),
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
            nodes={graph.nodes}
            edits={edits}
            marks={marks}
            onClose={closeWork}
          />
        )}
        {queues && (
          <QueuesView
            nodes={graph.nodes}
            sessions={sessions}
            run={run}
            edits={edits}
            gauges={gauges}
            onRun={() => {
              runStore.start();
            }}
            onStop={() => {
              runStore.stop();
            }}
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
            examples={EXAMPLES}
            canInsert={graph.nodes.length > 0}
            installed={installed}
            onPick={(example, choices, use) => {
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
