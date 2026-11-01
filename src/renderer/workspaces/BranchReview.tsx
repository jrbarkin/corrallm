import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BranchDiffOutput, BranchFile, BranchMergeOutput } from '../../shared/api/branch';
import { ToolDetailView } from '../agent/ToolDetail';
import { ipcErrorMessage } from '../ipc-error';
import { Context, mergeMark, workspaceSharing, branchText } from './state';
import type { MergeInto } from './state';
import './BranchReview.css';

const branchName = (ref: string) => branchText(ref.replace(/^refs\/heads\//, ''));
const destinationName = (into: MergeInto | null | undefined) =>
  into?.ref ? branchName(into.ref) : 'your checkout';

/** The same gestures on a card's hover controls, session header and All queues lane head. */
export function BranchControls({ agent }: { agent: string }) {
  const context = useContext(Context);
  if (!context?.onBranch) return null;
  const merging =
    context.state?.items.find((item) => item.agent === agent)?.merge?.job === 'merging';
  return (
    <span
      className="branch-controls nodrag nopan"
      onClick={(event) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        disabled={context.inert}
        onClick={() => {
          context.onBranch?.(agent, false);
        }}
      >
        Review changes
      </button>
      <button
        type="button"
        disabled={(context.inert ?? false) || merging}
        onClick={() => {
          context.onBranch?.(agent, true);
        }}
      >
        Merge into {destinationName(context.state?.into)}…
      </button>
    </span>
  );
}

/** A review keeps only the pages the user read, never an independent workspace/merge model. */
export function BranchReview({
  agent,
  merge,
  into: offeredInto,
  onClose,
}: {
  agent: string;
  merge: boolean;
  into: MergeInto | null;
  onClose: () => void;
}) {
  const context = useContext(Context);
  if (!context) throw new Error('A branch review needs its canvas.');
  const { canvas, client, nodes, state, inert = false } = context;
  const label = nodes.find((node) => node.id === agent)?.data.label;
  const name = label?.length ? branchText(label) : 'Agent';
  const item = state?.items.find((item) => item.agent === agent);
  const panel = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const initial = useRef<Promise<BranchDiffOutput> | undefined>(undefined);
  const locked = useRef(true);
  const [pages, setPages] = useState<BranchDiffOutput[]>([]);
  const [busy, setBusy] = useState<'read' | 'merge' | null>('read');
  const [problem, setProblem] = useState<string>();
  const [stale, setStale] = useState(false);
  const [choice, setChoice] = useState<'leave' | 'commit'>();
  const [outcome, setOutcome] = useState<BranchMergeOutput>();
  const [target, setTarget] = useState(offeredInto);
  const first = pages[0];
  const last = pages.at(-1);
  const into = target?.ref && target.oid ? target : first?.into;
  const canPin = into?.ref !== null && into?.ref !== undefined && into.oid !== null;
  const dirty = !!first && first.uncommitted.changed + first.uncommitted.untracked > 0;
  const digest = first?.uncommitted.digest;
  const blocked =
    inert ||
    busy !== null ||
    stale ||
    !first ||
    !canPin ||
    (dirty && (!choice || (choice === 'commit' && !digest))) ||
    outcome !== undefined ||
    item?.merge?.job === 'merging';

  useLayoutEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    // StrictMode rehearses this effect. The same opening still makes one read.
    initial.current ??= client.branchDiff({ canvas, agent });
    void initial.current
      .then(
        (page) => {
          if (live) setPages([page]);
        },
        (error: unknown) => {
          if (live) setProblem(ipcErrorMessage(error));
        },
      )
      .finally(() => {
        if (live) {
          locked.current = false;
          setBusy(null);
        }
      });
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [agent, canvas, client]);

  const read = async (after?: string) => {
    if (locked.current || inert) return;
    locked.current = true;
    setBusy('read');
    setProblem(undefined);
    try {
      const page = await client.branchDiff({ canvas, agent, ...(after ? { after } : {}) });
      if (!mounted.current) return;
      if (after) setPages((previous) => [...previous, page]);
      else {
        setPages([page]);
        setChoice(undefined);
        setOutcome(undefined);
        setStale(false);
        // Refresh is an explicit new review, including the destination it displays.
        setTarget(page.into);
      }
    } catch (error) {
      if (mounted.current) {
        setProblem(ipcErrorMessage(error));
        setStale(true);
      }
    } finally {
      if (mounted.current) {
        locked.current = false;
        setBusy(null);
      }
    }
  };
  const confirm = async () => {
    if (!first || !into?.ref || !into.oid || locked.current || blocked) return;
    locked.current = true;
    setBusy('merge');
    setProblem(undefined);
    try {
      const result = await client.branchMerge({
        canvas,
        agent,
        source: { ref: first.source.ref, oid: first.source.oid },
        into: { ref: into.ref, oid: into.oid },
        ...(dirty && choice
          ? {
              uncommitted:
                choice === 'commit' && digest
                  ? { choice: 'commit' as const, digest }
                  : { choice: 'leave' as const },
            }
          : {}),
        request: crypto.randomUUID(),
      });
      if (mounted.current) setOutcome(result);
    } catch (error) {
      if (mounted.current) {
        setProblem(ipcErrorMessage(error));
        setStale(true);
      }
    } finally {
      if (mounted.current) {
        locked.current = false;
        setBusy(null);
      }
    }
  };

  return createPortal(
    <div
      className="branch-backdrop"
      inert={inert}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
        if (event.key === 'Tab') {
          const buttons = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)',
            ) ?? []),
          ];
          const first = buttons[0],
            last = buttons.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === panel.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div
        className="branch-review"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={merge ? `Merge ${name}’s changes` : `${name}’s changes`}
        tabIndex={-1}
      >
        <header>
          <h2>{merge ? `Merge ${name}’s changes` : `${name}’s changes`}</h2>
          <button type="button" onClick={onClose}>
            Close review
          </button>
        </header>
        {item && <p>{branchText(workspaceSharing(item, nodes))}</p>}
        {item?.state === 'pending-change' && (
          <p>Reviewing the active worktree while its workspace change waits.</p>
        )}
        {item?.merge?.job && busy !== 'merge' && (
          <p role="status">
            {mergeMark(item.merge)}
            {item.merge.sentence && `: ${item.merge.sentence}`}
          </p>
        )}
        {busy && <p role="status">{busy === 'merge' ? 'merging…' : 'Reading changes…'}</p>}
        {problem && (
          <p role="alert" className="branch-sentence">
            {problem}
          </p>
        )}
        {outcome && (
          <div role="status" className="branch-sentence">
            <p>
              {outcome.outcome === 'merged' ? 'Merged' : 'Already merged'} into{' '}
              {branchName(outcome.into.ref)}.
            </p>
            {outcome.outcome === 'merged' && (
              <p>
                Merge commit: <code>{outcome.mergeCommit}</code>. The commit uses your Git identity
                and a Corrallm-Requested-By: trailer; hooks and signing do not run.
              </p>
            )}
            {outcome.outcome === 'merged' && outcome.checkpointRecorded === false && (
              <p>
                The checkpoint could not be recorded on the source branch. Its files keep the work
                uncommitted.
              </p>
            )}
          </div>
        )}
        {first && (
          <>
            <p>
              Source: <code>{branchName(first.source.ref)}</code> · <code>{first.source.oid}</code>
            </p>
            <p>
              Compared with:{' '}
              <code>{first.base.ref ? branchName(first.base.ref) : 'recorded base'}</code> ·{' '}
              <code>{first.base.oid}</code>
            </p>
            <p>
              Merge destination: <code>{destinationName(into)}</code> ·{' '}
              <code>{into?.oid ?? 'unknown commit'}</code>
            </p>
            {!first.source.onBranch && (
              <p>
                The worktree is not on its generated branch. Uncommitted changes are unavailable in
                this review.
              </p>
            )}
            {(['committed', 'uncommitted'] as const).map((section) => (
              <section
                key={section}
                aria-label={section === 'committed' ? 'Committed changes' : 'Uncommitted changes'}
              >
                <h3>{section === 'committed' ? 'Committed' : 'Uncommitted'}</h3>
                <p>
                  {section === 'committed'
                    ? `${String(first.committed.files)} files`
                    : `${String(first.uncommitted.changed)} changed · ${String(first.uncommitted.untracked)} untracked · ${String(first.uncommitted.partlyStaged)} partly staged`}
                  {!(section === 'committed'
                    ? first.committed.complete
                    : first.uncommitted.complete) && ' · inventory is incomplete'}
                </p>
                {pages
                  .flatMap((page) => page.files)
                  .filter((file) => file.section === section)
                  .map((file, i) => (
                    <ReviewFile key={`${String(i)}/${file.path}`} file={file} />
                  ))}
              </section>
            ))}
            {last?.next && (
              <button
                type="button"
                disabled={busy !== null || stale}
                onClick={() => {
                  void read(last.next ?? undefined);
                }}
              >
                Load more changes
              </button>
            )}
            {dirty && (
              <fieldset disabled={busy !== null || stale || outcome !== undefined}>
                <legend>Uncommitted work</legend>
                <label>
                  <input
                    type="radio"
                    name="branch-uncommitted"
                    checked={choice === 'leave'}
                    onChange={() => {
                      setChoice('leave');
                    }}
                  />
                  Merge commits without uncommitted work
                </label>
                <label>
                  <input
                    type="radio"
                    name="branch-uncommitted"
                    checked={choice === 'commit'}
                    disabled={!digest}
                    onChange={() => {
                      setChoice('commit');
                    }}
                  />
                  Commit uncommitted work on its branch first
                </label>
                <p>
                  A checkpoint saves the work on the agent’s branch before merging; it uses
                  corrallm’s identity. Files stay intact, but index staging is reset. The source
                  branch and worktree are kept.
                </p>
                {!digest && (
                  <p>
                    This review has no complete checkpoint digest; only its commits can be merged.
                  </p>
                )}
              </fieldset>
            )}
            {!canPin && (
              <p>
                A branch and commit for the destination are unavailable. Check your checkout, then
                refresh the review.
              </p>
            )}
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                void confirm();
              }}
            >
              Merge into {destinationName(into)}
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            void read();
          }}
        >
          Refresh review
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Git's patch text stays escaped; color only the ordinary unified-diff line prefixes. */
function ReviewFile({ file }: { file: BranchFile }) {
  const lines = file.patch?.split('\n') ?? [];
  if (lines.at(-1) === '') lines.pop();
  return (
    <article className="branch-file">
      <h4>
        {file.oldPath && (
          <>
            <span>{branchText(file.oldPath)}</span> →{' '}
          </>
        )}
        <span>{branchText(file.path)}</span>
      </h4>
      <p>
        {file.status}
        {file.staged === undefined ? '' : file.staged ? ' · Staged' : ' · Unstaged'}
        {file.note && ` · ${file.note}`}
        {file.mode && ` · ${file.mode.old ?? 'none'} → ${file.mode.new ?? 'none'}`}
      </p>
      {file.binary && <p>Binary file</p>}
      {file.patch !== undefined && (
        <ToolDetailView
          verbatim
          detail={{
            kind: 'diff',
            added: 0,
            removed: 0,
            lines: lines.map((line) => ({
              kind:
                line.startsWith('+') && !line.startsWith('+++')
                  ? ('add' as const)
                  : line.startsWith('-') && !line.startsWith('---')
                    ? ('remove' as const)
                    : ('same' as const),
              text: branchText(line, true),
            })),
          }}
        />
      )}
      {file.cut && <p>Patch cut</p>}
    </article>
  );
}
