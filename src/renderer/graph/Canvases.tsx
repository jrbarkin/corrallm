import { useState } from 'react';

import type { CanvasId } from '../../shared/canvas';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import type { GuiApi } from '../../shared/gui-link';
import { KeptWorktrees } from '../workspaces/KeptWorktrees';

/** The core's kept canvases, most recent first. Independent of the canvas menu that hosts it. */
export function Canvases({
  canvas,
  mirror,
  onShow,
  onClose,
  client,
}: {
  canvas: CanvasId;
  mirror: TopicMirror;
  onShow: (canvas: CanvasId) => Promise<void>;
  onClose: (canvas: CanvasId, discard: boolean) => Promise<void>;
  client?: GuiApi;
}) {
  const state = useTopic('canvases', mirror);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [discard, setDiscard] = useState<{ canvas: CanvasId; name: string }>();
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="graph-canvases nodrag nopan"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          setDiscard(undefined);
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        Canvases
      </button>
      {open && (
        <section role="dialog" aria-label="Canvases" className="graph-canvases-list graph-panel">
          <header>
            <h2>Canvases</h2>
            <button
              type="button"
              aria-label="Close Canvases list"
              onClick={() => {
                setOpen(false);
              }}
            >
              ×
            </button>
          </header>
          {state === undefined ? (
            <p>Loading canvases…</p>
          ) : state.items.length === 0 ? (
            <p>No canvases kept.</p>
          ) : (
            <ul>
              {state.items.map((item) => {
                const name = item.name ?? 'Untitled';
                const id = item.canvas as CanvasId;
                return (
                  <li key={id}>
                    <strong>{name}</strong>
                    <div className="graph-canvases-state">
                      {item.edited && <span>Edited</span>}
                      {item.running && <span>Running</span>}
                      <span>{item.open ? 'Open' : 'Closed'}</span>
                      {id === canvas ? (
                        <span>Shown in this window</span>
                      ) : (
                        item.shownIn.length > 0 && (
                          <span>
                            Shown in {item.shownIn.length}{' '}
                            {item.shownIn.length === 1 ? 'window' : 'windows'}
                          </span>
                        )
                      )}
                      {item.project && <span title={item.project.path}>{item.project.name}</span>}
                    </div>
                    <div className="graph-canvases-actions">
                      <button
                        type="button"
                        disabled={busy || id === canvas}
                        aria-label={`Show ${name}`}
                        onClick={() => {
                          void act(async () => {
                            await onShow(id);
                            setOpen(false);
                          });
                        }}
                      >
                        Show
                      </button>
                      {item.open && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Close ${name}`}
                          title="Close, keeping its changes"
                          onClick={() => {
                            void act(() => onClose(id, false));
                          }}
                        >
                          Close
                        </button>
                      )}
                      {item.edited && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Discard changes and close ${name}`}
                          onClick={() => {
                            setDiscard({ canvas: id, name });
                          }}
                        >
                          Discard changes…
                        </button>
                      )}
                    </div>
                    <KeptWorktrees canvas={id} name={name} mirror={mirror} client={client} />
                  </li>
                );
              })}
            </ul>
          )}
          {problem && <p role="alert">{problem}</p>}
          {discard && (
            <div role="alertdialog" aria-label={`Discard changes to ${discard.name}?`}>
              <p>
                Discard changes to {discard.name}? A saved canvas returns to its file. A canvas
                never saved is forgotten.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDiscard(undefined);
                }}
              >
                Keep changes
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const target = discard;
                  setDiscard(undefined);
                  void act(() => onClose(target.canvas, true));
                }}
              >
                Discard changes
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
