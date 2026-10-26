import {
  Background,
  ConnectionMode,
  MarkerType,
  NodeToolbar,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  useViewport,
} from '@xyflow/react';
import type { Connection, Edge, EdgeTypes, NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentProps, MouseEvent as ReactMouseEvent, SyntheticEvent } from 'react';

import { absolutePosition, groupColors } from '../../shared/model/geometry';
import { nodeView } from './flow';
import { CanvasSource } from './source';
import {
  released,
  projectSelection,
  EMPTY_SELECTION,
  selectOnly as onlySelection,
} from './selection';
import type { Selection } from './selection';
import { projectOverlay } from './overlay';
import type { Overlays } from './overlay';
import { api as windowApi } from '../api/client';
import { topics as windowTopics, useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import type { GuiApi } from '../../shared/gui-link';
import * as Structure from '../../shared/model/structure';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, CanvasDocument } from '../../shared/model/canvas';
import type { InstalledClis } from '../../shared/session';
import { NO_USAGE } from '../../shared/usage';
import { AgentView } from '../agent/AgentView';
import { AgentSettingsPanel } from '../agent/AgentSettings';
import { catalog, continuesIn } from '../catalog';
import { ipcErrorMessage } from '../ipc-error';
import { draftCall, flushDrafts } from '../useDraft';
import { QueuesView } from '../queues/QueuesView';
import { lanesOf } from '../queues/lanes';
import { queueMarks } from '../../shared/model/queue-marks';
import { messageQueues } from '../queues/messages';
import { useRunView, useSessionSummaries } from '../api/runtime';
import {
  useDisplayedSession,
  sessionDisplay,
  sessionCommands,
  nativeQueries,
  nativePresentation,
  openViewedSession,
} from '../run/sessions';
import type { SessionQueries } from '../run/sessions';
import { runCommands } from '../run/commands';
import type { RunNotice, RunView, RunSnapshot } from '../../shared/model/views';
import { NEW_SESSION } from '../../shared/model/session';
import { heldAsks } from '../../shared/engine/run/asks';
import {
  groupControlText,
  groupPaused,
  individualPaused,
  queueControlText,
} from '../../shared/engine/run/controls';
import { UsageStore } from '../usage/store';
import type { UsageSource } from '../usage/store';
import { UsageGauges } from '../usage/UsageGauge';
import { backendsOf } from '../usage/usage';
import { NO_TERMINAL } from '../terminal/backend';
import type { TerminalBackend } from '../terminal/backend';
import { GraphActionsContext } from './actions';
import { agentLabel, connectionOf, DEFAULT_AGENT, runCatalog } from './agents';
import type { GraphActions } from './actions';
import { areLinked, groupMembers as groupAgentIds, isGroup } from '../../shared/model/queries';
import type { Graph } from './flow';
import { ExampleGallery } from './ExampleGallery';
import type { TemplateChoices } from './ExampleGallery';
import type { TemplateInfo } from '../../shared/templates';
import { StartSession } from './StartSession';
import { CanvasMenu } from './CanvasMenu';
import { RunFloat, ZoomFloat } from './Floats';
import { Dock } from './Dock';
import { agentCard } from '../../shared/model/run-display';
import './Floats.css';
import { fileAction, keyAction, SHORTCUTS } from './keys';
import type { KeyAction } from './keys';
import { ConnectMenu } from './ConnectMenu';
import type { MenuPlace } from './ConnectMenu';
import { AgentNodeView, GroupNodeView, LinkView, WorkEdgeView } from './nodes';
import { AgentContextMenu } from './AgentContextMenu';
import type { WorkFlowEdge } from './nodes';
import { NeedsSidebar } from './NeedsSidebar';
import { Canvases } from './Canvases';
import { WorkspaceProvider } from '../workspaces/Workspace';
import { workEdges } from '../../shared/model/work';
import { WorkDetail } from './WorkDetail';
import { operationEdits } from './edits';
import './GraphEditor.css';

const EMPTY_RUN: RunView = { running: false, agents: {}, groups: {}, notices: [] };
/** What a view dismisses a core notice by: its canvas, its place in the run's list and its words. */
const noticeKey = (canvas: CanvasId, one: RunNotice) => `${canvas}/${one.id}/${one.text}`;

const nodeTypes = { agent: AgentNodeView, frame: GroupNodeView } satisfies NodeTypes;
const edgeTypes = { default: LinkView, work: WorkEdgeView } satisfies EdgeTypes;
/** Middle and right mouse buttons pan; the left button draws the selection box. */
const PAN_BUTTONS = [1, 2];
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];

type Command = Exclude<KeyAction, 'rename'>;

/**
 * The editor, with a file bar backed by core operations and (given
 * `sessionQueries`, and `terminalBackend` for their terminals) agents connected to the real CLI
 * through the main process, and (given `usageSource`) the usage readings and rules main keeps.
 */
export function GraphEditor({
  canvas,
  client = windowApi,
  mirror = windowTopics,
  initialSelection = EMPTY_SELECTION,
  files = true,
  terminalBackend = NO_TERMINAL,
  sessionQueries = nativeQueries,
  usageSource,
}: {
  canvas?: CanvasId;
  client?: GuiApi;
  mirror?: TopicMirror;
  initialSelection?: Selection;
  files?: boolean;
  terminalBackend?: TerminalBackend;
  sessionQueries?: SessionQueries;
  usageSource?: UsageSource;
}) {
  const [shown, setShown] = useState<CanvasId>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (canvas !== undefined) return;
    let live = true;
    void client.windowGet().then(
      ({ canvas }) => {
        if (live) setShown(canvas as CanvasId);
      },
      (error: unknown) => {
        if (live) setFailure(ipcErrorMessage(error));
      },
    );
    return () => {
      live = false;
    };
  }, [canvas, client]);
  const visible = canvas ?? shown;
  if (visible === undefined)
    return (
      <div className="graph-editor" aria-busy={!failure}>
        {failure && <p role="alert">{failure}</p>}
      </div>
    );
  return (
    <ReactFlowProvider>
      <Editor
        canvas={visible}
        client={client}
        mirror={mirror}
        initialSelection={initialSelection}
        files={files}
        terminalBackend={terminalBackend}
        sessionQueries={sessionQueries}
        usageSource={usageSource}
      />
    </ReactFlowProvider>
  );
}

