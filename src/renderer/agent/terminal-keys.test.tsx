import { act, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { Catalog } from '../../shared/adapter';
import type { Graph } from '../graph/flow';
import { fakeScreens, fakeTerminals } from '../terminal/test-screen';
import { GraphEditor } from '../test-graph';
import { useCatalog as adoptCatalog } from '../test-catalog';
import { events, renderReady } from '../test-render';
import { fakeSessions } from '../test-sessions';
import { made, settle } from './test-agent-view';

// jsdom cannot draw xterm.js: a fake terminal stands in.
vi.mock('../terminal/screen', async () => {
  const { fakeScreens: screens } = await import('../terminal/test-screen');
  return { createScreen: screens.create };
});

/*
 * A Terminal agent's keys over unfamiliar adapters: the view passes its terminal the connection's
 * descriptor `keys`, whatever the adapter, so no native sequence hides in the platform.
 */

beforeEach(() => {
  fakeScreens.made.length = 0;
});

/** A sequence no CLI is known to use. */
const UNFAMILIAR = '\x1b[99;7~';

async function openTerminal(connection: string, catalog: Catalog) {
  await adoptCatalog(catalog);
  const sessions = fakeSessions();
  const terminals = fakeTerminals();
  const graph: Graph = {
    nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'a', connection } }],
    edges: [],
  };
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={graph}
      sessionReplies={sessions.replies}
      terminalBackend={terminals.backend}
    />,
  );
  const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
  if (!card) throw new Error('no agent');
  await events.doubleClick(card);
  await settle();
  within(screen.getByRole('dialog', { name: 'a' }));
  act(() => {
    terminals.emit('a', { type: 'screen', data: '> ', cols: 100, rows: 30 });
  });
  act(() => {
    fakeScreens.latest().finish();
  });
  return { terminals };
}

it('types the sequence its connection declares', async () => {
  const declared = await openTerminal(
    'zed.terminal',
    made((c) => {
      const terminal = c['zed.terminal'];
      if (terminal) terminal.keys = { shiftEnter: UNFAMILIAR };
    }),
  );
  expect(fakeScreens.latest().keys).toEqual({ shiftEnter: UNFAMILIAR });
  fakeScreens.latest().pressShiftEnter();
  expect(declared.terminals.backend.write).toHaveBeenCalledWith('a', UNFAMILIAR);
});

it('leaves the key to the terminal for a connection whose keys are null', async () => {
  const none = await openTerminal('yak.terminal', made());
  expect(fakeScreens.latest().keys).toEqual({ shiftEnter: null });
  fakeScreens.latest().pressShiftEnter();
  expect(none.terminals.backend.write).toHaveBeenCalledWith('a', '\r');
  expect(none.terminals.backend.write).not.toHaveBeenCalledWith('a', UNFAMILIAR);
});
