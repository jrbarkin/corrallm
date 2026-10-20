import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLabel } from '../useDraft';

import type { AdapterId } from '../../shared/adapter';
import type { ProjectFolder } from '../../shared/ipc';
import type {
  ElicitationAction,
  FormValue,
  McpChange,
  McpServer,
  PastSession,
  FilesRewind,
  RewindRestore,
  RewindResult,
  SettingsOptions,
} from '../../shared/session';
import { adapterOf, isTerminal } from '../catalog';
import { actionsOf, adapterCli, DEFAULT_AGENT } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import { editsOf } from '../graph/edits';
import type { QueueEdits } from '../graph/edits';
import type { AgentNode, CanvasNode } from '../../shared/model/canvas';
import { chooseTarget, findItem, isApproval, isWait } from '../../shared/model/queue';
import type { WaitTarget } from '../../shared/model/queue';
import { QueueAddMenu, QueueEditor } from '../graph/QueueEditor';
import type { RowMarks, StepChoice } from '../graph/QueueEditor';
import type { HeldAsk } from '../../shared/engine/run/asks';
import type { TerminalBackend } from '../terminal/backend';
import { TerminalPane } from '../terminal/TerminalPane';
import { bashCommand, completedCommands, terminalCommand, viewCommand } from './commands';
import type { ViewCommand } from './commands';
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
import { AgentChip } from './AgentChip';
import { AgentSettingsSummary } from './AgentSettings';
import type { Relation, StackedAgent } from './Rail';
import type { ComposerControls } from './Composer';
import { chatStart, rewindPoints, threadTitle } from '../../shared/model/session';
import type { Answer, MessageImage, PlanAnswer, Session } from '../../shared/model/session';
import { Transcript } from './Transcript';
import './AgentView.css';

/** What the view does to its agent's session (src/shared/engine/delivery/mailbox.ts). */
export interface SessionControls extends ComposerControls {
  /** Records a submitted command handled locally, without sending another turn. */
  recordSubmission?: (text: string, images?: MessageImage[]) => void;
  /** Starts the session (again), as when the view opens: a connected one resumes. */
  open: () => void;
  /** `feedback`, with a no: what Claude should do instead. */
  answer: (permissionId: string, answer: Answer, feedback?: string) => void;
  answerQuestion: (promptId: string, index: number, answer: string) => void;
  answerPlan: (promptId: string, answer: PlanAnswer) => void;
  /** The conversations Claude Code kept for the project folder (/resume). */
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
  answerElicitation: (
    promptId: string,
    action: ElicitationAction,
    values?: Record<string, FormValue>,
  ) => void;
}

/**
 * An agent opened up: its queue (QueueEditor.tsx) beside its session, the way Claude
 * Code's desktop app shows one (the transcript, and a composer to write to the agent). It grows out
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
 * model, effort and mode its CLI starts with (a structured session's composer sets them too). A
 * session connected through a
 * structured interface (Claude's Agent SDK, Codex's app server)
 * shows in the same transcript and composer, fed by the main process (src/shared/engine/transcript/receive.ts); one in a
 * Terminal shows the CLI's own terminal instead (TerminalPane.tsx), where the user works with
 * Claude Code or Codex as in any terminal.
 *
 * While the queues' run holds the agent for the user (`ask`, at an OK or a repeat out of rounds),
 * a bar above the composer asks, with its choices; what is sent from the composer then is the
 * answer in the user's words (the changes to make, or what to try next, with the images pasted
 * into it), not a message of its own; a slash command sent to a connected session still runs as
 * a command, as the bar says. A Terminal agent has no composer: the bar, under its terminal, has
 * a box of its own for the answer. Either way, that answer goes to the agent's session as a
 * message (RunStore.decide).
 *
 * An Agent SDK agent can continue its conversation in Terminal, where Claude Code itself runs (the
 * connections share its session): from its agent chip, or where a command only Claude Code's
 * terminal runs is typed (/permissions, /login…: commands.ts), which is offered there instead of
 * being sent, and runs there once the agent has switched. The view answers some commands itself
 * for an Agent SDK agent (commands.ts' VIEW_COMMANDS), in a panel above the composer: /resume
 * picks another conversation of the project folder to open in its place (ResumePicker.tsx), /mcp
 * shows its MCP servers to reconnect, disable or enable (McpPanel.tsx; signing in to one is
 * Claude Code's /mcp in Terminal), and /rewind, Esc twice in its empty composer, or "Rewind to
 * here" on one of the user's messages rewinds its code, its conversation or both to before a
 * message (Rewind.tsx), the message going back into the composer to edit.
 */
