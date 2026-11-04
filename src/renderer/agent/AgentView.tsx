import { agentEndpoint, endpointRefusal } from '../../shared/model/catalog';
import type { AgentData } from '../../shared/model/canvas';
import { connectionOf } from '../graph/agents';
import { agentAdapter } from '../graph/agents';
import type { ArgsOf } from '../../shared/api/registry';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLabel } from '../useDraft';

import type { AdapterId, ConnectionDescriptor, ConnectionId } from '../../shared/adapter';
import type { ProjectFolder } from '../../shared/canvas';
import type {
  McpChange,
  McpServer,
  PastSession,
  FilesRewind,
  RewindRestore,
  RewindResult,
  SettingsOptions,
} from '../../shared/session';
import { adapterAccent, adapterOf, isTerminal, catalog } from '../catalog';
import { connectionIn } from '../../shared/adapter';
import { actionsOf, adapterCli } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import { editsOf } from '../graph/edits';
import type { QueueEdits } from '../graph/edits';
import type { AgentNode, CanvasNode } from '../../shared/model/canvas';
import { chooseTarget, findItem, isApproval, isWait } from '../../shared/model/queue';
import type { WaitTarget } from '../../shared/model/queue';
import { QueueAddMenu, QueueEditor } from '../graph/QueueEditor';
import type { RowMarks, StepChoice } from '../graph/QueueEditor';
import type { HeldAsk } from '../../shared/model/run-words';
import type { TerminalBackend } from '../terminal/backend';
import { TerminalPane } from '../terminal/TerminalPane';
import {
  completedCommands,
  continuationOf,
  offerWords,
  panelOpens,
  panelWords,
  routeText,
} from './commands';
import type { ViewCommand } from './commands';
import type { Route } from '../../shared/routing';
import { routeRefusal } from '../../shared/routing';
import { imageRefusal } from '../../shared/images';
import { Composer } from './Composer';
import { isCommand } from './completion';
import { queueLinks } from './links';
import { McpPanel } from './McpPanel';
import { animate, morph, settle, slide } from './motion';
import { PeerQueue } from './PeerQueue';
import { QueueLinks } from './QueueLinks';
import { Rail } from './Rail';
import { ResumePicker } from './ResumePicker';
import { Rewind } from './Rewind';
import { ApiMark, HandoffTile } from './Fallback';
import { AgentChip } from './AgentChip';
import { WorkspaceBadge, WorkspaceWait } from '../workspaces/Workspace';
import { BranchControls } from '../workspaces/BranchReview';
import { AgentSettingsSummary } from './AgentSettings';
import type { Relation, StackedAgent } from './Rail';
import type { ComposerControls } from './Composer';
import { chatStart, rewindPoints, threadTitle } from '../../shared/model/session';
import type { MessageImage, Session } from '../../shared/model/session';
import { Transcript } from './Transcript';
import './AgentView.css';

/** What the view does to its agent's session (src/main/core/engine/delivery/mailbox.ts). */
export interface SessionControls extends ComposerControls {
  replyPrompt?: ((need: string, answer: ArgsOf<'reply'>['answer']) => Promise<unknown>) | undefined;
  /** Records a command the view answers itself in a panel, without sending a turn. */
  recordCommand?: (text: string) => void;
  /** Starts the session (again), as when the view opens: a connected one resumes. */
  open: () => void;
  /** The conversations its connection kept for the project folder (/resume). */
  pastSessions: () => Promise<PastSession[]>;
  /** Opens one of them in the agent, in place of its own. */
  resume: (sessionId: string) => Promise<void>;
  /** What restoring its files to before a message would change, and rewinding there. */
  previewRewind: (messageId: string) => Promise<FilesRewind>;
  rewind: (messageId: string, restore: RewindRestore) => Promise<RewindResult>;
  /** What an agent of a CLI can be set to run with, and the user's own defaults. */
  settingsOptions: (adapter: AdapterId) => Promise<SettingsOptions>;
  /** Starts its connected session again with what it is set to now, resuming its conversation. */
  restart: () => void;
  /** Its session's MCP servers (/mcp), and a change to one (resolving with them all then). */
  mcpServers: () => Promise<McpServer[]>;
  changeMcpServer: (server: string, change: McpChange) => Promise<McpServer[]>;
}

