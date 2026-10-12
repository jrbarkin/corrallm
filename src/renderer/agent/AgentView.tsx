import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AGENT_ACTIONS, AgentType, DEFAULT_AGENT } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import type { Condition } from '../graph/queue';
import { QuestionCard } from '../graph/Questions';
import { QueueAddMenu, QueueEditor } from '../graph/QueueEditor';
import type { QueueEntry } from '../graph/QueueEditor';
import { SearchPicker } from '../search/SearchPicker';
import { Composer } from './Composer';
import type { ComposerControls } from './Composer';
import type { Answer, Session } from './session';
import { Transcript } from './Transcript';
import './AgentView.css';

/** What the view does to its agent's session (sessions.ts). */
export interface SessionControls extends ComposerControls {
  answer: (permissionId: string, answer: Answer) => void;
}

/**
 * An agent opened up: its session, the way Claude Code's desktop app shows one (the transcript,
 * and a composer to write to the agent), beside its questions and queue (QueueEditor.tsx). It grows
 * out of the agent's card to fill the editor, over a blurred canvas, and shrinks back into it on
 * Back, Escape, or a click outside. Escape interrupts the agent first while it works.
 */
export function AgentView({
  node,
  nodes,
  origin,
  onRename,
  onAgent,
  onAnswer,
  onSimulateQuestion,
  onAdd,
  onRemove,
  onMove,
  onRetarget,
  onEditMessage,
  onCondition,
  onWaitFor,
  session,
  controls,
  onClose,
}: {
  node: GraphNode;
  /** Every node of the graph: what queued items can act on. */
  nodes: readonly GraphNode[];
  /** Where the node's card is on screen: the panel grows from it and shrinks back into it. */
  origin: () => DOMRect | undefined;
  onRename: (label: string) => void;
  onAgent: (agent: AgentType) => void;
  onAnswer: (questionId: string, answer: string) => void;
  /** A stand-in for an agent asking, until agents are connected. */
  onSimulateQuestion: () => void;
  /** `into`: the id of the if-then to add a step to. */
  onAdd: (entry: QueueEntry, into?: string) => void;
  onRemove: (itemId: string) => void;
  onMove: (itemId: string, index: number) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
  onCondition: (ifId: string, condition: Condition) => void;
  onWaitFor: (waitId: string, agents: string[]) => void;
  session: Session;
  controls: SessionControls;
  onClose: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    // Not the panel: the composer has the keyboard (autoFocus).
    const from = origin();
    if (!from || !panel.current || !content.current || !backdrop.current) return;
    morph(panel.current, from, 'open');
    animate(backdrop.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    animate(content.current, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      delay: 160,
      fill: 'backwards',
    });
  }, [origin]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
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

  const working = session.status !== 'idle';
  const { stop } = controls;
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (working) stop();
      else close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, working, stop]);

  const label = node.data.label;
  const name = label || 'Unnamed agent';
  const agent = node.data.agent ?? DEFAULT_AGENT;
  /** The lines its edits added and removed, this session. */
  const changed = session.entries.reduce(
    (sum, entry) =>
      entry.kind === 'tool' && entry.status === 'done' && entry.detail?.kind === 'diff'
        ? { added: sum.added + entry.detail.added, removed: sum.removed + entry.detail.removed }
        : sum,
    { added: 0, removed: 0 },
  );
  return (
    <div
      ref={backdrop}
      className="graph-detail-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        className="agent-view"
        data-agent={agent}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
      >
        <div ref={content} className="agent-content">
          <header className="agent-header">
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
              value={label}
              placeholder="Unnamed agent"
              onChange={(event) => {
                onRename(event.target.value);
              }}
            />
            {changed.added + changed.removed > 0 && (
              <span className="agent-diff" title="Lines changed this session">
                <span className="agent-added">+{changed.added}</span>{' '}
                <span className="agent-removed">−{changed.removed}</span>
              </span>
            )}
            <AgentChip agent={agent} onChange={onAgent} />
          </header>
          <div className="agent-body">
            <section className="agent-session" aria-label="Session">
              <Transcript
                session={session}
                agentName={name}
                onAnswer={(permissionId, answer) => {
                  controls.answer(permissionId, answer);
                  // The prompt's buttons are gone: the keyboard goes back to the composer.
                  composer.current?.focus();
                }}
              />
              <Composer
                agentName={name}
                agent={agent}
                session={session}
                controls={controls}
                field={composer}
                above={
                  <QueueAddMenu
                    node={node}
                    nodes={nodes}
                    actions={AGENT_ACTIONS[agent]}
                    onAdd={onAdd}
                  />
                }
              />
            </section>
            <aside className="agent-side" aria-label="Questions and queue">
              <section className="graph-detail-questions" aria-label="Questions">
                {(node.data.questions ?? []).map((question) => (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    onAnswer={(answer) => {
                      onAnswer(question.id, answer);
                    }}
                  />
                ))}
                <button type="button" className="graph-simulate" onClick={onSimulateQuestion}>
                  Simulate a question
                </button>
              </section>
              <h2 className="agent-side-title">Queue</h2>
              {(node.data.queue ?? []).length === 0 && (
                <p className="agent-side-empty">
                  Nothing queued. Add to it with ⊕ above the message box.
                </p>
              )}
              <QueueEditor
                add="nothing"
                node={node}
                nodes={nodes}
                agent={agent}
                actions={AGENT_ACTIONS[agent]}
                onAdd={onAdd}
                onRemove={onRemove}
                onMove={onMove}
                onRetarget={onRetarget}
                onEditMessage={onEditMessage}
                onCondition={onCondition}
                onWaitFor={onWaitFor}
              />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The agent's type: a colour-coded chip that opens a dropdown of the agent types. */
function AgentChip({
  agent,
  onChange,
}: {
  agent: AgentType;
  onChange: (agent: AgentType) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="graph-agent-chip">
      <button
        type="button"
        data-agent={agent}
        aria-label={`Agent: ${agent}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {agent}
      </button>
      {open && (
        <SearchPicker
          label="Agent"
          options={Object.values(AgentType)}
          optionLabel={(type) => type}
          optionKey={(type) => type}
          onPick={(type) => {
            onChange(type);
            setOpen(false);
          }}
          onCancel={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Animates the panel between the node's card (`card`, on screen) and its own box: growing out of
 * the card when opening, shrinking back into it when closing.
 */
function morph(element: HTMLElement, card: DOMRect, direction: 'open' | 'close') {
  const box = element.getBoundingClientRect();
  const atCard = {
    transform: `translate(${String(card.left - box.left)}px, ${String(card.top - box.top)}px) scale(${String(card.width / box.width)}, ${String(card.height / box.height)})`,
  };
  const atBox = { transform: 'none' };
  return direction === 'open'
    ? animate(element, [atCard, atBox], { duration: 380, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' })
    : animate(element, [atBox, atCard], {
        duration: 260,
        easing: 'cubic-bezier(0.4, 0, 0.8, 0.4)',
        fill: 'forwards',
      });
}

/** `element.animate`, unless the user asked for reduced motion or there is no Web Animations API. */
function animate(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | undefined {
  if (!('animate' in element)) return undefined;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
  return element.animate(keyframes, options);
}
