import { OwnedPrompt } from '../agent/OwnedPrompt';
import { useEffect, useRef, useState } from 'react';

import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { ResultOf } from '../../shared/api/registry';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import { AskCard } from './Questions';
import { QuestionFields } from '../agent/PromptCard';
import type { FieldQuestion } from '../agent/PromptCard';
import type { RuntimeTopicStates } from '../../shared/api/topics';
import type { CanvasNode } from '../../shared/model/canvas';
import type { ArgsOf } from '../../shared/api/registry';
import { MessageId } from '../../shared/api/ids';
import { agentName } from '../../shared/model/queries';
import { FloatPopover } from './FloatPopover';
import { ToolDetailView } from '../agent/ToolDetail';

/** The Needs DTO keeps a diff's visible lines, without native tool execution metadata. */
function NeedDetail({ text }: { text: string }) {
  const lines = text.split('\n');
  if (lines.every((line) => /^[-+ ] /.test(line)))
    return (
      <ToolDetailView
        detail={{
          kind: 'diff',
          added: lines.filter((line) => line.startsWith('+')).length,
          removed: lines.filter((line) => line.startsWith('-')).length,
          lines: lines.map((line) => ({
            kind: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'same',
            text: line.slice(2),
          })),
        }}
      />
    );
  return <p className="graph-question-detail">{text}</p>;
}

/** What a card is, in a chip above it. */
function headerOf(item: CoreNeed, nodes: readonly CanvasNode[]): string {
  if (item.kind === 'file') return 'File review';
  if (item.kind === 'worktree')
    return item.id.startsWith('rebind/') ? 'Workspace change' : 'Worktree setup';
  if (item.id.startsWith('stalled/'))
    return `Silent session: ${item.agent === undefined ? 'agent' : agentName(nodes, item.agent)}`;
  if (item.id.startsWith('unsaved/')) return 'Run progress';
  if (item.id.startsWith('loop/')) return 'Agents going back and forth';
  if (item.id.startsWith('ask/')) return 'Question';
  if (item.kind === 'message') return 'Message';
  if (item.kind === 'hold') return 'Run';
  if (item.kind === 'prompt') return 'Session prompt';
  return 'Proposal';
}

