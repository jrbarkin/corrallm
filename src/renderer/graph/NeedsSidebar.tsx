import { useState } from 'react';
import type { ComponentProps } from 'react';

import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { ResultOf } from '../../shared/api/registry';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import { QuestionsSidebar } from './Questions';

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
      .filter((item) => item.kind === 'file' || item.kind === 'proposal')
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
  if (questions.needs.length === 0 && current.size === 0) return null;
  return (
    <QuestionsSidebar
      {...questions}
      extra={{
        count: [...current.keys()].filter((id) => !settlements.get(id)?.outcome).length,
        cards: [...current.values()].map((item) => {
          const settlement = settlements.get(item.id);
          return (
            <article key={item.id} className="graph-question" aria-label={item.title}>
              <span className="graph-question-header">
                {item.kind === 'file' ? 'File review' : 'Proposal'}
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
  );
}
