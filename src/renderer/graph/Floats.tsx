import type { ReactNode } from 'react';
import type { Run } from '../../shared/engine/run/runner';

/** Global run controls stay renderer-owned until B11. All queues moves to the dock next. */
export function RunFloat({
  run,
  working,
  needs,
  gauges,
  queuesOpen = false,
  onRun,
  onPause,
  onStop,
  onResume,
  onQueues,
}: {
  run: Run;
  working: number;
  needs: ReactNode;
  gauges: ReactNode;
  queuesOpen?: boolean;
  onRun: () => void;
  onPause: () => void;
  onStop: () => void;
  onResume: () => void;
  onQueues: () => void;
}) {
  return (
    <div className="run-float graph-float" role="toolbar" aria-label="Run controls">
      {!queuesOpen && (
        <>
          <span className="float-run-state">
            {run.running ? `Running · ${String(working)} working` : run.paused ? 'Paused' : 'Ready'}
          </span>
          {run.running && (
            <button
              type="button"
              aria-label="Pause"
              title="Pause the run; in-flight work is held for inspection"
              onClick={onPause}
            >
              Ⅱ
            </button>
          )}
          {run.paused && (
            <button
              type="button"
              aria-label="Resume"
              title="Resume this run from its saved tasks"
              onClick={onResume}
            >
              ▶
            </button>
          )}
          {(run.running || run.paused) && (
            <button
              type="button"
              aria-label="Stop"
              title="Stop every queue where it is"
              onClick={onStop}
            >
              ■
            </button>
          )}
          <button
            type="button"
            aria-label={run.running || run.paused ? 'Run again' : 'Run'}
            title="Run every queue from the top"
            onClick={onRun}
          >
            {run.running || run.paused ? '↻' : '▶'}
          </button>
          <button
            type="button"
            aria-label="Show all queues"
            title="All queues: every agent’s, side by side"
            onClick={onQueues}
          >
            ▥
          </button>
          <span className="float-separator" />
        </>
      )}
      {needs}
      {!queuesOpen && <div className="float-usage">{gauges}</div>}
    </div>
  );
}

/** View-only zoom and the document's Arrange preference, together at the bottom right. */
export function ZoomFloat({
  zoom,
  arranging,
  onIn,
  onOut,
  onFit,
  onArrange,
}: {
  zoom: number;
  arranging: boolean;
  onIn: () => void;
  onOut: () => void;
  onFit: () => void;
  onArrange: () => void;
}) {
  return (
    <div className="zoom-float graph-float" role="toolbar" aria-label="Canvas zoom">
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={onOut}>
        −
      </button>
      <span className="float-zoom-level">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={onIn}>
        +
      </button>
      <button type="button" aria-label="Fit view" title="Fit the canvas" onClick={onFit}>
        ⤢
      </button>
      <span className="float-separator" />
      <button
        type="button"
        className="graph-arrange"
        aria-label="Arrange automatically"
        aria-pressed={arranging}
        title={
          arranging ? 'Arranging automatically. Click to arrange by hand.' : 'Arrange automatically'
        }
        onClick={onArrange}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 1h4v3H6zM1 11h4v3H1zM11 11h4v3h-4zM7.5 4h1v2.5h5V11h-1V7.5h-9V11h-1V6.5h5z" />
        </svg>
      </button>
    </div>
  );
}
