import { useState } from 'react';

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

/** Core proposals and file reviews beside the renderer run's holds and session questions. */
export function NeedsSidebar({
  canvas,
  mirror,
  onReply,
  nodes,
  onOpen,
}: {
  canvas: CanvasId;
  mirror: TopicMirror;
  nodes: readonly CanvasNode[];
  onOpen: (agent: string) => void;
  onReply: (to: string, answer: ArgsOf<'reply'>['answer']) => Promise<Reply>;
}) {
  const state = useTopic(`needs:${canvas}`, mirror);
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
      update({ item, pending: false, outcome: result.outcome ?? 'answered' });
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
    <FloatPopover label="Needs you" button={bell} className="needs-popover">
      {(close) => (
        <aside className="graph-questions" aria-label="Needs you">
          <h2>
            Needs you <span className="graph-questions-count">{count}</span>
          </h2>
          {[...current.values()].map((item) => {
            const settlement = kept.get(item.id);
            return (
              <article key={item.id} className="graph-question" aria-label={item.title}>
                <span className="graph-question-header">
                  {item.kind === 'file'
                    ? 'File review'
                    : item.kind === 'worktree'
                      ? 'Worktree setup'
                      : item.id.startsWith('stalled/')
                        ? `Silent session: ${item.agent === undefined ? 'agent' : agentName(nodes, item.agent)}`
                        : item.id.startsWith('unsaved/')
                          ? 'Run progress'
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
                {!item.questions?.length && <p className="graph-question-text">{item.title}</p>}
                {item.detail && <p className="graph-question-detail">{item.detail}</p>}
                {settlement?.outcome ? (
                  <p role="status">
                    {settlement.outcome.charAt(0).toUpperCase() + settlement.outcome.slice(1)}.
                  </p>
                ) : item.answerIn === 'terminal' ? (
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
                      item.text ? { label: item.text.placeholder, button: 'Reply' } : undefined
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