/** The messages a loop hold keeps back, between its two agents (the hold's own words name no text). */
function HeldMessages({
  loop,
  messages,
  nodes,
}: {
  loop: CoreNeed['loop'];
  messages: Messages | undefined;
  nodes: readonly CanvasNode[];
}) {
  if (!loop || !messages) return null;
  const held = loop.held.flatMap((id) => {
    const message = messages.items[MessageId.parse(id)];
    return message?.state === 'pending' ? [message] : [];
  });
  if (held.length === 0) return null;
  const name = (party: string) =>
    party.startsWith('agent:') ? agentName(nodes, party.slice('agent:'.length)) : party;
  return (
    <ul className="graph-question-held" aria-label="Held messages">
      {held.map((message) => (
        <li key={message.id}>
          <span>
            {name(message.from)} to {name(message.to)}, held
          </span>
          <p className="graph-question-detail">{message.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** An ask to you or to an agent, made with `ask`: its questions are the card's body. */
const isAsk = (item: { id: string; prompt?: unknown }) =>
  item.id.startsWith('ask/') && item.prompt === undefined;

type Messages = RuntimeTopicStates[`messages:${CanvasId}`];
type CoreNeed = ResultOf<'needs'>['items'][number];
type Reply = Awaited<ReturnType<GuiApi['reply']>>;
interface Settlement {
  item: CoreNeed;
  pending: boolean;
  outcome?: string;
  error?: string;
  /** The topic dropped the item since this reply was sent: a later item under its id is new. */
  left?: boolean;
}

/** Core run holds, session prompts, proposals and file reviews, all from needs:<c>. */
export function NeedsSidebar({
  canvas,
  mirror,
  onReply,
  nodes,
  onOpen,
  request,
}: {
  canvas: CanvasId;
  mirror: TopicMirror;
  nodes: readonly CanvasNode[];
  onOpen: (agent: string) => void;
  onReply: (to: string, answer: ArgsOf<'reply'>['answer']) => Promise<Reply>;
  /** A card to open and focus (the dock's Review for a workspace change), even if dismissed. */
  request?: { id: string } | undefined;
}) {
  const state = useTopic(`needs:${canvas}`, mirror);
  const messages = useTopic(`messages:${canvas}`, mirror);
  const target = useRef<HTMLElement>(null);
  const focused = useRef<typeof request>(undefined);
  useEffect(() => {
    if (!request || focused.current === request) return;
    const timer = setTimeout(() => {
      if (target.current) {
        target.current.focus();
        focused.current = request;
      }
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [request, state]);
  const [settlements, setSettlements] = useState<ReadonlyMap<string, Settlement>>(new Map());
  const current = new Map((state?.items ?? []).map((item) => [item.id, item]));
  // Pending replies and successful outcomes survive topic removal. A failed reply belongs only
  // to the live item, so a vanished prompt cannot leave a button or badge that can never work.
  // An id can be raised again once it has left (stalled/<agent> is, for each silent turn): that
  // is a new item, shown with its choices and counted, never masked by the old reply's outcome.
  const kept = new Map(settlements);
  let changed = false;
  for (const [id, settlement] of settlements) {
    const live = current.has(id);
    // A setup keeps the same id while it runs, fails and is retried. Its reply settles one
    // choice, not the live card: the next state must still offer Stop or Retry.
    const setupMoved =
      live &&
      !settlement.pending &&
      !!settlement.outcome &&
      (settlement.item.kind === 'worktree' ||
        ((settlement.item.kind === 'prompt' || settlement.item.kind === 'hold') &&
          current.get(id) !== settlement.item));
    if (
      setupMoved ||
      (live ? settlement.left && !settlement.pending : !settlement.pending && !settlement.outcome)
    ) {
      kept.delete(id);
      changed = true;
    } else if (!live && !settlement.left) {
      kept.set(id, { ...settlement, left: true });
      changed = true;
    }
  }
  if (changed) setSettlements(kept);
  for (const [id, settlement] of kept)
    if (settlement.pending || settlement.outcome) current.set(id, settlement.item);
  const answer = async (item: CoreNeed, value: ArgsOf<'reply'>['answer']) => {
    const update = (value: Settlement) => {
      setSettlements((previous) => {
        const left = value.pending ? undefined : previous.get(item.id)?.left;
        return new Map(previous).set(item.id, left ? { ...value, left } : value);
      });
    };
    update({ item, pending: true });
    try {
      const result = await onReply(item.id, value);
      if (item.id.startsWith('prompt/') || item.id.startsWith('hold/'))
        setSettlements((previous) => {
          const next = new Map(previous);
          next.delete(item.id);
          return next;
        });
      else update({ item, pending: false, outcome: result.outcome ?? 'answered' });
    } catch (error) {
      update({ item, pending: false, error: ipcErrorMessage(error) });
    }
  };
  const count = [...current.values()]
    .filter((item) => !kept.get(item.id)?.outcome)
    .reduce(
      (count, item) => count + (item.prompt || isAsk(item) ? 1 : (item.questions?.length ?? 1)),
      0,
    );
  const bell = (
    <>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 11V7a5 5 0 0 1 10 0v4l1 2H2zM6 15h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      {count > 0 && <span className="float-needs-count">{count}</span>}
    </>
  );
  if (current.size === 0)
    return (
      <button type="button" aria-label="Needs you" title="Nothing needs you" disabled>
        {bell}
      </button>
    );
  return (
    <FloatPopover label="Needs you" button={bell} className="needs-popover" request={request}>
      {(close) => (
        <aside className="graph-questions" aria-label="Needs you">
          <h2>
            Needs you <span className="graph-questions-count">{count}</span>
          </h2>
          {[...current.values()].map((item) => {
            const settlement = kept.get(item.id);
            return (
              <article
                key={item.id}
                className="graph-question"
                tabIndex={-1}
                ref={request?.id === item.id ? target : undefined}
                data-requested={request?.id === item.id ? '' : undefined}
                role={item.kind === 'prompt' && !isAsk(item) ? 'group' : undefined}
                aria-label={
                  item.kind === 'prompt' && item.agent
                    ? `${agentName(nodes, item.agent)} asks${item.answerIn === 'terminal' ? ', in its terminal' : item.answerIn === 'both' ? ', here or in its terminal' : ''}`
                    : item.title
                }
              >
                <span className="graph-question-header">{headerOf(item, nodes)}</span>
                {item.agent && (
                  <button
                    type="button"
                    className="graph-question-agent"
                    aria-label={`Open ${agentName(nodes, item.agent)}`}
                    onClick={() => {
                      close();
                      if (item.agent) onOpen(item.agent);
                    }}
                  >
                    {agentName(nodes, item.agent)}
                  </button>
                )}
                {isAsk(item) && item.for.startsWith('agent:') && (
                  <p className="graph-question-detail">
                    For {agentName(nodes, item.for.slice('agent:'.length))}
                  </p>
                )}
                {!item.prompt && (!item.questions?.length || item.answerIn === 'terminal') && (
                  <p className="graph-question-text">{item.title}</p>
                )}
                {!item.prompt && item.detail && <NeedDetail text={item.detail} />}
                {item.id.startsWith('loop/') && (
                  <HeldMessages loop={item.loop} messages={messages} nodes={nodes} />
                )}
                {settlement?.outcome ? (
                  <p role="status">
                    {settlement.outcome.charAt(0).toUpperCase() + settlement.outcome.slice(1)}.
                  </p>
                ) : item.prompt ? (
                  <OwnedPrompt
                    item={item}
                    mirror={mirror}
                    onReply={(value) => onReply(item.id, value)}
                    onOpen={(agent) => {
                      close();
                      onOpen(agent);
                    }}
                  />
                ) : (
                  <>
                    {isAsk(item) && item.questions?.length && item.answerIn !== 'terminal' ? (
                      <fieldset disabled={settlement?.pending === true} className="prompt-actions">
                        <QuestionFields
                          questions={item.questions satisfies FieldQuestion[]}
                          onSend={(answers) => {
                            void answer(item, { answers });
                          }}
                        />
                      </fieldset>
                    ) : null}
                    <AskCard
                      text=""
                      choices={item.choices.map((choice, index) => ({
                        key: choice.value,
                        label: choice.label,
                        ...(choice.description === undefined ? {} : { detail: choice.description }),
                        primary: index === 0,
                      }))}
                      reply={
                        item.text
                          ? {
                              label: item.text.placeholder,
                              button:
                                item.kind === 'hold' &&
                                item.choices.some((choice) => choice.value === 'approve')
                                  ? 'Ask for changes'
                                  : 'Reply',
                            }
                          : undefined
                      }
                      answered={settlement?.pending ? 'Sending…' : undefined}
                      onChoose={(choice) => {
                        void answer(item, { choice });
                      }}
                      onReply={(text) => {
                        void answer(item, { text });
                      }}
                    />
                  </>
                )}
                {settlement?.error && <p role="alert">{settlement.error}</p>}
                {settlement?.outcome && (
                  <button
                    type="button"
                    aria-label={`Dismiss ${item.title}`}
                    onClick={() => {
                      setSettlements((previous) => {
                        const next = new Map(previous);
                        next.delete(item.id);
                        return next;
                      });
                    }}
                  >
                    Dismiss
                  </button>
                )}
              </article>
            );
          })}
        </aside>
      )}
    </FloatPopover>
  );
}