/**
 * An agent opened up: its queue (QueueEditor.tsx) beside its session (the transcript, and a
 * composer to write to the agent). It grows out
 * of the agent's card to fill the editor, over a blurred canvas, and shrinks back into it on Back,
 * Escape, or a click outside. Escape interrupts the agent first while it works.
 *
 * Picking another agent for a wait opens that agent's queue beside this one (PeerQueue.tsx), to
 * pick which of its steps to wait for; while it is open, lines link the waits in either queue to
 * what they wait for in the other (QueueLinks.tsx).
 *
 * At its right edge, a rail (Rail.tsx) spawns a new agent, and stacks the others opened from it.
 * Spawning or switching minimizes the panel into the top of the stack, where its card appears; the
 * agent shown next grows out of the ⊕, or out of its card, over the same backdrop.
 *
 * The agent chip sets its type and how it runs (`connection`): a real connection to the
 * CLI. Beside it, a summary of its settings opens the Agent settings sheet (AgentSettings.tsx): the
 * model, effort and mode its CLI starts with (a structured session's composer sets them too). What
 * it shows is its connection's `view` alone: a session connected through a structured interface
 * shows in the same transcript and composer, fed by the main process
 * (src/main/core/engine/transcript/receive.ts); one whose view is a terminal shows the CLI's own
 * terminal instead (TerminalPane.tsx), where the user works with it as in any terminal.
 *
 * While the queues' run holds the agent for the user (`ask`, at an OK or a repeat out of rounds),
 * a bar above the composer asks, with its choices; what is sent from the composer then is the
 * answer in the user's words (the changes to make, or what to try next, with the images pasted
 * into it), not a message of its own; a slash command sent to a connected session still runs as
 * a command, as the bar says. A Terminal agent has no composer: the bar, under its terminal, has
 * a box of its own for the answer. Either way, that answer goes to the agent's session as a
 * message (RunStore.decide).
 *
 * An agent whose connection declares `continueIn` can continue its conversation there (the
 * connections share its session): from its agent chip, or where a command only that connection
 * runs, or a shell command by its own prefix, is typed (commands.ts, over the descriptors), which
 * is offered there, naming it, instead of being sent, and runs there once the agent has switched.
 * The view answers the commands its connection declares as panels itself (commands.ts'
 * VIEW_COMMANDS), in a panel above the composer, where its session's `features` say the panel can
 * open now (else it says so, and sends nothing): /resume picks another conversation of the project
 * folder to open in its place (ResumePicker.tsx), /mcp shows its MCP servers to change as
 * `features` allow (McpPanel.tsx; signing in is the continuation's, where it declares so), and
 * /rewind, Esc twice in its empty composer, or "Rewind to here" on one of the user's messages
 * restores what `features` allow to before a message (Rewind.tsx), the message going back into the
 * composer to edit.
 */
