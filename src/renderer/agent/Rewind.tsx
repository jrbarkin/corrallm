import { useEffect, useRef, useState } from 'react';

import type { FilesRewind, RewindRestore, RewindResult } from '../../shared/session';
import { ipcErrorMessage } from '../ipc-error';
import { SearchPicker } from '../search/SearchPicker';
import { threadTitle } from '../../shared/model/session';

/** A message of the user's it can rewind to. */
export interface RewindPoint {
  id: string;
  text: string;
}

/**
 * Rewinding an Agent SDK agent to before one of the user's messages, above its composer, as
 * Claude Code's Esc Esc does: which message (when not picked already, with "Rewind to here"), then
 * what it would restore, previewed ("Restores src/cart.ts (+4 −10)", and that the message and
 * what followed go, the message back in the box to edit), and the choice: code and conversation,
 * the conversation, or the code (the code only where files changed and can be restored), or
 * Cancel. Esc closes it.
 */
export function Rewind({
  messages,
  start,
  preview,
  rewind,
  onRewound,
  onClose,
}: {
  /** The user's messages, oldest first. */
  messages: readonly RewindPoint[];
  /** The message picked already, if any: otherwise it asks which. */
  start: string | undefined;
  preview: (messageId: string) => Promise<FilesRewind>;
  rewind: (messageId: string, restore: RewindRestore) => Promise<RewindResult>;
  /** It rewound to before `point`. */
  onRewound: (point: RewindPoint, result: RewindResult) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(start);
  const point = messages.find((message) => message.id === picked);
  return (
    <div
      className="agent-offer agent-rewind"
      role="group"
      aria-label="Rewind"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Only the panel closes, not the view.
        event.stopPropagation();
        onClose();
      }}
    >
      {point === undefined ? (
        <SearchPicker
          label="Rewind to"
          options={[...messages].reverse()}
          optionLabel={(message) => threadTitle(message.text, 80)}
          optionKey={(message) => message.id}
          placeholder="Rewind to before which message?"
          onPick={(message) => {
            setPicked(message.id);
          }}
          onCancel={onClose}
        />
      ) : (
        <Confirm
          key={point.id}
          point={point}
          after={messages.length - 1 - messages.indexOf(point)}
          preview={preview}
          rewind={rewind}
          onRewound={onRewound}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/** What rewinding to before `point` restores, and the choice of what to restore. */
function Confirm({
  point,
  after,
  preview,
  rewind,
  onRewound,
  onClose,
}: {
  point: RewindPoint;
  /** How many of the user's messages came after it. */
  after: number;
  preview: (messageId: string) => Promise<FilesRewind>;
  rewind: (messageId: string, restore: RewindRestore) => Promise<RewindResult>;
  onRewound: (point: RewindPoint, result: RewindResult) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FilesRewind | { failed: string }>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  /** Previewed once, when it opens. */
  const previewed = useRef(preview);
  useEffect(() => {
    let current = true;
    previewed.current(point.id).then(
      (found) => {
        if (current) setFiles(found);
      },
      (error: unknown) => {
        if (current) setFiles({ failed: ipcErrorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [point.id]);

  const code =
    files !== undefined && 'possible' in files && files.possible && files.files.length > 0;
  const restore = (what: RewindRestore) => {
    setBusy(true);
    setProblem(undefined);
    rewind(point.id, what).then(
      (result) => {
        onRewound(point, result);
        onClose();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(ipcErrorMessage(error));
      },
    );
  };
  const choice = (what: RewindRestore, label: string, primary = false) => (
    <button
      type="button"
      disabled={busy || files === undefined}
      {...(primary ? { 'data-primary': '' } : {})}
      onClick={() => {
        restore(what);
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      <p>
        <strong>Rewind to before “{threadTitle(point.text, 60)}”?</strong>
      </p>
      <p>{filesLine(files)}</p>
      <p>
        {after === 0
          ? 'Drops this message and what followed: it goes back in the box below, to edit.'
          : `Drops this message and the ${String(after)} after it: it goes back in the box below, to edit.`}
      </p>
      {problem !== undefined && <p role="alert">{problem}</p>}
      {code ? (
        <>
          {choice('both', 'Restore code and conversation', true)}
          {choice('conversation', 'Restore conversation')}
          {choice('code', 'Restore code')}
        </>
      ) : (
        choice('conversation', 'Restore conversation', true)
      )}
      <button type="button" autoFocus onClick={onClose}>
        Cancel
      </button>
    </>
  );
}

/** What it would do to the files, in a line. */
function filesLine(files: FilesRewind | { failed: string } | undefined): string {
  if (files === undefined) return 'Checking which files it would restore…';
  if ('failed' in files) return `Its files can’t be checked: ${files.failed}`;
  if (!files.possible) {
    return `Its files can’t be restored${files.error === undefined ? '.' : `: ${files.error}.`}`;
  }
  if (files.files.length === 0) return 'No files changed since then.';
  const counts = `+${String(files.added)} −${String(files.removed)}`;
  const named =
    files.files.length <= 3
      ? files.files.join(', ')
      : `${files.files.slice(0, 3).join(', ')} and ${String(files.files.length - 3)} more`;
  return `Restores ${named} (${counts}).`;
}
