import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { SearchPicker } from '../search/SearchPicker';
import { AGENT_ACTIONS, AgentType, DEFAULT_AGENT } from './agents';
import type { GraphNode } from './graph';
import type { Condition } from './queue';
import { QuestionCard } from './Questions';
import { QueueEditor } from './QueueEditor';
import type { QueueEntry } from './QueueEditor';

/**
 * A node opened up, the way an iOS folder opens: the panel grows out of the node's card to fill
 * most of the editor, over a blurred canvas, and shrinks back into it when closed (Escape, the
 * close button, or a click outside). It renames the node, sets its agent, and edits its queue
 * (QueueEditor.tsx).
 */
export function NodeDetail({
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
  onClose: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    panel.current?.focus();
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close]);

  const label = node.data.label;
  const agent = node.data.agent ?? DEFAULT_AGENT;
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
        className="graph-detail"
        data-agent={agent}
        role="dialog"
        aria-modal="true"
        aria-label={label || 'Unnamed agent'}
        tabIndex={-1}
      >
        <div ref={content} className="graph-detail-content">
          <header className="graph-detail-header">
            <input
              aria-label="Name"
              value={label}
              placeholder="Unnamed agent"
              onChange={(event) => {
                onRename(event.target.value);
              }}
            />
            <AgentChip agent={agent} onChange={onAgent} />
            <button
              type="button"
              className="graph-detail-close"
              aria-label="Close"
              onClick={close}
            />
          </header>
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
          <QueueEditor
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
        </div>
      </div>
    </div>
  );
}

/** The node's agent: a colour-coded chip that opens a dropdown of the agent types. */
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
