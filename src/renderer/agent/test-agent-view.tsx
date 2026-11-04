import { act, screen, within } from '@testing-library/react';

import type { Catalog, ConnectionDescriptor } from '../../shared/adapter';
import { FEATURE_CATALOG } from '../../shared/test-features';
import type { FakeCanvas } from '../test-canvas';
import type { Graph } from '../graph/flow';
import { GraphEditor } from '../test-graph';
import { fakeSessions } from '../test-sessions';
import type { FixtureSessionEvent } from '../test-sessions';
import { useCatalog as adoptCatalog } from '../test-catalog';
import { renderReady, events } from '../test-render';

/*
 * An agent view over unfamiliar adapters, so no vendor branch can hide: what it completes,
 * intercepts and offers to continue elsewhere is read from the descriptors alone.
 */

/** Unfamiliar connections: `zed.acp` continues in a terminal named "Zed Shell", `zed.free` in `zed.acp`. */
export function made(
  edit: (connections: Record<string, ConnectionDescriptor>) => void = () => undefined,
) {
  const result: Catalog = structuredClone(FEATURE_CATALOG);
  const connections = Object.fromEntries(
    result.adapters.flatMap(({ connections }) => connections.map((one) => [one.id, one])),
  );
  const acp = connections['zed.acp'];
  const free = connections['zed.free'];
  const terminal = connections['zed.terminal'];
  if (!acp || !free || !terminal) throw new Error('The fixture needs its connections.');
  terminal.label = 'Zed Shell';
  terminal.short = 'Shell';
  terminal.shellPrefix = '$';
  acp.panels = {};
  acp.continueIn = {
    connection: terminal.id,
    commands: [
      { name: 'settings', description: 'Open the settings screen', argumentHint: '' },
      { name: 'cfg', description: 'Open configuration', argumentHint: '', bare: true },
    ],
    shell: true,
    mcpSignIn: true,
  };
  free.panels = {};
  free.continueIn = {
    connection: acp.id,
    commands: [{ name: 'tune', description: 'Tune it', argumentHint: '' }],
    shell: false,
    mcpSignIn: false,
  };
  edit(connections);
  return result;
}

export const STARTED: FixtureSessionEvent = {
  type: 'started',
  role: 'append',
  resume: true,
  list: true,
  model: null,
  mode: null,
  models: [],
};

/** The editor with agent `a` (on `connection`) opened in its view, and its core faked. */
export async function open(
  connection: string,
  catalog: Catalog,
  prepare?: (fake: ReturnType<typeof fakeSessions>) => void,
) {
  await adoptCatalog(catalog);
  const fake = fakeSessions();
  prepare?.(fake);
  const graph: Graph = {
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'a', connection: connection },
      },
    ],
    edges: [],
  };
  const held: { canvas?: FakeCanvas } = {};
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={graph}
      sessionReplies={fake.replies}
      onCanvas={(made) => {
        held.canvas = made;
      }}
    />,
  );
  const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
  if (!card) throw new Error('no agent');
  await events.doubleClick(card);
  await settle();
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  const composer = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
  const send = async (text: string) => {
    await events.change(composer, { target: { value: text } });
    await events.keyDown(composer, { key: 'Enter' });
    await settle();
  };
  const emit = (...given: FixtureSessionEvent[]) => {
    act(() => {
      fake.emit('a', connection, ...given);
    });
  };
  if (!held.canvas) throw new Error('No fake canvas');
  const canvas = held.canvas;
  /** The operations and reads from now on, as `expectOneOp` and `expectOneRead` take them. */
  const since = () => {
    const operations = canvas.core.operations.length;
    const reads = canvas.core.reads.length;
    return {
      get operations() {
        return canvas.core.operations.slice(operations);
      },
      get reads() {
        return canvas.core.reads.slice(reads);
      },
    };
  };
  return { ...fake, view, composer, send, emit, canvas, since };
}

export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