function Editor({
  canvas,
  client: api,
  mirror,
  initialSelection,
  files,
  terminalBackend,
  sessionQueries,
  usageSource,
}: {
  canvas: CanvasId;
  client: GuiApi;
  mirror: TopicMirror;
  initialSelection: Selection;
  files: boolean;
  terminalBackend: TerminalBackend;
  sessionQueries: SessionQueries;
  usageSource: UsageSource | undefined;
}) {
  const [binding] = useState(() => new CanvasSource(canvas, mirror));
  const canonical = useSyncExternalStore(binding.subscribe, binding.read);
  const canvasId = binding.canvas;
  const [selection, setSelection] = useState(initialSelection);
  const [overlays, setOverlays] = useState<Overlays>(new Map());
  const empty = useMemo(
    () => ({ id: canvasId, arrange: false, nodes: [], links: [] }) satisfies CanvasDocument,
    [canvasId],
  );
  const [notice, setNotice] = useState<readonly string[]>();
  /**
   * The core's opening notices (a restored or emptied database, a missing file) this view has
   * dismissed (`noticeKey`). The core keeps them in the run; dismissing only stops this view
   * showing them, so it sends nothing.
   */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  /** Why the last open or save failed. */
  const [problem, setProblem] = useState<string>();
  /** Fit each new binding once, including startup; reconnect preserves the same viewport. */
  const fittedCanvas = useRef<CanvasId | undefined>(undefined);
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
  const ready = useSyncExternalStore(binding.subscribe, binding.available);
  const bindingError = useSyncExternalStore(binding.subscribe, binding.failure);
  const [changingView, setChangingView] = useState(false);
  const restoring = !ready || changingView;
  const switching = useRef(false);
  const run: RunSnapshot & Pick<RunView, 'groups' | 'notices' | 'saveError'> =
    useRunView(canvasId, mirror) ?? EMPTY_RUN;
  /** What the core said on opening this canvas that this view has not dismissed. */
  const opening = run.notices.filter((one) => !dismissed.has(noticeKey(canvasId, one)));
  /** What the file float says: why the last open or save failed, and what opening said. */
  const said = [
    ...(problem === undefined ? [] : [problem]),
    ...opening.map((one) => one.text),
  ].join(' ');
  const summaries = useSessionSummaries(canvasId, mirror);
  const sessions = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(summaries ?? {}).map(([id, summary]) => [id, sessionDisplay(summary)]),
      ),
    [summaries],
  );
  const messages = useTopic(`messages:${canvasId}`, mirror);
  const controls = useMemo(
    () => runCommands(api, () => binding.canvas, mirror),
    [api, binding, mirror],
  );
  const [engineCatalog] = useState(runCatalog);
  const report = useCallback((error: unknown) => {
    setProblem(ipcErrorMessage(error));
  }, []);
  const act = useCallback(
    (action: Promise<unknown>) => {
      void action.catch(report);
    },
    [report],
  );
  const openSession = useCallback(
    (agent: string) => {
      openViewedSession(api, canvasId, agent, report);
    },
    [api, canvasId, report],
  );
  const model = canonical?.document ?? empty;
  const graph: Graph = useMemo(() => canonical?.graph ?? { nodes: [], edges: [] }, [canonical]);
  const name = canonical?.meta.name ?? undefined;
  const project = canonical?.meta.project ?? null;
  const runNodes = model.nodes;
  const coreNeeds = useTopic(`needs:${canvasId}`, mirror);
  const [requestedNeed, setRequestedNeed] = useState<{ id: string }>();
  const dockNeeds = useMemo(
    () => new Set((coreNeeds?.items ?? []).flatMap((need) => (need.agent ? [need.agent] : []))),
    [coreNeeds],
  );
  const asks = useMemo(
    () => heldAsks(runNodes, run, engineCatalog),
    [runNodes, run, engineCatalog],
  );
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
  /** Whether the templates gallery is open. */
  const [gallery, setGallery] = useState<boolean | TemplateInfo>(false);
  const [startChoice, setStartChoice] = useState<{ canvas: CanvasId; open: boolean }>();
  const showStart =
    canonical !== undefined &&
    (startChoice?.canvas === canvasId ? startChoice.open : files && model.nodes.length === 0);
  /** Which CLIs the user has, asked of main as the gallery opens: its agents' default connections. */
  const [installed, setInstalled] = useState<InstalledClis>();
  useEffect(() => {
    if (!gallery && !showStart) return;
    let open = true;
    sessionQueries.installed().then(
      (found) => {
        if (open) setInstalled(found);
      },
      () => undefined,
    );
    return () => {
      open = false;
    };
  }, [gallery, showStart, sessionQueries]);
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
    from?: { id: string; rect: DOMRect; duration?: number };
  }>({ ids: [] });
  /** Those still on the canvas (agents deleted meanwhile drop out), the one shown first. */
  const openedIds = useMemo(() => {
    const agents = new Set(graph.nodes.flatMap((n) => (n.type === 'agent' ? [n.id] : [])));
    return opened.ids.filter((id) => agents.has(id));
  }, [opened.ids, graph.nodes]);
  /** The agent shown in the agent view, if any. */
  const front = openedIds[0];
  /** How it runs: its session starts when its view opens, and again when that changes. */
  const presentation = useMemo(
    () => sessionQueries.presentation ?? nativePresentation(canvasId),
    [sessionQueries, canvasId],
  );
  const frontSession = useDisplayedSession(
    canvasId,
    front,
    mirror,
    summaries,
    messages,
    sessionQueries,
  );
  /** Pure display reconciliation with the foreground's authoritative native receipts. */
  const displayNodes = useMemo(
    () =>
      messageQueues(
        model.nodes,
        messages,
        front === undefined
          ? undefined
          : {
              agent: front,
              submissions: frontSession.submissions ?? [],
            },
      ),
    [model.nodes, messages, front, frontSession.submissions],
  );
  const layout = useMemo(() => lanesOf(displayNodes), [displayNodes]);
  const marks = useMemo(
    () =>
      queueMarks(
        layout,
        run,
        new Set(
          Object.entries(sessions).flatMap(([id, session]) =>
            session.status === 'waiting' ? [id] : [],
          ),
        ),
        engineCatalog,
      ),
    [layout, run, sessions, engineCatalog],
  );
  const frontControls = useMemo(
    () =>
      front === undefined
        ? undefined
        : sessionCommands(api, canvasId, front, mirror, report, sessionQueries),
    [api, canvasId, front, mirror, report, sessionQueries],
  );
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
  const { screenToFlowPosition, fitView, zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();
  const wrapper = useRef<HTMLDivElement>(null);
  /** Whether a panel, menu or question is open, which has the keyboard (Escape closes it). */
  const modal =
    showStart ||
    front !== undefined ||
    work !== undefined ||
    drawn !== undefined ||
    agentMenu !== undefined ||
    settingsAgent !== undefined ||
    gallery ||
    queues !== undefined;
  // The keyboard handler and file commands read these without re-subscribing on every change.
  const latest = useRef({ graph, modal, start: showStart });
  useEffect(() => {
    latest.current = { graph, modal, start: showStart };
  });
  const perform = useCallback(<T,>(pending: Promise<T>, done?: (value: T) => void) => {
    void pending.then(done, (error: unknown) => {
      setProblem(ipcErrorMessage(error));
    });
  }, []);
  const selectOne = useCallback(
    (id: string) => {
      setSelection((current) => onlySelection(current, id));
      store.setState({ nodesSelectionActive: false });
    },
    [store],
  );
  const clearSelection = useCallback(() => {
    setSelection(EMPTY_SELECTION);
    store.setState({ nodesSelectionActive: false });
  }, [store]);
  const removed = useCallback((cleared: readonly string[]) => {
    setNotice(cleared.length > 0 ? cleared : undefined);
  }, []);
  const execute = useCallback(
    (command: Command) => {
      const selected = [...selection.nodes].filter((id) =>
        latest.current.graph.nodes.some((node) => node.id === id),
      );
      if (command === 'delete') {
        const links = latest.current.graph.edges
          .filter((edge) => selection.edges.has(edge.id))
          .map((edge) => ({ a: edge.source, b: edge.target }));
        if (selected.length === 0 && links.length === 0) return;
        perform(api.canvasDelete({ canvas: canvasId, nodes: selected, links }), (result) => {
          if ('cleared' in result) removed(result.cleared);
          clearSelection();
        });
      } else if (command === 'ungroup') {
        const after = released(model.nodes, selected);
        perform(api.canvasUngroup({ canvas: canvasId, nodes: selected }), () => {
          setSelection(after);
        });
      } else {
        perform(
          api.canvasGroup({
            canvas: canvasId,
            nodes: selected,
            kind: command === 'group' ? 'frame' : 'agent',
          }),
          (result) => {
            if ('id' in result) selectOne(result.id);
          },
        );
      }
    },
    [api, canvasId, selection, perform, selectOne, clearSelection, removed, model.nodes],
  );
  const moveNodes = (moves: readonly { node: string; position: { x: number; y: number } }[]) => {
    perform(
      api.canvasMove({ canvas: canvasId, moves: [...moves] }).finally(() => {
        setOverlays((current) => {
          const next = new Map(current);
          for (const { node: id } of moves) {
            const measured = next.get(id)?.measured;
            if (measured) next.set(id, { measured });
            else next.delete(id);
          }
          return next;
        });
      }),
    );
  };

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

  const changeAgent = (id: string, adapter: string, connection: string) => {
    const node = binding.required().document.nodes.find((n) => n.id === id);
    return draftCall(() =>
      node?.type === 'agent' && (node.data.adapter ?? DEFAULT_AGENT) === adapter
        ? api.agentSetConnection({ canvas: binding.canvas, agent: id, connection })
        : api.agentSetType({ canvas: binding.canvas, agent: id, adapter, connection }),
    );
  };

  const actions = useMemo<GraphActions>(
    () => ({
      card: (id) => agentCard(id, model.nodes, sessions, run, dockNeeds, engineCatalog),
      queueState: (id) => queueControlText(run, id),
      groupState: (id) => groupControlText(model.nodes, run, id),
      editing,
      startEditing: setEditing,
      stopEditing: () => {
        setEditing(undefined);
      },
      rename: (node, label) =>
        api.canvasRename({ canvas: canvasId, node, label }).catch((error: unknown) => {
          setProblem(ipcErrorMessage(error));
          throw error;
        }),
      remove: (node) => {
        perform(api.canvasDelete({ canvas: canvasId, nodes: [node] }), (result) => {
          if ('cleared' in result) removed(result.cleared);
        });
      },
      ungroup: (node) => {
        const after = released(model.nodes, [node]);
        perform(api.canvasUngroup({ canvas: canvasId, nodes: [node] }), () => {
          setSelection(after);
        });
      },
      addParent: (node) => {
        perform(api.canvasAddParent({ canvas: canvasId, frame: node }), (result) => {
          if ('id' in result) selectOne(result.id);
        });
      },
      removeEdge: (id) => {
        const edge = latest.current.graph.edges.find((edge) => edge.id === id);
        if (edge) perform(api.canvasUnlink({ canvas: canvasId, a: edge.source, b: edge.target }));
      },
      openWork: (from, to) => {
        setWork({ from, to });
      },
    }),
    [
      api,
      canvasId,
      editing,
      model.nodes,
      perform,
      removed,
      run,
      selectOne,
      sessions,
      dockNeeds,
      engineCatalog,
    ],
  );

  const edits = useMemo(
    () =>
      operationEdits(api, canvasId, controls, (error) => {
        setProblem(ipcErrorMessage(error));
      }),
    [api, canvasId, controls],
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
    if (!ready || fittedCanvas.current === canvasId) return;
    fittedCanvas.current = canvasId;
    // Mark an empty binding too: its first newly added node must stay at the pointer.
    if (model.nodes.length > 0) void fitView({ padding: 0.2, maxZoom: 1 });
  }, [ready, canvasId, model.nodes.length, fitView]);
  /** The template's inserted roots: the view moves to show them together. */
  const [inserted, setInserted] = useState<readonly string[]>();
  useEffect(() => {
    if (inserted !== undefined)
      void fitView({ nodes: inserted.map((id) => ({ id })), padding: 0.3, maxZoom: 1 });
  }, [inserted, fitView]);

  /** Reset only view state, subscribe to the switched canvas and fit its first snapshot. */
  const load = useCallback(
    async (id: CanvasId) => {
      binding.bind(id);
      clearSelection();
      setOverlays(new Map());

      setEditing(undefined);
      setOpened({ ids: [] });
      // All queues and inserted roots name the old canvas's agents and groups.
      setQueues(undefined);
      setInserted(undefined);
      setSettingsAgent(undefined);
      setWork(undefined);
      setDrawn(undefined);
      setAgentMenu(undefined);
      setProblem(undefined);
      setNotice(undefined);
      await binding.ready();
    },
    [binding, clearSelection],
  );
  const commands = useMemo(() => {
    const failed = (doing: string) => (error: unknown) => {
      setProblem(`Could not ${doing}: ${ipcErrorMessage(error)}`);
    };
    /**
     * A switch (B9 Design §9: New, Open, a template's New): one op, after which the window shows
     * the canvas it names. The canvas before stays open in the core, its changes with it, so
     * nothing asks to discard them; the window says so when it had any.
     */
    const switchTo = async (action: () => Promise<CanvasId | null>, keepsBefore = true) => {
      if (switching.current) return;
      switching.current = true;
      setChangingView(true);
      try {
        await flushDrafts();
        // Read, not required: a canvas that could not be restored can still be switched from.
        const before = binding.read();
        // A view switch never pauses or saves a runtime; the old canvas keeps running.
        const target = async () => {
          const id = await action();
          return id === binding.canvas ? null : id;
        };
        const id = await target();
        if (id !== null) await load(id);
        if (keepsBefore && before && before.document.id !== binding.canvas && before.meta.edited)
          setNotice([
            `${before.meta.name ?? 'The previous canvas'} stays open with its changes. Find it in Canvases.`,
          ]);
      } catch (error) {
        setProblem(`Could not switch canvases: ${ipcErrorMessage(error)}`);
        throw error;
      } finally {
        // Cancelled, refused and same-canvas switches leave the binding and runtime intact.
        switching.current = false;
        setChangingView(false);
      }
    };
    return {
      show: (canvas: CanvasId) =>
        switchTo(async () => {
          await api.windowShow({ canvas });
          return canvas;
        }),
      close: (canvas: CanvasId, discard: boolean) =>
        switchTo(async () => {
          const result = await api.canvasClose({ canvas, ...(discard ? { discard: true } : {}) });
          return 'canvas' in result && result.canvas ? (result.canvas as CanvasId) : null;
        }, false),
      reply: async (to: string, answer: Parameters<GuiApi['reply']>[0]['answer']) => {
        const canvas = binding.canvas;
        // Only Allow of a proposal can move the window. A stalled CLI's interrupt may never
        // resolve: keep other agents' input and checkpoint writes usable while it is pending.
        if (!to.startsWith('proposal/') || !('choice' in answer && answer.choice === 'allow')) {
          await flushDrafts();
          return api.reply({ canvas, to, answer });
        }
        let result: Awaited<ReturnType<GuiApi['reply']>> | undefined;
        await switchTo(async () => {
          result = await api.reply({ canvas, to, answer });
          return result.canvas ? (result.canvas as CanvasId) : null;
        }, false);
        if (!result) throw new Error('A canvas switch is already under way.');
        if (result.canvas && result.outcome) setNotice([`Proposal ${result.outcome}.`]);
        return result;
      },
      new: () => {
        void switchTo(async () => {
          const result = await api.canvasCreate({});
          return 'canvas' in result ? (result.canvas as CanvasId) : null;
        }).catch(failed('start a new canvas'));
      },
      open: () => {
        void switchTo(async () => {
          const result = await api.canvasOpen({});
          return result.canvas as CanvasId | null;
        }).catch(failed('open the canvas'));
      },
      example: (template: string, choices: TemplateChoices) => {
        void switchTo(async () => {
          const result = await api.canvasCreate({
            template,
            values: choices.values,
            agents: Object.fromEntries(
              Object.entries(choices.agents).flatMap(([key, value]) =>
                value === undefined ? [] : [[key, value]],
              ),
            ),
            connections: choices.connections,
          });
          return 'canvas' in result ? (result.canvas as CanvasId) : null;
        }).catch(failed('open the template'));
      },
      chooseProject: () => {
        void flushDrafts(async () => {
          await api.projectChoose({ canvas: binding.canvas });
        }).catch(failed('choose the project folder'));
      },
      save: (choose: boolean) => {
        void flushDrafts(async () => {
          if (choose || binding.required().meta.name === null)
            await api.canvasSaveAs({ canvas: binding.canvas });
          else await api.canvasSave({ canvas: binding.canvas });
        }).catch(failed('save the canvas'));
      },
    };
  }, [load, api, binding]);
  useEffect(() => {
    if (files)
      document.title = `${name ?? 'Untitled'}${canonical?.meta.edited ? ' (edited)' : ''} — corrallm`;
  }, [files, name, canonical?.meta.edited]);
  const cancelDrawn = useCallback(() => {
    setDrawn(undefined);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (switching.current) return;
      const file = files ? fileAction(event) : null;
      // New/Open own a switch barrier, which waits for the initial restore and saves it.
      // Remember that intent even while startup is inert; session input must still wait.
      if (restoring && file !== 'new' && file !== 'open') return;
      if (files && file) {
        event.preventDefault();
        void flushDrafts(() => {
          if (file === 'save' || file === 'saveAs') {
            commands.save(file === 'saveAs');
          } else if (!latest.current.modal || latest.current.start) {
            if (file === 'new') commands.new();
            else commands.open();
          }
        }).catch((error: unknown) => {
          setProblem(ipcErrorMessage(error));
        });
        return;
      }
      if (latest.current.modal) return;
      const action = keyAction(event);
      if (action === null) return;
      event.preventDefault();
      void flushDrafts(() => {
        if (action !== 'rename') {
          execute(action);
          return;
        }
        const [only, ...others] = latest.current.graph.nodes.filter((n) =>
          selection.nodes.has(n.id),
        );
        if (only && others.length === 0) setEditing(only.id);
      }).catch((error: unknown) => {
        setProblem(ipcErrorMessage(error));
      });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [execute, commands, files, restoring, selection]);

  /** Adds a node where the pointer is: into the innermost group there, if any. */
  const addAtPointer = (event: ReactMouseEvent) => {
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    perform(api.canvasAddAgent({ canvas: canvasId, adapter: DEFAULT_AGENT, at }), (result) => {
      if ('id' in result) selectOne(result.id);
    });
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
    const colors = groupColors(graph.nodes);
    const dataById = new Map<string, AgentData>(displayNodes.map((node) => [node.id, node.data]));
    return projectOverlay(projectSelection(graph, selection), overlays).nodes.map((n) => {
      const color = colors.get(n.id);
      const status = sessions[n.id]?.status ?? 'idle';
      // Waiting on a permission answer is asking too, as is what its CLI asks in its terminal.
      const asking =
        dockNeeds.has(n.id) ||
        status === 'waiting' ||
        (sessions[n.id]?.asking?.length ?? 0) > 0 ||
        (run.running && run.agents[n.id]?.status === 'asking');
      const classes = [
        ...(color === undefined ? [] : [`group-color-${String(color)}`]),
        ...(asking ? ['asking'] : []),
        ...(status === 'idle' ? [] : ['working']),
      ];
      const data = dataById.get(n.id) ?? n.data;
      const name = data.label || 'Unnamed agent';
      const type = agentLabel(data.adapter ?? DEFAULT_AGENT, connectionOf(data), {
        short: true,
      });
      return nodeView(
        n,
        classes.join(' '),
        n.type === 'agent' ? `${name}, ${type}` : undefined,
        data,
      );
    });
  }, [displayNodes, graph, selection, overlays, sessions, run, dockNeeds]);

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
        selected: selection.edges.has(e.id),
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
  }, [graph.nodes, graph.edges, selection.edges]);

  const selectedIds = [...selection.nodes].filter((id) =>
    graph.nodes.some((node) => node.id === id),
  );
  const nameOf = (id: string) =>
    (graph.nodes.find((n) => n.id === id)?.data.label ?? '') || 'Unnamed agent';
  const openedNode = displayNodes.filter((n) => n.type === 'agent').find((n) => n.id === front);
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
  const canGroup = Structure.groupMembers(model.nodes, [...selection.nodes]).length > 0;

  const blockSwitchInput = (event: SyntheticEvent) => {
    if (switching.current || !ready) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  if (bindingError)
    return (
      <div className="graph-editor">
        <p role="alert">{bindingError} The core keeps the canvas’s work.</p>
        {files && (
          <div role="toolbar" aria-label="Canvas recovery">
            <button type="button" onClick={commands.new}>
              New
            </button>
            <button type="button" onClick={commands.open}>
              Open…
            </button>
          </div>
        )}
      </div>
    );

  const settingsNode = model.nodes.find(
    (node) => node.id === settingsAgent && node.type === 'agent',
  );
  const menuNode = agentMenu && graph.nodes.find((node) => node.id === agentMenu.id);
  const menuIsGroup = menuNode && isGroup(graph.nodes, menuNode.id);
  const menuMembers = menuIsGroup ? groupAgentIds(graph.nodes, menuNode.id) : [];
  const pauseMenuGroup = () => {
    if (menuNode) act(controls.pauseGroup(menuNode.id));
  };
  const killMenuGroup = () => {
    if (!menuNode) return;
    act(controls.killGroup(menuNode.id));
  };
  const resumeMenuGroup = () => {
    if (menuNode) act(controls.resumeGroup(menuNode.id));
  };

  return (
    <GraphContext
      actions={actions}
      canvas={canvasId}
      mirror={mirror}
      client={api}
      nodes={model.nodes}
      onNeed={(id) => {
        setSettingsAgent(undefined);
        setRequestedNeed({ id });
      }}
    >
      <div
        className="graph-editor"
        data-window-open={front !== undefined || queues !== undefined ? '' : undefined}
        data-agent-open={front !== undefined ? '' : undefined}
        data-canvas-view={queues ? 'queues' : 'graph'}
        data-start-open={showStart ? '' : undefined}
        ref={wrapper}
        inert={restoring}
        aria-busy={restoring}
        onClickCapture={blockSwitchInput}
        onDoubleClickCapture={blockSwitchInput}
        onPointerDownCapture={blockSwitchInput}
        onKeyDownCapture={(event) => {
          blockSwitchInput(event);
          if (event.isPropagationStopped()) return;
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
        {run.saveError && (
          <p role="alert" className="graph-panel">
            {run.saveError}
          </p>
        )}
        {notice && (
          <div role="status" className="graph-panel graph-canvas-notice">
            <ul>
              {notice.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
            <button
              type="button"
              aria-label="Dismiss cleared references"
              onClick={() => {
                setNotice(undefined);
              }}
            >
              ×
            </button>
          </div>
        )}
        {!files && said !== '' && (
          <p role="alert" className="graph-panel">
            {said}
          </p>
        )}
        <ReactFlow
          inert={showStart || front !== undefined || queues !== undefined}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={!arranging}
          edgeTypes={edgeTypes}
          onSelectionStart={() => {
            // The pane resets controlled selection before computing its first rectangle, but
            // leaves its internal selected flags set. Clear those too, so a previously selected
            // node inside the rectangle is included in the new selection changes.
            const flow = store.getState();
            flow.unselectNodesAndEdges({ nodes: [...flow.nodeLookup.values()] });
          }}
          onNodesChange={(changes) => {
            setSelection((current) => {
              const nodes = new Set(current.nodes);
              for (const change of changes)
                if (change.type === 'select') {
                  if (change.selected) nodes.add(change.id);
                  else nodes.delete(change.id);
                }
              return { ...current, nodes };
            });
            // React Flow places a moved node in its parent as it holds that parent now; the
            // overlay keeps it there in canvas coordinates, whatever the commit does to the parent.
            const { nodeLookup } = store.getState();
            const placed = new Map(
              changes.flatMap((change) => {
                if (change.type !== 'position' || !change.position) return [];
                const parent = nodeLookup.get(change.id)?.parentId;
                const origin =
                  parent === undefined
                    ? undefined
                    : nodeLookup.get(parent)?.internals.positionAbsolute;
                return [
                  [
                    change.id,
                    {
                      x: (origin?.x ?? 0) + change.position.x,
                      y: (origin?.y ?? 0) + change.position.y,
                    },
                  ] as const,
                ];
              }),
            );
            setOverlays((current) => {
              const next = new Map(current);
              for (const change of changes) {
                const at = change.type === 'position' ? placed.get(change.id) : undefined;
                if (at && change.type === 'position')
                  next.set(change.id, {
                    ...next.get(change.id),
                    at,
                    dragging: change.dragging ?? false,
                  });
                if (change.type === 'dimensions' && change.dimensions)
                  next.set(change.id, { ...next.get(change.id), measured: change.dimensions });
              }
              return next;
            });
            const nudges = changes.flatMap((change) =>
              change.type === 'position' && change.position && change.dragging === undefined
                ? [{ node: change.id, position: change.position }]
                : [],
            );
            if (nudges.length > 0 && !arranging) moveNodes(nudges);
          }}
          onEdgesChange={(changes) => {
            setSelection((current) => {
              const edges = new Set(current.edges);
              for (const change of changes)
                if (change.type === 'select') {
                  if (change.selected) edges.add(change.id);
                  else edges.delete(change.id);
                }
              return { ...current, edges };
            });
          }}
          onNodeDragStop={(_event, node, dragged) => {
            const roots = new Set(
              Structure.roots(
                model.nodes,
                dragged.map((one) => one.id),
              ).map((one) => one.id),
            );
            const moved = dragged.length > 0 ? dragged.filter((one) => roots.has(one.id)) : [node];
            moveNodes(moved.map((one) => ({ node: one.id, position: one.position })));
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
          isValidConnection={(connection) => Structure.canLink(model, connection)}
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
            selectOne(node.id);
            // A node opens in a panel; a group, which has no queue, is renamed in place.
            if (node.type === 'frame') {
              setEditing(node.id);
            } else {
              setEditing(undefined);
              openSession(node.id);
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
                execute('group');
              }}
            >
              Group
            </button>
            <button
              type="button"
              title="Delete the selected agents (Delete). A deleted group's nodes are kept."
              onClick={() => {
                execute('delete');
              }}
            >
              Delete
            </button>
          </NodeToolbar>
          {files && graph.nodes.length === 0 && (
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
        <div
          className="canvas-floats"
          hidden={Boolean(gallery) || work !== undefined || settingsAgent !== undefined}
        >
          {files && (
            <CanvasMenu
              canvases={
                <Canvases
                  canvas={canvasId}
                  mirror={mirror}
                  client={api}
                  onShow={commands.show}
                  onClose={commands.close}
                />
              }
              name={name}
              edited={canonical?.meta.edited ?? false}
              {...(showStart
                ? {}
                : { project: { folder: project, onChoose: commands.chooseProject } })}
              problem={said === '' ? undefined : said}
              onNew={() => {
                commands.new();
              }}
              onOpen={() => {
                commands.open();
              }}
              onSave={() => {
                void flushDrafts(() => {
                  commands.save(false);
                }).catch((error: unknown) => {
                  setProblem(ipcErrorMessage(error));
                });
              }}
              onSaveAs={() => {
                void flushDrafts(() => {
                  commands.save(true);
                }).catch((error: unknown) => {
                  setProblem(ipcErrorMessage(error));
                });
              }}
              onExamples={() => {
                setStartChoice({ canvas: canvasId, open: false });
                setGallery(true);
              }}
              onDismiss={() => {
                setProblem(undefined);
                setDismissed(
                  (was) => new Set([...was, ...opening.map((one) => noticeKey(canvasId, one))]),
                );
              }}
            />
          )}
          <RunFloat
            run={run}
            working={
              Object.keys(run.agents).filter((id) => sessions[id]?.status === 'working').length
            }
            queuesOpen={queues !== undefined}
            onRun={() => {
              void flushDrafts(() => controls.start()).catch((error: unknown) => {
                setProblem(ipcErrorMessage(error));
              });
            }}
            onResume={() => {
              act(controls.resume());
            }}
            onStop={() => {
              act(controls.stop());
            }}
            gauges={gauges}
            needs={
              <NeedsSidebar
                key={canvasId}
                canvas={canvasId}
                mirror={mirror}
                request={requestedNeed}
                presentation={presentation}
                onReply={commands.reply}
                nodes={model.nodes}
                onOpen={(agentId) => {
                  setStartChoice({ canvas: canvasId, open: false });
                  selectOne(agentId);
                  openSession(agentId);
                  setOpened({ ids: [agentId] });
                }}
              />
            }
          />
          {front === undefined && queues === undefined && (
            <ZoomFloat
              zoom={zoom}
              arranging={arranging}
              onIn={() => {
                void zoomIn();
              }}
              onOut={() => {
                void zoomOut();
              }}
              onFit={() => {
                void fitView({ padding: 0.2, maxZoom: 1 });
              }}
              onArrange={() => {
                perform(api.canvasSetArrange({ canvas: canvasId, on: !arranging }));
              }}
            />
          )}
          <Dock
            nodes={model.nodes}
            sessions={sessions}
            run={run}
            needs={dockNeeds}
            current={front}
            queues={queues !== undefined}
            onToggleQueues={() => {
              void flushDrafts(() => {
                setStartChoice({ canvas: canvasId, open: false });
                setQueues((current) => (current ? undefined : front ? { from: front } : {}));
              }).catch((error: unknown) => {
                setProblem(ipcErrorMessage(error));
              });
            }}
            onOpen={(id) => {
              void flushDrafts(() => {
                setStartChoice({ canvas: canvasId, open: false });
                setQueues(undefined);
                selectOne(id);
                openSession(id);
                setOpened(({ ids }) => ({ ids: [id, ...ids.filter((other) => other !== id)] }));
              }).catch((error: unknown) => {
                setProblem(ipcErrorMessage(error));
              });
            }}
            onStart={() => {
              setStartChoice({ canvas: canvasId, open: true });
            }}
          />
        </div>
        {openedNode && frontControls && !showStart && (
          <AgentView
            key={openedNode.id}
            opening={opened}
            node={openedNode}
            queueState={queueControlText(run, openedNode.id)}
            onAgentContextMenu={(event) => {
              showAgentMenu(event, openedNode.id);
            }}
            nodes={displayNodes}
            origin={openedCard}
            from={opened.from?.id === openedNode.id ? opened.from.rect : undefined}
            openingDuration={opened.from?.duration}
            stack={stack}
            onNewAgent={(relation, from) => {
              perform(
                api.canvasSpawnAgent({ canvas: canvasId, from: openedNode.id, relation }),
                (result) => {
                  if ('id' in result) {
                    selectOne(result.id);
                    setOpened(({ ids }) => ({
                      ids: [result.id, ...ids],
                      from: { id: result.id, rect: from },
                    }));
                  }
                },
              );
            }}
            onSwitch={(id, from) => {
              openSession(id);
              selectOne(id);
              setOpened(({ ids }) => ({
                ids: [id, ...ids.filter((other) => other !== id)],
                from: { id, rect: from },
              }));
            }}
            onRename={(label) => {
              perform(api.canvasRename({ canvas: canvasId, node: openedNode.id, label }));
            }}
            connection={connectionOf(openedNode.data)}
            project={project}
            terminal={terminalBackend}
            onAgent={(agent, connection) => {
              // The foreground session's connection chooser is a single composite. The settings
              // sheet still changes only the document; X13 takes over these session controls.
              perform(
                agent === (openedNode.data.adapter ?? DEFAULT_AGENT)
                  ? api.sessionContinueIn({ canvas: canvasId, agent: openedNode.id, connection })
                  : changeAgent(openedNode.id, agent, connection),
              );
            }}
            onOpenSettings={() => {
              setSettingsAgent(openedNode.id);
            }}
            onContinueInTerminal={(command) => {
              const connection = continuesIn(connectionOf(openedNode.data));
              if (connection !== undefined)
                act(
                  api.sessionContinueIn({
                    canvas: canvasId,
                    agent: openedNode.id,
                    connection,
                    ...(command === undefined ? {} : { then: { text: command } }),
                  }),
                );
            }}
            edits={edits}
            marks={marks}
            ask={asks.find((ask) => ask.agent.id === openedNode.id)}
            onShowQueues={() => {
              setQueues({ from: openedNode.id });
            }}
            session={frontSession}
            controls={frontControls}
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
              void flushDrafts(() => controls.start()).catch((error: unknown) => {
                setProblem(ipcErrorMessage(error));
              });
            }}
            onStop={() => {
              act(controls.stop());
            }}
            onResume={() => {
              act(controls.resume());
            }}
            onAgentContextMenu={showAgentMenu}
            onOpenSettings={setSettingsAgent}
            settingsOptions={(adapter, agent) => sessionQueries.options(adapter, agent)}
            {...(queues.from === undefined ? {} : { focus: queues.from })}
            backLabel={queues.from === undefined ? 'Canvas' : nameOf(queues.from)}
            onOpenAgent={(id) => {
              setQueues(undefined);
              selectOne(id);
              openSession(id);
              setOpened({ ids: [id] });
            }}
            onClose={closeQueues}
          />
        )}
        {showStart && !gallery && (
          <StartSession
            canvas={canvasId}
            mirror={mirror}
            project={project}
            installed={installed}
            onChooseProject={commands.chooseProject}
            onClose={() => {
              setStartChoice({ canvas: canvasId, open: false });
            }}
            onTemplate={(template) => {
              setStartChoice({ canvas: canvasId, open: false });
              setGallery(template);
            }}
            onShow={async (id) => {
              await commands.show(id);
              if (binding.canvas !== id) throw new Error('The recent canvas was not shown.');
              setStartChoice({ canvas: id, open: false });
            }}
            onStart={async (adapter, connection, from) => {
              await flushDrafts();
              const box = wrapper.current?.getBoundingClientRect();
              const at = box
                ? screenToFlowPosition({
                    x: box.left + box.width / 2,
                    y: box.top + box.height / 2,
                  })
                : { x: 0, y: 0 };
              const result = await api.canvasAddAgent({
                canvas: canvasId,
                at,
                adapter,
                connection,
              });
              if (binding.canvas !== canvasId || !('id' in result)) return;
              setStartChoice({ canvas: canvasId, open: false });
              selectOne(result.id);
              setOpened({ ids: [result.id], from: { id: result.id, rect: from, duration: 440 } });
            }}
          />
        )}
        {gallery && (
          <ExampleGallery
            canInsert={gallery === true && graph.nodes.length > 0}
            initialTemplate={typeof gallery === 'object' ? gallery : undefined}
            installed={installed}
            onPick={(template, choices, use) => {
              setGallery(false);
              if (use === 'new') {
                commands.example(template.id, choices);
                return;
              }
              perform(
                api.canvasInsertTemplate({
                  canvas: canvasId,
                  template: template.id,
                  values: choices.values,
                  agents: Object.fromEntries(
                    Object.entries(choices.agents).map(([key, value]) => [key, value ?? null]),
                  ),
                  connections: choices.connections,
                }),
                (result) => {
                  if ('roots' in result) {
                    setSelection({ nodes: new Set(result.roots), edges: new Set() });
                    store.setState({ nodesSelectionActive: false });
                    setInserted(result.roots);
                  }
                },
              );
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
              perform(
                api.canvasLink({
                  canvas: canvasId,
                  a: drawn.source,
                  b: drawn.target,
                  ...(drawn.sourceHandle && drawn.targetHandle
                    ? {
                        dots: [
                          drawn.sourceHandle as 'top' | 'bottom',
                          drawn.targetHandle as 'top' | 'bottom',
                        ],
                      }
                    : {}),
                }),
              );
              setDrawn(undefined);
            }}
            onWork={() => {
              if (!areLinked(graph.edges, drawn.source, drawn.target))
                perform(
                  api.canvasLink({
                    canvas: canvasId,
                    a: drawn.source,
                    b: drawn.target,
                    ...(drawn.sourceHandle && drawn.targetHandle
                      ? {
                          dots: [
                            drawn.sourceHandle as 'top' | 'bottom',
                            drawn.targetHandle as 'top' | 'bottom',
                          ],
                        }
                      : {}),
                  }),
                );
              setDrawn(undefined);
              setWork({ from: drawn.source, to: drawn.target });
            }}
            onCancel={cancelDrawn}
          />
        )}
        {settingsNode?.type === 'agent' && (
          <AgentSettingsPanel
            key={`settings:${settingsNode.id}`}
            inert={restoring}
            node={settingsNode}
            session={sessions[settingsNode.id] ?? NEW_SESSION}
            options={(adapter) => sessionQueries.options(adapter, settingsNode.id)}
            onRename={(name) => {
              perform(api.canvasRename({ canvas: canvasId, node: settingsNode.id, label: name }));
            }}
            onRole={(role) => {
              return draftCall(() =>
                api.agentSetRole({ canvas: canvasId, agent: settingsNode.id, role: role ?? '' }),
              );
            }}
            onAgent={(agent, connection) => {
              perform(changeAgent(settingsNode.id, agent, connection));
            }}
            onSettings={(adapter, settings) => {
              perform(
                api.agentSetSettings({
                  canvas: canvasId,
                  agent: settingsNode.id,
                  adapter,
                  settings: {
                    model: settings.model ?? null,
                    effort: settings.effort ?? null,
                    mode: settings.mode ?? null,
                  },
                }),
              );
            }}
            onRestart={() => {
              act(api.sessionRestart({ canvas: canvasId, agent: settingsNode.id }));
            }}
            onFresh={() => {
              act(api.sessionNewConversation({ canvas: canvasId, agent: settingsNode.id }));
            }}
            onClose={closeSettings}
          />
        )}
        {agentMenu && menuNode && (
          <AgentContextMenu
            key={agentMenu.id}
            inert={restoring}
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
            heldByGroups={Object.keys(run.groups)
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
              else act(controls.pauseAgent(menuNode.id));
            }}
            onKill={() => {
              if (menuNode.type === 'frame') killMenuGroup();
              else {
                act(controls.killAgent(menuNode.id));
              }
            }}
            onResume={() => {
              if (menuNode.type === 'frame') resumeMenuGroup();
              else act(controls.resumeAgent(menuNode.id));
            }}
            onClose={closeAgentMenu}
          />
        )}
      </div>
    </GraphContext>
  );
}

/** Keep the graph mounted across canvas switches; only per-canvas notification UI resets. */
function GraphContext({
  actions,
  ...workspace
}: ComponentProps<typeof WorkspaceProvider> & { actions: GraphActions }) {
  return (
    <GraphActionsContext value={actions}>
      <WorkspaceProvider {...workspace} />
    </GraphActionsContext>
  );
}
