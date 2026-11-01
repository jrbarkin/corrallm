import { useEffect, useRef, useState } from 'react';
import { useSessionSummaries } from '../api/runtime';
import type { SessionSummary } from '../../shared/model/views';
import type { TerminalAsk } from '../../shared/session';
import { TerminalAskCard } from './Questions';
import { DEFAULT_AGENT } from './agents';

import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { ResultOf } from '../../shared/api/registry';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import { AskCard, QuestionCard } from './Questions';
import type { CanvasNode } from '../../shared/model/canvas';
import type { ArgsOf } from '../../shared/api/registry';
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
  /** What each agent's terminal asks, in its words: its summary's, yours alone and bounded. */
  const summaries: Readonly<Record<string, SessionSummary>> | undefined = useSessionSummaries(
    canvas,
    mirror,
  );
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
    .reduce((count, item) => count + (item.questions?.length ?? 1), 0);
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
            const prefix = `prompt/${encodeURIComponent(item.agent ?? '')}/`;
            // Only the agent is encoded. The native prompt id follows the generation verbatim,
            // and may itself contain separators (the shared Needs router uses the same shape).
            const prompt = item.id.startsWith(prefix)
              ? item.id.slice(prefix.length).split('/').slice(1).join('/')
              : undefined;
            const ask =
              item.answerIn === 'terminal' && item.agent
                ? summaries?.[item.agent]?.asking?.find((ask) => ask.id === prompt)
                : undefined;
            const node = nodes.find((node) => node.id === item.agent && node.type === 'agent');
            if (ask && node?.type === 'agent')
              return (
                <TerminalAskCard
                  key={item.id}
                  ref={
                    request?.id === item.id
                      ? (element) => {
                          target.current = element;
                        }
                      : null
                  }
                  // Shown, never changed: the summary's immutable ask, as the card reads it.
                  ask={ask as TerminalAsk}
                  agent={{
                    name: agentName(nodes, node.id),
                    type: node.data.adapter ?? DEFAULT_AGENT,
                    onOpen: () => {
                      close();
                      onOpen(node.id);
                    },
                  }}
                />
              );
            return (
              <article
                key={item.id}
                className="graph-question"
                tabIndex={-1}
                ref={request?.id === item.id ? target : undefined}
                data-requested={request?.id === item.id ? '' : undefined}
                role={item.kind === 'prompt' ? 'group' : undefined}
                aria-label={
                  item.kind === 'prompt' && item.agent
                    ? `${agentName(nodes, item.agent)} asks${item.answerIn === 'terminal' ? ', in its terminal' : ''}`
                    : item.title
                }
              >
                <span className="graph-question-header">
                  {item.kind === 'file'
                    ? 'File review'
                    : item.kind === 'worktree'
                      ? item.id.startsWith('rebind/')
                        ? 'Workspace change'
                        : 'Worktree setup'
                      : item.id.startsWith('stalled/')
                        ? `Silent session: ${item.agent === undefined ? 'agent' : agentName(nodes, item.agent)}`
                        : item.id.startsWith('unsaved/')
                          ? 'Run progress'
                          : item.kind === 'hold'
                            ? 'Run'
                            : item.kind === 'prompt'
                              ? 'Session prompt'
                              : 'Proposal'}
                </span>
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
                {(!item.questions?.length || item.answerIn === 'terminal') && (
                  <p className="graph-question-text">{item.title}</p>
                )}
                {item.detail && <NeedDetail text={item.detail} />}
                {settlement?.outcome ? (
                  <p role="status">
                    {settlement.outcome.charAt(0).toUpperCase() + settlement.outcome.slice(1)}.
                  </p>
                ) : item.answerIn === 'terminal' ? (
                  <>
                    {item.questions?.map((question) => (
                      <div key={question.id} className="graph-question-asked">
                        {question.header && (
                          <span className="graph-question-header">{question.header}</span>
                        )}
                        <p>{question.text}</p>
                        <ul aria-label="Its answers">
                          {question.options.map((option) => (
                            <li key={option.label}>
                              <span>{option.label}</span>
                              {option.description && <span>{option.description}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    <p>Answer it in the terminal.</p>
                    <button
                      type="button"
                      onClick={() => {
                        if (item.agent) {
                          close();
                          onOpen(item.agent);
                        }
                      }}
                    >
                      Open terminal
                    </button>
                  </>
                ) : item.questions?.length ? (
                  item.questions.map((question) => (
                    <QuestionCard
                      key={question.id}
                      question={{
                        ...question,
                        options: question.options.map((option) => ({
                          label: option.label,
                          ...(option.description === undefined
                            ? {}
                            : { description: option.description }),
                        })),
                      }}
                      onAnswer={(text) => {
                        void answer(item, { answers: { [question.id]: text } });
                      }}
                    />
                  ))
                ) : item.kind === 'prompt' && item.id.startsWith('prompt/') ? (
                  <>
                    <p>Answer it in its session.</p>
                    <button
                      type="button"
                      onClick={() => {
                        if (item.agent) {
                          close();
                          onOpen(item.agent);
                        }
                      }}
                    >
                      Open session
                    </button>
                  </>
                ) : (
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