export function AgentView({
  node,
  nodes,
  origin,
  from,
  opening,
  openingDuration = 350,
  stack,
  onNewAgent,
  onSwitch,
  onRename,
  connection,
  project,
  terminal,
  onAgent,
  onOpenSettings,
  onContinue,
  edits,
  marks,
  ask,
  onShowQueues,
  queueState,
  onAgentContextMenu,
  session,
  controls,
  onClose,
}: {
  node: AgentNode;
  /** A new identity for each request to show the window, even for the same agent. */
  opening: object;
  openingDuration?: number | undefined;
  /** Every node of the graph: what queued items can act on. */
  nodes: readonly CanvasNode[];
  /** Where the node's card is on screen: the panel grows from it and shrinks back into it. */
  origin: () => DOMRect | undefined;
  /**
   * Where the panel grows from when the agent comes from the rail (its ⊕, or its card in the
   * stack); otherwise it grows out of its card on the canvas, over a backdrop fading in.
   */
  from: DOMRect | undefined;
  /** The other agents opened from the rail, most recent first. */
  stack: readonly StackedAgent[];
  /** Spawns an agent from this one, to show in its place, growing from `from`. */
  onNewAgent: (relation: Relation, from: DOMRect) => void;
  /** Shows agent `id` from the stack in its place, growing from `from`. */
  onSwitch: (id: string, from: DOMRect) => void;
  onRename: (label: string) => void;
  /** How it runs: a real connection to the CLI. */
  connection: AgentConnection | undefined;
  /** The folder the canvas's agents work in, if one was chosen. */
  project: ProjectFolder | null;
  /** Where a Terminal agent's terminal comes from (the main process). */
  terminal: TerminalBackend;
  /** Sets its type and how it runs. */
  onAgent: (agent: AdapterId, connection: AgentConnection) => void;
  /** Opens its Agent settings sheet (AgentSettings.tsx). */
  onOpenSettings: () => void;
  /** Switches it to its continuation connection, resuming its conversation, and runs `command` there if given. */
  onContinue: (
    request: string,
    connection: ConnectionId,
    command?: string,
    images?: MessageImage[],
  ) => Promise<unknown> | undefined;
  /** What changes its queue, and the queue shown beside it. */
  edits: QueueEdits;
  /** How each agent's tasks are marked: links, and where the queues' run is (src/shared/model/queue-marks.ts). */
  marks: (agent: string, item: string | null) => RowMarks;
  /** What the queues' run holds this agent for the user to decide, if anything (src/shared/model/run-words.ts). */
  ask?: HeldAsk | undefined;
  /** Shows every agent's queue, side by side (QueuesView.tsx). */
  onShowQueues: () => void;
  queueState?: 'Pausing' | 'Paused' | undefined;
  onAgentContextMenu?: (event: React.MouseEvent) => void;
  session: Session;
  controls: SessionControls;
  onClose: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLElement>(null);
  /** Whether it is on its way out: closing, or giving way to another agent. */
  const leaving = useRef(false);
  /** Whether it is minimizing into the rail, its card on top of the stack. */
  const [minimizing, setMinimizing] = useState<object>();
  /** Animations and completions belong to one opening, never to a later request to show it. */
  const showing = useRef<{ active: boolean; animations: Animation[] }>(undefined);

  useLayoutEffect(() => {
    const current = { active: true, animations: [] as Animation[] };
    showing.current = current;
    leaving.current = false;
    // Not the panel: the composer has the keyboard (autoFocus).
    if (panel.current && content.current && backdrop.current) {
      const card = from ?? origin();
      if (card) {
        current.animations = [
          morph(panel.current, card, 'open', from ? { duration: openingDuration, fade: true } : {}),
          !from && animate(backdrop.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 }),
          animate(content.current, [{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            delay: 160,
            fill: 'backwards',
          }),
        ].filter((animation): animation is Animation => Boolean(animation));
      }
    }
    return () => {
      current.active = false;
      for (const animation of current.animations) {
        void animation.finished.catch(() => undefined);
        animation.cancel();
      }
    };
  }, [origin, from, opening, openingDuration]);

  const close = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    const current = showing.current;
    const to = origin();
    const shrinking = (
      to && panel.current && content.current && backdrop.current
        ? [
            morph(panel.current, to, 'close'),
            animate(content.current, [{ opacity: 1 }, { opacity: 0 }], {
              duration: 100,
              fill: 'forwards',
            }),
            animate(backdrop.current, [{ opacity: 1 }, { opacity: 0 }], {
              duration: 260,
              fill: 'forwards',
            }),
          ]
        : []
    ).filter((animation) => animation !== undefined);
    current?.animations.push(...shrinking);
    const closed = () => {
      if (current?.active) onClose();
    };
    if (shrinking.length === 0) closed();
    else void Promise.all(shrinking.map((animation) => animation.finished)).then(closed, closed);
  }, [origin, onClose]);

  /**
   * Minimizes the panel into the top of the rail's stack, where its card appears as the cards there
   * make room, then gives way to the agent shown next (`next`), saying where that agent is to grow
   * from: what was clicked (`clicked`, the ⊕ or a card), or for an agent from the stack
   * (`stacked`), its card where it has slid to. Without motion, it gives way at once.
   */
  const minimize = (
    stacked: string | undefined,
    clicked: DOMRect,
    next: (from: DOMRect) => void,
  ) => {
    const box = panel.current;
    const strip = rail.current;
    if (leaving.current || !box || !content.current || !strip) return;
    leaving.current = true;
    const current = showing.current;
    const cards = () => [...strip.querySelectorAll<HTMLElement>('[data-stack]')];
    const card = (id: string) => cards().find((element) => element.dataset.stack === id);
    const before = new Map(cards().map((c) => [c.dataset.stack ?? '', c.getBoundingClientRect()]));
    // From where it rests, not part-way through growing.
    settle(box);
    flushSync(() => {
      setMinimizing(opening);
    });
    const landing = card(node.id);
    const motions = [
      ...slide(cards(), (element) => element.dataset.stack, before, 250),
      landing &&
        morph(box, landing.getBoundingClientRect(), 'close', { duration: 250, fade: true }),
      // The panel fades into its card.
      landing &&
        animate(landing, [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], {
          duration: 250,
        }),
      animate(content.current, [{ opacity: 1 }, { opacity: 0 }], {
        duration: 100,
        fill: 'forwards',
      }),
    ].filter((motion) => motion !== undefined);
    current?.animations.push(...motions);
    const go = () => {
      if (!current?.active) return;
      next((stacked === undefined ? undefined : card(stacked)?.getBoundingClientRect()) ?? clicked);
    };
    if (motions.length === 0) go();
    else void Promise.all(motions.map((motion) => motion.finished)).then(go, go);
  };

  const working = session.status !== 'idle';
  /** The user's messages it can rewind to (since the last /clear), oldest first. */
  const points = rewindPoints(session.entries);
  /** Whether its connection offers rewind now: idle, with a message of the user's. */
  const declared = connectionIn(catalog(), connection)?.connection;
  /** What its ready session can do now: none while no generation is ready. */
  const features = session.features ?? null;
  /** The connection it continues in, if it declares one this build has. */
  const target = continuationOf(connection);
  const rewindable = panelOpens('rewind', features) && !working && points.length > 0;
  const { stop } = controls;
  const composer = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  /** The agent whose queue is shown beside this one. */
  const [peer, setPeer] = useState<string>();
  /** The wait target whose step is being picked in that queue. */
  const [choosing, setChoosing] = useState<StepChoice>();
  /** Text only its continuation connection runs, while continuing there is offered for it. */
  const [offer, setOffer] = useState<{
    text: string;
    route: Extract<Route, { kind: 'continue' | 'shell' }>;
    /** This offer's request id: kept for its confirm and any retry of it. */
    request: string;
    images?: MessageImage[];
  }>();
  /** The request id of the sign-in continuation the open /mcp panel offers. */
  const signInRequest = useRef<string>(undefined);
  /** A panel its connection declares that can't open now, as the view said so. */
  const [unavailable, setUnavailable] = useState<string>();
  /** The view's own command whose panel is open above the composer (/resume). */
  const [opened, setOpened] = useState<ViewCommand>();
  /** The message picked to rewind to, while /rewind's panel is open (none: it asks which). */
  const [rewindTo, setRewindTo] = useState<string>();
  /** What the composer starts with, and its turn (a new one starts it afresh with that). */
  // A stale offer, panel or note names a connection the agent no longer has.
  const [shownFor, setShownFor] = useState(connection);
  if (shownFor !== connection) {
    setShownFor(connection);
    setOffer(undefined);
    setOpened(undefined);
    setUnavailable(undefined);
  }
  const [draft, setDraft] = useState<{ text: string; images?: MessageImage[]; turn: number }>({
    text: '',
    turn: 0,
  });
  /** The first Esc of a double one, in an empty composer: what closes the view if no second comes. */
  const firstEsc = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(firstEsc.current);
    },
    [],
  );
  /** Closes that panel, and gives the keyboard back to the composer. */
  const closeOpened = () => {
    setOpened(undefined);
    composer.current?.focus();
  };
  const chooseStep = useCallback(
    (choice: StepChoice) => {
      setPeer(choice.agent);
      setChoosing(choice);
    },
    [setPeer, setChoosing],
  );
  // Escape steps back: from a panel above the composer (/mcp, /resume, a continuation offered), from
  // picking, from the queue beside, from the agent's work, then the view.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (opened !== undefined || offer !== undefined || unavailable !== undefined) {
        setOpened(undefined);
        setOffer(undefined);
        setUnavailable(undefined);
        composer.current?.focus();
      } else if (choosing) setChoosing(undefined);
      else if (peer !== undefined) setPeer(undefined);
      else if (working) stop();
      else if (rewindable && event.target === composer.current) {
        // Twice, in the empty composer, it rewinds; once, it closes the view.
        if (firstEsc.current === undefined) {
          firstEsc.current = setTimeout(() => {
            firstEsc.current = undefined;
            close();
          }, DOUBLE_ESC_MS);
        } else {
          clearTimeout(firstEsc.current);
          firstEsc.current = undefined;
          setRewindTo(undefined);
          setOpened('rewind');
        }
      } else close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, working, stop, choosing, peer, opened, offer, unavailable, rewindable]);

  /** Its own queue's edits. */
  const own = editsOf(edits, node.id);
  const peerNode = nodes.filter((n) => n.type === 'agent').find((n) => n.id === peer);
  const links = useMemo(() => (peerNode ? queueLinks(node, peerNode) : []), [node, peerNode]);
  const waiting = choosing && findItem(node.data.queue ?? [], choosing.waitId)?.item;
  const chosen = waiting && isWait(waiting) ? waiting.waitFor[choosing.index] : undefined;
  /** Sets the target being picked to one of the peer's steps, or (undefined) all of its work. */
  const pick = (item: string | undefined) => {
    if (!choosing || !waiting || !isWait(waiting)) return;
    const target: WaitTarget =
      item === undefined ? { agent: choosing.agent } : { agent: choosing.agent, item };
    void own.onWaitFor(waiting.id, chooseTarget(waiting.waitFor, choosing.index, target));
    setChoosing(undefined);
  };

  const label = node.data.label;
  const { problem: titleProblem, ...title } = useLabel(label, onRename);
  const name = label || 'Unnamed agent';
  const agent = agentAdapter(node.data);
  /** The chat's first message, which names it in the queue: of the conversation it is on now. */
  const firstMessage = chatStart(session.entries, adapterOf(connection));
  /** The lines its edits added and removed, this session. */
  const changed = session.entries.reduce(
    (sum, entry) =>
      entry.kind === 'tool' && entry.status === 'done' && entry.detail?.kind === 'diff'
        ? { added: sum.added + entry.detail.added, removed: sum.removed + entry.detail.removed }
        : sum,
    { added: 0, removed: 0 },
  );
  /** Its card, on top of the stack while it minimizes into the rail. */
  const itself: StackedAgent = { id: node.id, name, agent, status: session.status };
  /** The slash commands its composer completes: its session's, its panels' and its continuation's. */
  const commands = completedCommands(session.commands, connection, features);
  /**
   * What the composer sends, by the one routing decision (routing.ts): a panel's command opens its
   * panel (or says it can't, sending nothing); text only its continuation connection runs is
   * offered there instead; while the run asks (`ask.reply`), the answer, unless it is a command
   * the session runs.
   */
  /** Why text it would offer to continue elsewhere can't go with its images, if so. */
  const refuses = (text: string, images: MessageImage[]) => {
    const route = routeText(text, connection, session.commands);
    return (route.kind === 'continue' || route.kind === 'shell') && target
      ? imageRefusal(images, target.images, target.label)
      : undefined;
  };
  const send = (text: string, images?: MessageImage[]) => {
    const route = routeText(text, connection, session.commands);
    // Whatever was said before is stale once something else is sent.
    setUnavailable(undefined);
    if (route.kind === 'panel') {
      if (!panelOpens(route.panel, features)) {
        setOffer(undefined);
        setOpened(undefined);
        setUnavailable(
          panelWords(
            route.panel,
            features,
            declared?.label ?? 'This connection',
            session.mode !== null || (session.models?.length ?? 0) > 0,
          ),
        );
        return;
      }
      controls.recordCommand?.(text);
      setRewindTo(undefined);
      if (route.panel === 'mcp') signInRequest.current = crypto.randomUUID();
      setOpened(route.panel);
      return;
    }
    if ((route.kind === 'continue' || route.kind === 'shell') && target === undefined) {
      // The core decides the same and refuses; the view says so without asking it.
      setOffer(undefined);
      setUnavailable(routeRefusal(route, name, '') ?? '');
      return;
    }
    if ((route.kind === 'continue' || route.kind === 'shell') && target !== undefined) {
      setOpened(undefined);
      setOffer({
        text,
        route,
        request: crypto.randomUUID(),
        ...(images?.length ? { images } : {}),
      });
      return;
    }
    // A command the session offers runs as a command; unknown commands: any /name does.
    const command =
      route.kind === 'command' ||
      (connection !== undefined &&
        session.commands === undefined &&
        isCommand(text.trimStart(), undefined));
    if (ask?.reply && !command) {
      own.onDecide(ask.item.id, {
        reply: text,
        ...(images === undefined || images.length === 0 ? {} : { images }),
      });
      return;
    }
    controls.send(text, images);
  };
  return (
    <div
      ref={backdrop}
      className="graph-detail-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="agent-view"
        data-agent={agent}
        data-accent={adapterAccent(agent)}
        role="dialog"
        aria-modal="false"
        aria-label={name}
        tabIndex={-1}
      >
        <div ref={panel} className="agent-panel">
          <div ref={content} className="agent-content">
            <header
              className="agent-header"
              data-agent-menu={node.id}
              onContextMenu={onAgentContextMenu}
            >
              <button
                type="button"
                className="agent-back"
                aria-label="Back to the canvas"
                title="Back to the canvas (Esc)"
                onClick={close}
              >
                Canvas
              </button>
              <input
                className="agent-title"
                aria-label="Name"
                {...title}
                title={titleProblem}
                placeholder="Unnamed agent"
              />
              {titleProblem && <span role="alert">{titleProblem}</span>}
              {queueState && <span className="agent-control-state">{queueState}</span>}
              {changed.added + changed.removed > 0 && (
                <span className="agent-diff" title="Lines changed this session">
                  <span className="agent-added">+{changed.added}</span>{' '}
                  <span className="agent-removed">−{changed.removed}</span>
                </span>
              )}
              <button
                type="button"
                className="agent-queues"
                title="Every agent's queue, side by side"
                onClick={onShowQueues}
              >
                All queues
              </button>
              <WorkspaceBadge agent={node.id} />
              <BranchControls agent={node.id} />
              <AgentSettingsSummary
                node={node}
                options={controls.settingsOptions}
                onOpen={onOpenSettings}
              />
              <AgentChip
                agentId={node.id}
                initiallyOpen={agent === undefined}
                adapter={agent}
                connection={connection}
                onChange={onAgent}
                onContinue={(request, to) => {
                  void onContinue(request, to);
                }}
              />
              <ApiMark agent={node.id} />
            </header>
            <WorkspaceWait agent={node.id} />
            <div ref={body} className="agent-body">
              <aside className="agent-side" data-column="own" aria-label="Questions and queue">
                <HandoffTile agent={node.id} />
                <h2 className="agent-side-title">Queue</h2>
                {firstMessage && (session.submissions?.length ?? 0) === 0 && (
                  <div
                    className="graph-queue-row agent-thread"
                    role="group"
                    aria-label={`Current chat: ${threadTitle(firstMessage.text)}`}
                    data-status={session.status}
                  >
                    <span className="agent-thread-status" aria-hidden="true" />
                    <span className="graph-queue-keyword">Chat</span>
                    <span className="agent-thread-title" title={firstMessage.text}>
                      {threadTitle(firstMessage.text)}
                    </span>
                  </div>
                )}
                <QueueEditor
                  node={node}
                  nodes={nodes}
                  agent={agent}
                  actions={actionsOf(agent)}
                  {...own}
                  onChooseStep={chooseStep}
                  {...(choosing ? { choosing } : {})}
                  marks={(item) => marks(node.id, item)}
                />
              </aside>
              {peerNode && (
                <PeerQueue
                  node={peerNode}
                  nodes={nodes}
                  edits={edits}
                  marks={marks}
                  picking={chosen ? { item: chosen.item } : undefined}
                  onPick={pick}
                  onClose={() => {
                    setPeer(undefined);
                    setChoosing(undefined);
                  }}
                />
              )}
              {connection === undefined || agent === undefined ? (
                <section className="agent-session agent-unavailable" aria-label="Session">
                  <p className="agent-session-note">{sessionNote(node.data, project)}</p>
                  <textarea
                    aria-label="Message"
                    disabled
                    placeholder={sessionNote(node.data, project)}
                  />
                  <button type="button" onClick={onOpenSettings}>
                    Choose an agent
                  </button>
                </section>
              ) : isTerminal(connection) ? (
                <TerminalPane
                  agentId={node.id}
                  cli={adapterCli(agent)}
                  backend={terminal}
                  session={session}
                  note={sessionNote(node.data, project)}
                  onStart={controls.open}
                  onUnqueue={controls.unqueue}
                  onPromptReply={controls.replyPrompt}
                  ask={
                    ask && (
                      <AskBar
                        key={ask.item.id}
                        ask={ask}
                        onChoose={(choice) => {
                          own.onDecide(ask.item.id, { choice });
                        }}
                        onReply={(text) => {
                          own.onDecide(ask.item.id, { reply: text });
                        }}
                      />
                    )
                  }
                  above={
                    <QueueAddMenu
                      node={node}
                      nodes={nodes}
                      actions={actionsOf(agent)}
                      label="Queue something"
                      onAdd={own.onAdd}
                      onChooseStep={chooseStep}
                    />
                  }
                />
              ) : (
                <section className="agent-session" aria-label="Session">
                  <Transcript
                    session={session}
                    agentName={name}
                    note={sessionNote(node.data, project)}
                    answers={{
                      onPromptReply: controls.replyPrompt,
                      onSwitch: (to) => {
                        onAgent(agent, to);
                      },
                      ...(rewindable
                        ? {
                            onRewind: (messageId: string) => {
                              setRewindTo(messageId);
                              setOpened('rewind');
                            },
                          }
                        : {}),
                      ...(controls.stopTask ? { onStopTask: controls.stopTask } : {}),
                    }}
                  />
                  <Composer
                    key={draft.turn}
                    initialDraft={draft.text}
                    {...(draft.images ? { initialImages: draft.images } : {})}
                    agentName={name}
                    agent={agent}
                    session={session}
                    commands={commands}
                    controls={{ ...controls, send, refuses }}
                    field={composer}
                    {...(ask?.reply ? { placeholder: ask.reply.label } : {})}
                    above={
                      <>
                        {opened === 'rewind' && (
                          <Rewind
                            messages={points}
                            restores={features?.panels.rewind?.restores ?? []}
                            start={rewindTo}
                            preview={controls.previewRewind}
                            rewind={controls.rewind}
                            onRewound={(point, result) => {
                              // The message rewound to goes back in the box, to edit.
                              if (result.conversation) {
                                setDraft(({ turn }) => ({ text: point.text, turn: turn + 1 }));
                              }
                            }}
                            onClose={closeOpened}
                          />
                        )}
                        {opened === 'mcp' && (
                          <McpPanel
                            adapter={agent}
                            changes={features?.panels.mcp?.changes ?? []}
                            list={controls.mcpServers}
                            change={controls.changeMcpServer}
                            {...(declared?.continueIn?.mcpSignIn && target
                              ? {
                                  signIn: {
                                    label: target.label,
                                    onSignIn: () => {
                                      setOpened(undefined);
                                      void onContinue(
                                        signInRequest.current ?? crypto.randomUUID(),
                                        target.id,
                                        '/mcp',
                                      );
                                    },
                                  },
                                }
                              : {})}
                            onClose={closeOpened}
                          />
                        )}
                        {opened === 'resume' && (
                          <ResumePicker
                            list={controls.pastSessions}
                            onPick={(picked) => controls.resume(picked.id)}
                            onClose={closeOpened}
                          />
                        )}
                        {unavailable !== undefined && (
                          <div
                            className="agent-offer"
                            role="group"
                            aria-label="Not available"
                            onKeyDown={(event) => {
                              if (event.key !== 'Escape') return;
                              event.stopPropagation();
                              setUnavailable(undefined);
                              composer.current?.focus();
                            }}
                          >
                            <p>{unavailable}</p>
                            <button
                              type="button"
                              onClick={() => {
                                setUnavailable(undefined);
                                composer.current?.focus();
                              }}
                            >
                              Close
                            </button>
                          </div>
                        )}
                        {offer !== undefined && target !== undefined && (
                          <ContinueOffer
                            target={target}
                            words={offerWords(offer.text, offer.route, target)}
                            onContinue={() => {
                              const { text, images, request, route } = offer;
                              setOffer(undefined);
                              // A refusal puts what was typed back, with its images, to correct.
                              void onContinue(request, route.connection, text, images)?.catch(
                                () => {
                                  setDraft(({ turn }) => ({
                                    text,
                                    ...(images ? { images } : {}),
                                    turn: turn + 1,
                                  }));
                                },
                              );
                            }}
                            onCancel={() => {
                              setOffer(undefined);
                              composer.current?.focus();
                            }}
                          />
                        )}
                        {ask && (
                          <AskBar
                            ask={ask}
                            // Its transcript says why its own session would not start.
                            said={ask.refusal?.agent === node.id}
                            {...(ask.reply ? { hint: COMMAND_HINT } : {})}
                            onChoose={(choice) => {
                              own.onDecide(ask.item.id, { choice });
                            }}
                          />
                        )}
                        <QueueAddMenu
                          node={node}
                          nodes={nodes}
                          actions={actionsOf(agent)}
                          label="Queue something"
                          onAdd={own.onAdd}
                          onChooseStep={chooseStep}
                        />
                      </>
                    }
                  />
                </section>
              )}
              {peerNode && <QueueLinks container={body} links={links} />}
            </div>
          </div>
        </div>
        <Rail
          element={rail}
          name={name}
          stack={minimizing === opening ? [itself, ...stack] : stack}
          onNew={(relation, plus) => {
            minimize(undefined, plus, (at) => {
              onNewAgent(relation, at);
            });
          }}
          onSwitch={(id, card) => {
            minimize(id, card, (at) => {
              onSwitch(id, at);
            });
          }}
        />
      </div>
    </div>
  );
}

