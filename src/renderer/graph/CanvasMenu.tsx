import type { ReactNode } from 'react';
import type { ProjectFolder } from '../../shared/ipc';
import { SHORTCUTS } from './keys';
import { FloatPopover } from './FloatPopover';

/** Canvas commands and folder, in the top-left float. The kept-canvases list is passed intact. */
export function CanvasMenu({
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
  canvases,
}: {
  name: string | undefined;
  edited: boolean;
  project?: { folder: ProjectFolder | null; onChoose: () => void };
  problem: string | undefined;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExamples: () => void;
  onDismiss: () => void;
  canvases?: ReactNode;
}) {
  return (
    <div className="canvas-float-position">
      <div className="canvas-float graph-float" role="toolbar" aria-label="Canvas file">
        <FloatPopover
          label="Canvas menu"
          className="canvas-menu"
          button={
            <>
              <span aria-hidden="true">≡</span>
              <span className="graph-file-name" title={name ?? 'Untitled'}>
                {name ?? 'Untitled'}
              </span>
              {edited && <span className="graph-file-edited">Edited</span>}
              <span aria-hidden="true">▾</span>
            </>
          }
        >
          {(close) => (
            <>
              {(
                [
                  ['New', SHORTCUTS.new, onNew],
                  ['Open…', SHORTCUTS.open, onOpen],
                  ['Save', SHORTCUTS.save, onSave],
                  ['Save as…', SHORTCUTS.saveAs, onSaveAs],
                ] as const
              ).map(([label, shortcut, action]) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  title={`${label} (${shortcut})`}
                  onClick={() => {
                    close();
                    action();
                  }}
                >
                  {label}
                  <kbd>{shortcut}</kbd>
                </button>
              ))}
              {canvases}
            </>
          )}
        </FloatPopover>
        {project && (
          <button
            type="button"
            className="canvas-folder"
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
            {project.folder?.name ?? 'Choose a project folder…'}
          </button>
        )}
        <span className="float-separator canvas-templates" />
        <button
          type="button"
          className="canvas-templates"
          title="Open one of the examples"
          onClick={onExamples}
        >
          Templates…
        </button>
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
