import { useEffect } from 'react';

import { SHORTCUTS } from './keys';

/**
 * The canvas's file: its name (and whether it has changes not saved), with New, Open, Save, Save
 * As and the examples. Below it, a question before unsaved changes are discarded (`discarding`), or why the
 * last open or save failed (`problem`).
 */
export function FileBar({
  name,
  edited,
  problem,
  discarding,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExamples,
  onDiscard,
  onKeep,
  onDismiss,
}: {
  /** The file's name; undefined for a canvas never saved. */
  name: string | undefined;
  edited: boolean;
  problem: string | undefined;
  discarding: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExamples: () => void;
  onDiscard: () => void;
  /** Keeps the unsaved changes: what would have discarded them does not happen. */
  onKeep: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="graph-file-panel">
      <div className="graph-file graph-panel" role="toolbar" aria-label="Canvas file">
        <span className="graph-file-name" title={name ?? 'Untitled'}>
          {name ?? 'Untitled'}
        </span>
        {edited && <span className="graph-file-edited">Edited</span>}
        <button type="button" title={`A new canvas (${SHORTCUTS.new})`} onClick={onNew}>
          New
        </button>
        <button type="button" title={`Open a canvas (${SHORTCUTS.open})`} onClick={onOpen}>
          Open…
        </button>
        <button type="button" title={`Save (${SHORTCUTS.save})`} onClick={onSave}>
          Save
        </button>
        <button type="button" title={`Save to a new file (${SHORTCUTS.saveAs})`} onClick={onSaveAs}>
          Save as…
        </button>
        <button type="button" title="Open one of the examples" onClick={onExamples}>
          Templates…
        </button>
      </div>
      {discarding && <DiscardQuestion name={name} onDiscard={onDiscard} onKeep={onKeep} />}
      {problem !== undefined && (
        <p className="graph-file-problem graph-panel" role="alert">
          {problem}
          <button type="button" aria-label="Dismiss" onClick={onDismiss}>
            ×
          </button>
        </p>
      )}
    </div>
  );
}

function DiscardQuestion({
  name,
  onDiscard,
  onKeep,
}: {
  name: string | undefined;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onKeep();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onKeep]);
  return (
    <div
      className="graph-file-discard graph-panel"
      role="alertdialog"
      aria-modal="true"
      aria-label="Discard unsaved changes?"
    >
      <p>{name ?? 'This canvas'} has changes that are not saved.</p>
      <button type="button" onClick={onDiscard}>
        Discard
      </button>
      {/* Focused: the safe answer is the one Enter gives. */}
      <button type="button" autoFocus onClick={onKeep}>
        Cancel
      </button>
    </div>
  );
}