/** How soon a second Esc must follow the first, in an empty composer, to rewind. */
const DOUBLE_ESC_MS = 500;

/** What the bar says a slash command typed below does while it asks: it runs, as a command. */
const COMMAND_HINT = 'A /command typed below runs as a command, not as your answer.';

/** "Your OK on the spec?" as the bar says it: "Waits for your OK on the spec". */
const waitsFor = (text: string) =>
  `Waits for ${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\?$/, '')}`;

/**
 * What the run holds the agent for, above its composer: what it waits for (or what it says), that
 * what is written below answers it (its reply), and its choices. At an OK: "Waits for your OK on
 * the spec: write below what should change, or [Approve] [Stop here]". Otherwise, its question:
 * "3 rounds done, and still not: its last step succeeds. What should it try next? Write it below,
 * or [One more round] [Go on]". Where a session would not start, what waits, and why (unless
 * the transcript below says why: `said`): "Bash waits until Shop can start: <why it cannot>…:
 * [Switch to Terminal]".
 *
 * With `onReply`, where there is no composer below (a Terminal agent's bar), the reply has a box
 * of its own after the choices: "Waits for your OK on the spec: [Approve] [Stop here] [What should
 * change?] [Ask for changes]". `hint`, on a line of its own: what else typing below does.
 */
