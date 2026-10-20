import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { newCanvasId } from '../shared/canvas';
import { fromFile, toFile } from '../shared/model/file';
import { catalog } from './catalog';
import { GraphEditor as Editor } from './graph/GraphEditor';
import type { CanvasFiles } from './graph/GraphEditor';
import { DEFAULT_AGENT } from './graph/agents';
import { documentOf, EMPTY_GRAPH } from './test-graph-data';
import type { Graph } from './graph/flow';
import type { RunSource } from './run/persistence';
import { fakeCanvas, emptyCanvas } from './test-canvas';

type Props = Omit<
  ComponentProps<typeof Editor>,
  'canvas' | 'client' | 'mirror' | 'initialSelection'
> & { initialGraph?: Graph };
/** Existing session/queue tests use a canvas core too; only the fake owns its document. */
export function GraphEditor({ initialGraph = EMPTY_GRAPH, files, runSource, ...props }: Props) {
  const [canvas] = useState(() => fakeCanvas(documentOf(initialGraph, newCanvasId())));
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
          : { id: canvas.document.id, token: 'test', checkpoint: null, name: null };
        if (!initialized) {
          if (context.document) canvas.open(fromFile(context.document, catalog(), DEFAULT_AGENT));
          else if (context.id !== canvas.document.id)
            canvas.open({ ...canvas.document, id: context.id });
          canvas.meta({ name: context.name, project: context.project ?? null });
          initialized = true;
        }
        return { ...context, document: toFile(canvas.document) };
      },
      save: async (token, checkpoint, text, rev) => {
        await runSource?.save(token, checkpoint, text, rev);
        return canvas.edit(text, rev);
      },
      ready: (request, error) => runSource?.ready(request, error) ?? Promise.resolve(null),
      onStopping: (listener) => runSource?.onStopping(listener) ?? (() => undefined),
    };
  });
  const [fileSource] = useState<CanvasFiles | undefined>(
    () =>
      files && {
        open: async () => {
          const file = await files.open();
          if (file) {
            canvas.open(fromFile(file.text, catalog(), DEFAULT_AGENT));
            canvas.meta({ name: file.name, project: file.project ?? null });
          }
          return file;
        },
        forget: async () => {
          const id = await files.forget();
          canvas.open(emptyCanvas(id));
          canvas.meta({ name: null, project: null });
          return id;
        },
        save: async (text, choose, rev) => {
          const name = await files.save(text, choose, rev);
          if (name !== null) {
            await canvas.edit(text, rev);
            canvas.meta({ name, edited: false });
          }
          return name;
        },
        ...(files.chooseProject
          ? {
              chooseProject: async () => {
                const project = await files.chooseProject?.();
                if (project) canvas.meta({ project });
                return project ?? null;
              },
            }
          : {}),
      },
  );
  useEffect(
    () => () => {
      canvas.core.dispose();
    },
    [canvas],
  );
  return (
    <Editor
      {...props}
      {...(fileSource ? { files: fileSource } : {})}
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={selection}
      runSource={source}
    />
  );
}
