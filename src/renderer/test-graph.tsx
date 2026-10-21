import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { newCanvasId } from '../shared/canvas';
import { GraphEditor as Editor } from './graph/GraphEditor';
import { documentOf, EMPTY_GRAPH } from './test-graph-data';
import type { Graph } from './graph/flow';
import type { RunSource } from './run/persistence';
import { fakeCanvas } from './test-canvas';
import type { FakeCanvas } from './test-canvas';

type Props = Omit<
  ComponentProps<typeof Editor>,
  'canvas' | 'client' | 'mirror' | 'initialSelection'
> & {
  initialGraph?: Graph;
  /** Hears the fake core the editor runs on: its operations, and its file and folder answers. */
  onCanvas?: (canvas: FakeCanvas) => void;
};
/**
 * An editor on its own fake canvas core (test-canvas.ts), which owns its document; its file bar
 * only given `files`.
 */
export function GraphEditor({
  initialGraph = EMPTY_GRAPH,
  files = false,
  runSource,
  onCanvas,
  ...props
}: Props) {
  const [canvas] = useState(() => {
    const made = fakeCanvas(documentOf(initialGraph, newCanvasId()));
    onCanvas?.(made);
    return made;
  });
  const [selection] = useState(() => ({
    nodes: new Set(initialGraph.nodes.filter((n) => n.selected).map((n) => n.id)),
    edges: new Set(initialGraph.edges.filter((e) => e.selected).map((e) => e.id)),
  }));
  const [source] = useState<RunSource>(() => {
    let initialized = false;
    return {
      get: async () => {
        const context = runSource
          ? await runSource.get()
          : { id: canvas.document.id, token: 'test', checkpoint: null };
        if (!initialized) {
          if (context.id !== canvas.document.id)
            canvas.open({ ...canvas.document, id: context.id });
          initialized = true;
        }
        return {
          id: canvas.document.id,
          token: context.token,
          checkpoint: context.checkpoint,
          ...(context.notices ? { notices: context.notices } : {}),
        };
      },
      save: (token, checkpoint) => runSource?.save(token, checkpoint) ?? Promise.resolve(null),
      ready: (request, error) => runSource?.ready(request, error) ?? Promise.resolve(null),
      onStopping: (listener) => runSource?.onStopping(listener) ?? (() => undefined),
    };
  });
  // Disposed once unmounted, not on StrictMode's rehearsal of an unmount, which mounts it again.
  const [disposal] = useState(() => ({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }));
  useEffect(() => {
    clearTimeout(disposal.timer);
    return () => {
      disposal.timer = setTimeout(() => {
        canvas.core.dispose();
      });
    };
  }, [canvas, disposal]);
  return (
    <Editor
      {...props}
      files={files}
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={selection}
      runSource={source}
    />
  );
}
