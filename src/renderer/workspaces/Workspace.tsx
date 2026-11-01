import { useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { CanvasNode } from '../../shared/model/canvas';
import { MAX_SETUP_COMMAND_BYTES, UNSEEN_IN_COMMAND } from '../../shared/model/worktree-setup';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';
import {
  Context,
  useWorkspace,
  workspaceAttention,
  workspaceState,
  workspaceSharing,
  mergeMark,
  branchText,
} from './state';
import type { Workspace, MergeInto } from './state';
import { BranchReview } from './BranchReview';
import './Workspace.css';

/** Only the topic owns workspace state. The short-lived notice remembers a visual transition. */
export function WorkspaceProvider({
  canvas,
  mirror,
  client,
  nodes,
  onNeed,
  children,
  inert = false,
}: {
  canvas: CanvasId;
  mirror: TopicMirror;
  client: GuiApi;
  nodes: readonly CanvasNode[];
  onNeed: (id: string) => void;
  children: ReactNode;
  inert?: boolean;
}) {
  const state = useTopic(`worktrees:${canvas}`, mirror);
  const needs = useTopic(`needs:${canvas}`, mirror);
  const [review, setReview] = useState<{
    canvas: CanvasId;
    agent: string;
    merge: boolean;
    into: MergeInto | null;
    key: string;
  }>();
  // Returning to a canvas never reopens a review or reads again without a new gesture.
  if (review && review.canvas !== canvas) setReview(undefined);
  return (
    <Context
      value={{
        canvas,
        client,
        state,
        nodes,
        onNeed,
        needs,
        inert,
        onBranch: (agent, merge) => {
          if (!inert)
            setReview({
              canvas,
              agent,
              merge,
              into: state?.into ?? null,
              key: crypto.randomUUID(),
            });
        },
      }}
    >
      {children}
      <SetupFinished key={canvas} canvas={canvas} mirror={mirror} />
      {review?.canvas === canvas && (
        <BranchReview
          key={review.key}
          agent={review.agent}
          merge={review.merge}
          into={review.into}
          onClose={() => {
            setReview(undefined);
          }}
        />
      )}
    </Context>
  );
}

/** Transient presentation only: no copied workspace objects and no completion on first load. */
function SetupFinished({ canvas, mirror }: { canvas: CanvasId; mirror: TopicMirror }) {
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    const topic = `worktrees:${canvas}` as const;
    const pending = () =>
      new Set(
        (mirror.snapshot(topic)?.items ?? [])
          .filter(
            (item) =>
              item.setup !== undefined &&
              item.setup.state !== 'done' &&
              item.setup.state !== 'skipped',
          )
          .map((item) => `${item.workspace ?? 'unmade'}/${String(item.generation)}`),
      );
    let unfinished = pending();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A transient notification follows an external topic event, not a second workspace store.
    const unsubscribe = mirror.subscribe(topic, () => {
      const completed = mirror
        .snapshot(topic)
        ?.items.some(
          (item) =>
            item.workspace !== null &&
            item.setup?.state === 'done' &&
            unfinished.has(`${item.workspace}/${String(item.generation)}`),
        );
      unfinished = pending();
      if (completed) {
        setFinished(true);
        clearTimeout(timer);
        timer = setTimeout(() => {
          setFinished(false);
        }, 6000);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [canvas, mirror]);
  return finished ? (
    <p className="workspace-toast" role="status">
      Worktree setup finished.
    </p>
  ) : null;
}

/** A compact mark beside the existing run status, never a replacement for that status. */
export function WorkspaceBadge({ agent, card = false }: { agent: string; card?: boolean }) {
  const context = useContext(Context);
  const item = useWorkspace(agent);
  if (!context || !item) return null;
  const need = item.need;
  const state = workspaceState(item);
  const branch = branchText(
    item.branch ?? (item.mode === 'shared-folder' ? 'Shared folder' : state),
  );
  const mark = mergeMark(item.merge);
  const history = context.state?.into?.ref
    ? branchText(context.state.into.ref.replace(/^refs\/heads\//, ''))
    : undefined;
  const explanation = item.merge?.merged
    ? `its commits are in ${history ? `${history}’s` : 'your checkout’s'} history`
    : undefined;
  const title = [
    item.branch && branchText(item.branch),
    workspaceSharing(item, context.nodes),
    state,
    explanation,
    item.merge?.sentence,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      className={`workspace-badge${card ? ' workspace-badge-card' : ''}`}
      data-workspace-attention={workspaceAttention(item) ? '' : undefined}
      title={title}
    >
      <span title={title}>{branch}</span>
      {mark && (
        <small className="workspace-merge-state" title={title}>
          {mark}
        </small>
      )}
      {!card && item.branch && <small>{state}</small>}
      {need && (
        <button
          type="button"
          className="nodrag nopan"
          aria-label={item.state === 'pending-change' ? 'Review workspace change' : 'Review setup'}
          title={state}
          onClick={(event) => {
            event.stopPropagation();
            context.onNeed(need);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
        >
          {item.state === 'pending-change' ? 'Switch' : 'Setup'}
        </button>
      )}
      {!item.need && workspaceAttention(item) && (
        <span aria-label={state}>{attentionWord(item)}</span>
      )}
    </span>
  );
}

/**
 * The one word for an attention state with no card to open. A tree in setup has none until the
 * core has copied its local files and detected the command to offer: that wait is not a failure.
 */
function attentionWord(item: Workspace): string {
  if (item.state === 'missing') return 'Missing';
  if (item.state === 'setup') return 'Preparing';
  return 'Failed';
}

/** Why a session cannot start yet, with navigation to the actual core-owned decision. */
export function WorkspaceWait({ agent }: { agent: string }) {
  const context = useContext(Context);
  const item = useWorkspace(agent);
  if (!context || !item || (!workspaceAttention(item) && item.state !== 'creating')) return null;
  return (
    <div className="workspace-wait">
      <p>{workspaceState(item)}</p>
      <WorkspaceAction item={item} />
    </div>
  );
}

function WorkspaceAction({ item }: { item: Workspace }) {
  const context = useContext(Context);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (!context) return null;
  const need = item.need;
  if (need)
    return (
      <button
        type="button"
        onClick={() => {
          context.onNeed(need);
        }}
      >
        {item.state === 'pending-change' ? 'Review workspace change' : 'Review setup'}
      </button>
    );
  if (item.state !== 'missing' && item.state !== 'error') return null;
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setProblem(undefined);
          void context.client
            .worktreeRetry({ canvas: context.canvas, agent: item.agent })
            .catch((error: unknown) => {
              setProblem(ipcErrorMessage(error));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        Retry worktree
      </button>
      {problem && <p role="alert">{problem}</p>}
    </>
  );
}

/** Read-only directory details; grouping, never an editable path, determines sharing. */
export function WorkspaceDetails({ agent }: { agent: string }) {
  const context = useContext(Context);
  const item = useWorkspace(agent);
  if (!context || !item) return null;
  const need = context.needs?.items.find((need) => need.id === item.need);
  return (
    <section className="workspace-details" aria-label="Works in">
      <h3>Works in</h3>
      <p>{workspaceSharing(item, context.nodes)}</p>
      {item.location && <p className="workspace-location">{item.location}</p>}
      {item.branch && <p title={item.branch}>{item.branch}</p>}
      <p>{workspaceState(item)}</p>
      {item.error && <p role="alert">{item.error}</p>}
      {item.state === 'pending-change' && (
        <p>The current worktree keeps its work until you switch. {need?.title}</p>
      )}
      {item.setup && (
        <p>
          Setup: {item.setup.state}
          {item.setup.command !== null && (
            <>
              {' '}
              · <code>{item.setup.command}</code>
            </>
          )}
        </p>
      )}
      <WorkspaceAction item={item} />
      <p className="agent-settings-help">
        Group agents to share a worktree. Nested groups share their outermost group’s tree.
      </p>
      {item.mode !== 'shared-folder' && item.state !== 'no-project' && <SetupCommand />}
    </section>
  );
}

/** A draft command is view state. Only C accepts and stores repository setup policy. */
function SetupCommand() {
  const context = useContext(Context);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  if (!context) return null;
  const { canvas, client } = context;
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setProblem(undefined);
    setOutcome(undefined);
    try {
      await action();
      setOutcome(message);
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="workspace-setup-command">
      <summary>Repository setup</summary>
      <p>
        One command for new worktrees in this repository. Changing it clears Always and offers
        waiting setups again.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !command ||
            UNSEEN_IN_COMMAND.test(command) ||
            new TextEncoder().encode(command).length > MAX_SETUP_COMMAND_BYTES
          ) {
            setProblem('Use one visible line of at most 4 KiB.');
            return;
          }
          void perform(
            () => client.projectSetSetupCommand({ canvas, command }),
            'Setup command saved. Review the command on its setup card before running it.',
          );
        }}
      >
        <label>
          Setup command
          <input
            aria-label="Setup command"
            value={command}
            maxLength={MAX_SETUP_COMMAND_BYTES}
            onChange={(event) => {
              setCommand(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          Save setup command
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void perform(
              () => client.projectSetSetupCommand({ canvas, command: null }),
              'Using the detected setup command.',
            );
          }}
        >
          Use detected command
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void perform(
              () => client.projectClearSetupApproval({ canvas }),
              'Future setups will ask again. A running setup continues.',
            );
          }}
        >
          Ask before future setups
        </button>
      </form>
      {problem && <p role="alert">{problem}</p>}
      {outcome && <p role="status">{outcome}</p>}
    </details>
  );
}