function AskBar({
  ask,
  said = false,
  hint,
  onChoose,
  onReply,
}: {
  ask: HeldAsk;
  /** Whether the transcript shown with it already says why a session would not start. */
  said?: boolean;
  hint?: string;
  onChoose: (choice: string) => void;
  /** Takes the reply typed in the bar's own box (trimmed, never empty). */
  onReply?: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const reply = onReply === undefined ? ask.reply?.label : undefined;
  const below = reply?.replace(/\?$/, '');
  const text = ask.refusal
    ? `${ask.detail ?? ''}:${said ? '' : ` ${ask.text}`}`
    : !ask.problem && isApproval(ask.item)
      ? `${waitsFor(ask.text)}${below === undefined ? ':' : `: write below ${below.charAt(0).toLowerCase()}${below.slice(1)}, or`}`
      : `${ask.text}${reply === undefined ? '' : ` ${reply} Write it below, or`}`;
  const send = () => {
    const typed = draft.trim();
    if (typed === '' || !onReply) return;
    onReply(typed);
    setDraft('');
  };
  return (
    <div className="agent-ok" role="group" aria-label="Needs you">
      <span className="agent-ok-text">{text}</span>
      {ask.choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          data-primary={choice.primary ? '' : undefined}
          {...(choice.title === undefined ? {} : { title: choice.title })}
          onClick={() => {
            onChoose(choice.key);
          }}
        >
          {choice.label}
        </button>
      ))}
      {onReply && ask.reply && (
        <span className="agent-ok-reply">
          <input
            aria-label={ask.reply.label}
            placeholder={ask.reply.label}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') send();
            }}
          />
          <button type="button" disabled={draft.trim() === ''} onClick={send}>
            {ask.reply.button}
          </button>
        </span>
      )}
      {hint !== undefined && <span className="agent-ok-hint">{hint}</span>}
    </div>
  );
}