export function AgentView({
  node,
  nodes,
  origin,
  from,
  stack,
  onNewAgent,
  onSwitch,
  onRename,
  connection,
  project,
  terminal,
  onAgent,
  onOpenSettings,
  onContinueInTerminal,
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
  connection: AgentConnection;
  /** The folder the canvas's agents work in, if one was chosen. */
  project: ProjectFolder | null;
  /** Where a Terminal agent's terminal comes from (the main process). */
  terminal: TerminalBackend;
  /** Sets its type and how it runs. */
  onAgent: (agent: AdapterId, connection: AgentConnection) => void;
  /** Opens its Agent settings sheet (AgentSettings.tsx). */
  onOpenSettings: () => void;
  /** Switches it to Terminal, which resumes its conversation, and runs `command` there if given. */
  onContinueInTerminal: (command?: string) => void;
  /** What changes its queue, and the queue shown beside it. */
  edits: QueueEdits;
  /** How each agent's tasks are marked: links, and where the queues' run is (queues/marks.ts). */
  marks: (agent: string, item: string | null) => RowMarks;
  /** What the queues' run holds this agent for the user to decide, if anything (src/shared/engine/run/asks.ts). */
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
  const [minimizing, setMinimizing] = useState(false);

  useLayoutEffect(() => {
    // Not the panel: the composer has the keyboard (autoFocus).
    if (!panel.current || !content.current || !backdrop.current) return;
    if (from) {
      // Out of the rail, over the backdrop already there.
      morph(panel.current, from, 'open', { duration: 350, fade: true });
    } else {
      const card = origin();
      if (!card) return;
      morph(panel.current, card, 'open');
      animate(backdrop.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    }
    animate(content.current, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      delay: 160,
      fill: 'backwards',
    });
  }, [origin, from]);

  const close = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
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
    if (shrinking.length === 0) onClose();
    else void Promise.all(shrinking.map((animation) => animation.finished)).then(onClose, onClose);
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
    const cards = () => [...strip.querySelectorAll<HTMLElement>('[data-stack]')];
    const card = (id: string) => cards().find((element) => element.dataset.stack === id);
    const before = new Map(cards().map((c) => [c.dataset.stack ?? '', c.getBoundingClientRect()]));
    // From where it rests, not part-way through growing.
    settle(box);
    flushSync(() => {
      setMinimizing(true);
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
    const go = () => {
      next((stacked === undefined ? undefined : card(stacked)?.getBoundingClientRect()) ?? clicked);
    };
    if (motions.length === 0) go();
    else void Promise.all(motions.map((motion) => motion.finished)).then(go, go);
  };

  const working = session.status !== 'idle';
  /** The user's messages it can rewind to (since the last /clear), oldest first. */
  const points = rewindPoints(session.entries);
  /** Whether it can be rewound now: an idle Agent SDK agent, with a message of the user's. */
  const rewindable = connection === 'claude-code.sdk' && !working && points.length > 0;
  const { stop } = controls;
  const composer = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  /** The agent whose queue is shown beside this one. */
  const [peer, setPeer] = useState<string>();
  /** The wait target whose step is being picked in that queue. */
  const [choosing, setChoosing] = useState<StepChoice>();
  /** A command typed that only Claude Code's terminal runs, while Terminal is offered for it. */
  const [offer, setOffer] = useState<string>();
  /** The view's own command whose panel is open above the composer (/resume). */
  const [opened, setOpened] = useState<ViewCommand>();
  /** The message picked to rewind to, while /rewind's panel is open (none: it asks which). */
  const [rewindTo, setRewindTo] = useState<string>();
  /** What the composer starts with, and its turn (a new one starts it afresh with that). */
  const [draft, setDraft] = useState({ text: '', turn: 0 });
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
  const chooseStep = useCallback((choice: StepChoice) => {
    setPeer(choice.agent);
    setChoosing(choice);
  }, []);
  // Escape steps back: from a panel above the composer (/mcp, /resume, Terminal offered), from
  // picking, from the queue beside, from the agent's work, then the view.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (opened !== undefined || offer !== undefined) {
        setOpened(undefined);
        setOffer(undefined);
        composer.current?.focus();
      } else if (choosing) setChoosing(undefined);
      else if (peer !== undefined) setPeer(undefined);
      else if (working) stop();
      else if (rewindable && event.target === composer.current) {
        // Twice, in the empty composer, it rewinds, as in Claude Code; once, it closes the view.
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
  }, [close, working, stop, choosing, peer, opened, offer, rewindable]);

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
  const agent = node.data.adapter ?? DEFAULT_AGENT;
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
  /** The slash commands its composer completes: an Agent SDK agent's include Terminal's. */
  const commands =
    connection === 'claude-code.sdk' ? completedCommands(session.commands) : session.commands;
  /**
   * What the composer sends: a command only Claude Code's terminal runs (one of its screens, or a
   * shell command for its bash mode) is offered there instead; while the run asks (`ask.reply`),
   * the answer, unless it is a command the session runs.
   */
  const send = (text: string, images?: MessageImage[]) => {
    const answered = connection === 'claude-code.sdk' ? viewCommand(text) : undefined;
    if (answered !== undefined) {
      controls.recordSubmission?.(text, images);
      setRewindTo(undefined);
      setOpened(answered);
      return;
    }
    if (
      connection === 'claude-code.sdk' &&
      (terminalCommand(text, session.commands) || bashCommand(text) !== undefined)
    ) {
      setOffer(text.trim());
      return;
    }
    if (ask?.reply && !(connection !== 'unavailable' && isCommand(text, session.commands))) {
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
        role="dialog"
        aria-modal="true"
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
              <AgentSettingsSummary
                node={node}
                options={controls.settingsOptions}
                onOpen={onOpenSettings}
              />
              <AgentChip
                adapter={agent}
                connection={connection}
                onChange={onAgent}
                onContinueInTerminal={() => {
                  onContinueInTerminal();
                }}
              />
            </header>
            <div ref={body} className="agent-body">
              <aside className="agent-side" data-column="own" aria-label="Questions and queue">
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
              {connection === 'unavailable' ? (
                <section className="agent-session agent-unavailable" aria-label="Session">
                  <p className="agent-session-note">{sessionNote(agent, connection, project)}</p>
                  <button type="button" onClick={onOpenSettings}>
                    Choose a connected agent
                  </button>
                </section>
              ) : isTerminal(connection) ? (
                <TerminalPane
                  agentId={node.id}
                  cli={adapterCli(agent)}
                  backend={terminal}
                  session={session}
                  note={sessionNote(agent, connection, project)}
                  onStart={controls.open}
                  onUnqueue={controls.unqueue}
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
                    agent={agent}
                    note={sessionNote(agent, connection, project)}
                    answers={{
                      // The prompt's buttons are gone: the keyboard goes back to the composer.
                      onAnswer: (permissionId, answer, feedback) => {
                        controls.answer(permissionId, answer, feedback);
                        composer.current?.focus();
                      },
                      onAnswerQuestion: (promptId, index, answer) => {
                        controls.answerQuestion(promptId, index, answer);
                        composer.current?.focus();
                      },
                      onAnswerPlan: (promptId, answer) => {
                        controls.answerPlan(promptId, answer);
                        composer.current?.focus();
                      },
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
                      onAnswerElicitation: (promptId, action, values) => {
                        controls.answerElicitation(promptId, action, values);
                        composer.current?.focus();
                      },
                      ...(controls.stopTask ? { onStopTask: controls.stopTask } : {}),
                    }}
                  />
                  <Composer
                    key={draft.turn}
                    initialDraft={draft.text}
                    agentName={name}
                    agent={agent}
                    session={session}
                    commands={commands}
                    controls={{ ...controls, send }}
                    field={composer}
                    {...(ask?.reply ? { placeholder: ask.reply.label } : {})}
                    above={
                      <>
                        {opened === 'rewind' && (
                          <Rewind
                            messages={points}
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
                            list={controls.mcpServers}
                            change={controls.changeMcpServer}
                            onSignIn={() => {
                              setOpened(undefined);
                              onContinueInTerminal('/mcp');
                            }}
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
                        {offer !== undefined && (
                          <TerminalOffer
                            command={offer}
                            onContinue={() => {
                              setOffer(undefined);
                              onContinueInTerminal(offer);
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
          stack={minimizing ? [itself, ...stack] : stack}
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
 * the transcript below says why: `said`): "Bash waits until Shop can start: Claude Code is logged
 * in with your Claude subscription…: [Switch to Terminal]".
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
 * Offers Terminal for a command only Claude Code's terminal runs, above the composer: "/permissions
 * opens a screen of Claude Code's own…: [Continue in Terminal] [Cancel]", or "!npm test runs in
 * Claude Code's bash mode…". Esc cancels, leaving the view open.
 */
function TerminalOffer({
  command,
  onContinue,
  onCancel,
}: {
  command: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="agent-offer"
      role="group"
      aria-label="Continue in Terminal?"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <p>
        {bashCommand(command) === undefined
          ? `${command} opens a screen of Claude Code’s own, which only its terminal shows: continue this conversation in Terminal to run it there.`
          : `${command} runs in Claude Code’s bash mode, which only its terminal has: continue this conversation in Terminal to run it there, its output going into the conversation.`}
      </p>
      <button
        type="button"
        data-primary=""
        // It asks for the user's attention: the keyboard comes here.
        autoFocus
        onClick={onContinue}
      >
        Continue in Terminal
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** What the empty transcript says about how the session runs, and what it needs. */
function sessionNote(
  agent: AdapterId,
  connection: AgentConnection,
  project: ProjectFolder | null,
): string {
  const cli = adapterCli(agent);
  if (connection === 'unavailable') {
    return `${cli} has no connector yet. Choose Claude Code or Codex in Agent settings.`;
  }
  const how = isTerminal(connection)
    ? 'in a terminal'
    : `through ${connection === 'claude-code.sdk' ? 'the Agent SDK' : 'its app server'}`;
  return project === null
    ? `Choose a project folder for this canvas (top left of the canvas) to run ${cli} in it, ${how}.`
    : `${cli} works in ${project.name}, ${how}.`;
}
