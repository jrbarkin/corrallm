import { useState } from 'react';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import { api } from '../api/client';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import './Workspace.css';

/** Kept trees and their core proposals remain reachable even while their canvas is closed. */
export function KeptWorktrees({
  canvas,
  name,
  mirror,
  client = api,
}: {
  canvas: CanvasId;
  name: string;
  mirror: TopicMirror;
  client?: GuiApi | undefined;
}) {
  const state = useTopic(`worktrees:${canvas}`, mirror);
  const needs = useTopic(`needs:${canvas}`, mirror);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    setOutcome(undefined);
    try {
      await action();
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  if (!state?.kept.length) return null;
  return (
    <section className="kept-worktrees" aria-label={`Kept worktrees of ${name}`}>
      <h3>Kept worktrees</h3>
      <p>{name}</p>
      {state.kept.map((tree) => {
        const label = tree.name ?? tree.owner;
        return (
          <div className="kept-worktree" key={tree.workspace}>
            <strong>{label}</strong>
            <code title={tree.branch}>{tree.branch}</code>
            <span>{tree.state === 'removing' ? 'Removing' : 'Kept'}</span>
            <span className="workspace-location">{tree.location}</span>
            {tree.error && <p role="alert">{tree.error}</p>}
            <button
              type="button"
              disabled={busy || (tree.state === 'removing' && tree.error === null)}
              aria-label={`Remove ${label} worktree`}
              onClick={() => {
                void perform(async () => {
                  const result = await client.worktreeRemove({ canvas, worktree: tree.workspace });
                  if (result.retained)
                    setOutcome(
                      'The worktree changed and was kept. Review it before removing it again.',
                    );
                });
              }}
            >
              Remove…
            </button>
          </div>
        );
      })}
      {/* Proposals are already human-only and canvas-scoped. Never infer a cleanup target from prose. */}
      {(needs?.items ?? [])
        .filter((item) => item.kind === 'proposal')
        .map((item) => (
          <article key={item.id} className="graph-question" aria-label={item.title}>
            <p className="graph-question-text">{item.title}</p>
            {item.detail && <p className="graph-question-detail">{item.detail}</p>}
            <div className="graph-question-options">
              {item.choices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  disabled={busy}
                  title={choice.description}
                  onClick={() => {
                    void perform(async () => {
                      const result = await client.reply({
                        canvas,
                        to: item.id,
                        answer: { choice: choice.value },
                      });
                      setOutcome(result.outcome ?? 'Answered.');
                    });
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </article>
        ))}
      {problem && <p role="alert">{problem}</p>}
      {outcome && <p role="status">{outcome}</p>}
    </section>
  );
}
