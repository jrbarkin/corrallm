import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { newCanvasId } from '../shared/canvas';
import { fromFile, toFile } from '../shared/model/file';
import { catalog } from './catalog';
import { GraphEditor as Editor } from './graph/GraphEditor';
import type { CanvasId } from '../shared/canvas';
import type { CanvasFile, ProjectFolder } from '../shared/ipc';
import { DEFAULT_AGENT } from './graph/agents';
import { documentOf, EMPTY_GRAPH } from './test-graph-data';
import type { Graph } from './graph/flow';
import type { RunSource } from './run/persistence';
import { fakeCanvas, emptyCanvas } from './test-canvas';

type Props = Omit<
  ComponentProps<typeof Editor>,
  'canvas' | 'client' | 'mirror' | 'initialSelection' | 'files'
> & { initialGraph?: Graph; files?: CanvasFiles };
/** Dialog answers for older integration tests, served through the fake operation transport. */
export interface CanvasFiles {
  open: () => Promise<CanvasFile | null>;
  save: (text: string, choose: boolean, rev: number) => Promise<string | null>;
  forget: () => Promise<CanvasId>;
  chooseProject?: () => Promise<ProjectFolder | null>;
}
/** Existing session/queue tests use a canvas core too; only the fake owns its document. */
export function GraphEditor({ initialGraph = EMPTY_GRAPH, files, runSource, ...props }: Props) {
  const [canvas] = useState(() => fakeCanvas(documentOf(initialGraph, newCanvasId())));
  const [selection] = useState(() => ({
    nodes: new Set(initialGraph.nodes.filter((n) => n.selected).map((n) => n.id)),
    edges: new Set(initialGraph.edges.filter((e) => e.selected).map((e) => e.id)),
  }));
  const [source] = useState<RunSource>(() => {
    let initialized = false;
    const get = async () => {
      const context = runSource
        ? await runSource.get()
        : { id: canvas.document.id, token: 'test', checkpoint: null };
      if (!initialized) {
        if (context.id !== canvas.document.id) canvas.open({ ...canvas.document, id: context.id });
        initialized = true;
      }
      return {
        id: canvas.document.id,
        token: context.token,
        checkpoint: context.checkpoint,
        ...(context.notices ? { notices: context.notices } : {}),
      };
    };
    if (files) {
      canvas.core.reply('canvas.open', async () => {
        const file = await files.open();
        if (file) {
          canvas.open(fromFile(file.text, catalog(), DEFAULT_AGENT));
          canvas.meta({ name: file.name, project: file.project ?? null });
        }
        return { ok: true, value: { canvas: file?.id ?? null, revs: {} } };
      });
      canvas.core.reply('canvas.create', async (args) => {
        if (args && typeof args === 'object' && 'template' in args) return canvas.create(args);
        const id = await files.forget();
        canvas.open(emptyCanvas(id));
        canvas.meta({ name: null, project: null });
        return { ok: true, value: { canvas: id, revs: {} } };
      });
      for (const op of ['canvas.save', 'canvas.saveAs'] as const)
        canvas.core.reply(op, async () => {
          const name = await files.save(
            toFile(canvas.document),
            op === 'canvas.saveAs',
            canvas.rev,
          );
          if (name !== null) canvas.meta({ name, edited: false });
          return { ok: true, value: { name, revs: {} } };
        });
      canvas.core.reply('project.choose', async () => {
        const project = (await files.chooseProject?.()) ?? null;
        if (project) canvas.meta({ project });
        return { ok: true, value: { project, revs: {} } };
      });
    }
    return {
      get,
      save: (token, checkpoint) => runSource?.save(token, checkpoint) ?? Promise.resolve(null),
      ready: (request, error) => runSource?.ready(request, error) ?? Promise.resolve(null),
      onStopping: (listener) => runSource?.onStopping(listener) ?? (() => undefined),
    };
  });
  useEffect(
    () => () => {
      canvas.core.dispose();
    },
    [canvas],
  );
  return (
    <Editor
      {...props}
      files={files !== undefined}
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={selection}
      runSource={source}
    />
  );
}
