import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { newCanvasId } from '../shared/canvas';
import { GraphEditor as Editor } from './graph/GraphEditor';
import { documentOf, EMPTY_GRAPH } from './test-graph-data';
import type { Graph } from './graph/flow';
import type { SessionReplies } from './test-sessions';
import { fakeCanvas } from './test-canvas';
import type { FakeCanvas } from './test-canvas';

const mounted = new WeakSet<FakeCanvas>();

type Props = Omit<
  ComponentProps<typeof Editor>,
  'canvas' | 'client' | 'mirror' | 'initialSelection'
> & {
  initialGraph?: Graph;
  sessionReplies?: SessionReplies;
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
  sessionReplies,
  usageSource,
  onCanvas,
  ...props
}: Props) {
  const [canvas] = useState(() => {
    const made = fakeCanvas(documentOf(initialGraph, newCanvasId()), sessionReplies, usageSource);
    // React rehearses state initializers too. An unused fixture must release its subscriptions.
    queueMicrotask(() => {
      if (!mounted.has(made)) made.core.dispose();
    });
    return made;
  });
  const [selection] = useState(() => ({
    nodes: new Set(initialGraph.nodes.filter((n) => n.selected).map((n) => n.id)),
    edges: new Set(initialGraph.edges.filter((e) => e.selected).map((e) => e.id)),
  }));
  // Disposed once unmounted, not on StrictMode's rehearsal of an unmount, which mounts it again.
  const [disposal] = useState(() => ({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }));
  useEffect(() => {
    mounted.add(canvas);
    onCanvas?.(canvas);
    clearTimeout(disposal.timer);
    return () => {
      disposal.timer = setTimeout(() => {
        canvas.core.dispose();
      });
    };
  }, [canvas, disposal, onCanvas]);
  return (
    <Editor
      {...props}
      usageSource={canvas.usageSource}
      files={files}
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={selection}
    />
  );
}
