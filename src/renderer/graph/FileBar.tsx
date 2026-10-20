import type { ReactNode } from 'react';

import type { ProjectFolder } from '../../shared/ipc';
import { SHORTCUTS } from './keys';

/**
 * The canvas's file: its name (and whether it has changes not saved), with New, Open, Save, Save
 * As and the examples, and (given `project`) the folder its agents work in, which a click
 * changes, with `extra` beside it (the usage gauges). Below it, why the last open or save failed
 * (`problem`).
 */
export function FileBar({
  name,
  edited,
  project,
  problem,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExamples,
  onDismiss,
  extra,
}: {
  /** The file's name; undefined for a canvas never saved. */
  name: string | undefined;
  edited: boolean;
  /** The folder the canvas's agents work in (null: none chosen yet), and what chooses another. */
  project?: { folder: ProjectFolder | null; onChoose: () => void };
  problem: string | undefined;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExamples: () => void;
  onDismiss: () => void;
  /** Shown beside the project folder. */
  extra?: ReactNode;
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
      <div className="graph-file-row">
        {project && (
          <button
            type="button"
            className="graph-file-project graph-panel"
            data-chosen={project.folder ? '' : undefined}
            aria-label={
              project.folder ? `Project folder: ${project.folder.name}` : 'Choose a project folder'
            }
            title={
              project.folder
                ? `${project.folder.path}\nWhere this canvas's agents work. Click to choose another folder.`
                : "Choose the folder this canvas's agents work in"
            }
            onClick={project.onChoose}
          >
            <span className="graph-file-project-name">
              {project.folder ? project.folder.name : 'Choose a project folder…'}
            </span>
          </button>
        )}
        {extra}
      </div>
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
