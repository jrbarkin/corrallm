import { useState } from 'react';
import type { ComponentProps } from 'react';

import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { ResultOf } from '../../shared/api/registry';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import { QuestionsSidebar } from './Questions';
import type { Need } from '../../shared/engine/needs';
import { promptQuestions } from '../../shared/model/session';
import { agentName } from '../../shared/model/queries';
import { FloatPopover } from './FloatPopover';

type CoreNeed = ResultOf<'needs'>['items'][number];
type Reply = Awaited<ReturnType<GuiApi['reply']>>;
interface Settlement {
  item: CoreNeed;
  pending: boolean;
  outcome?: string;
  error?: string;
}

/** Core proposals and file reviews beside the renderer run's holds and session questions. */
export function NeedsSidebar({
  canvas,
  mirror,
  onReply,
  ...questions
}: Omit<ComponentProps<typeof QuestionsSidebar>, 'extra'> & {
  canvas: CanvasId;
  mirror: TopicMirror;
  onReply: (to: string, choice: string) => Promise<Reply>;
}) {
  const state = useTopic(`needs:${canvas}`, mirror);
  const [settlements, setSettlements] = useState<ReadonlyMap<string, Settlement>>(new Map());
  const current = new Map(
    (state?.items ?? [])
      .filter(
        (item) =>
          item.kind === 'file' || item.kind === 'proposal' || item.id.startsWith('stalled/'),
      )
      .map((item) => [item.id, item]),
  );
  // Keep the answered card through the topic's removal (which may arrive before reply resolves).
  for (const [id, settlement] of settlements) current.set(id, settlement.item);
  const answer = async (item: CoreNeed, choice: string) => {
    const update = (value: Settlement) => {
      setSettlements((previous) => new Map(previous).set(item.id, value));
    };
    update({ item, pending: true });
    try {
      const result = await onReply(item.id, choice);
      update({ item, pending: false, outcome: result.outcome ?? 'answered' });
    } catch (error) {
      update({ item, pending: false, error: ipcErrorMessage(error) });
    }
  };
  const count =
    needCardsCount(questions.needs) +
    [...current.keys()].filter((id) => !settlements.get(id)?.outcome).length;
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
  if (needCardsCount(questions.needs) === 0 && current.size === 0)
    return (
      <button type="button" aria-label="Needs you" title="Nothing needs you" disabled>
        {bell}
      </button>
    );
  return (
    <FloatPopover label="Needs you" button={bell} className="needs-popover">
      {(close) => (
        <QuestionsSidebar
          {...questions}
          onOpen={(id) => {
            close();
            questions.onOpen(id);
          }}
          extra={{
            count: [...current.keys()].filter((id) => !settlements.get(id)?.outcome).length,
            cards: [...current.values()].map((item) => {
              const settlement = settlements.get(item.id);
              return (
                <article key={item.id} className="graph-question" aria-label={item.title}>
                  <span className="graph-question-header">
                    {item.kind === 'file'
                      ? 'File review'
                      : item.id.startsWith('stalled/')
                        ? `Silent session: ${item.agent === undefined ? 'agent' : agentName(questions.input.nodes, item.agent)}`
                        : 'Proposal'}
                  </span>
                  <p className="graph-question-text">{item.title}</p>
                  {item.detail && <p className="graph-question-detail">{item.detail}</p>}
                  {settlement?.outcome ? (
                    <p role="status">
                      {settlement.outcome.charAt(0).toUpperCase() + settlement.outcome.slice(1)}.
                    </p>
                  ) : (
                    <div className="graph-question-options">
                      {item.choices.map((choice, i) => (
                        <button
                          key={choice.value}
                          type="button"
                          data-primary={i === 0 ? '' : undefined}
                          disabled={settlement?.pending}
                          title={choice.description}
                          onClick={() => {
                            void answer(item, choice.value);
                          }}
                        >
                          {choice.label}
                        </button>
                      ))}
                    </div>
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
            }),
          }}
        />
      )}
    </FloatPopover>
  );
}

/** The number of visible question cards, also used by the Needs float's badge. */
function needCardsCount(needs: readonly Need[]): number {
  return needs.reduce((count, need) => {
    if (need.kind === 'prompt' && need.prompt.kind === 'question')
      return (
        count +
        promptQuestions(need.prompt).filter(({ question }) => question.answer === undefined).length
      );
    return count + (need.kind === 'hold' || need.kind === 'prompt' || need.kind === 'ask' ? 1 : 0);
  }, 0);
}