/**
 * Offers to continue in `target` for text only it runs, above the composer: "/settings runs only
 * in Zed Shell…: [Continue in Zed Shell] [Cancel]". Esc cancels, leaving the view open.
 */
function ContinueOffer({
  target,
  words,
  onContinue,
  onCancel,
}: {
  target: Pick<ConnectionDescriptor, 'label'>;
  words: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="agent-offer"
      role="group"
      aria-label={`Continue in ${target.label}?`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <p>{words}</p>
      <button
        type="button"
        data-primary=""
        // It asks for the user's attention: the keyboard comes here.
        autoFocus
        onClick={onContinue}
      >
        Continue in {target.label}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** What the empty transcript says about how the session runs, and what it needs. */
function sessionNote(data: AgentData, project: ProjectFolder | null): string {
  const endpoint = agentEndpoint(data, catalog());
  const reason = endpointRefusal(endpoint, data.label || 'Unnamed agent');
  if (reason !== undefined) return reason;
  const cli = adapterCli(agentAdapter(data));
  const connection = connectionIn(catalog(), connectionOf(data))?.connection;
  const how =
    connection?.view === 'terminal'
      ? 'in a terminal'
      : `through ${connection?.label ?? 'its connection'}`;
  return project === null
    ? `Choose a project folder for this canvas (top left of the canvas) to run ${cli} in it, ${how}.`
    : `${cli} works in ${project.name}, ${how}.`;
}
