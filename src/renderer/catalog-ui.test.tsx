import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { MADE_UP, TWO_MADE_UP } from '../shared/test-made-up';
import { newCanvasId } from '../shared/canvas';
import { AgentChip } from './agent/AgentChip';
import { SettingsMenu } from './agent/Settings';
import { StartSession } from './graph/StartSession';
import {
  actionsOf,
  adapterCli,
  adapterName,
  agentLabel,
  connectionInfo,
  connectionsOf,
} from './graph/agents';
import { cycledModes, modesOf } from './agent/modes';
import { continuesIn } from './catalog';
import { useCatalog } from './test-catalog';
import { fakeCore } from './test-api';

it('builds chip choices from the catalog loaded after the chip module was imported', async () => {
  await useCatalog(MADE_UP);
  render(<AgentChip adapter="zed" connection="zed.acp" onChange={vi.fn()} onContinue={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Agent: Zed Agent · ACP' }));
  expect(screen.getAllByRole('option').map((one) => one.textContent.trim())).toEqual([
    'Zed Agent · ACP',
    'Zed Agent · Free',
  ]);
});

it('names unfamiliar agents and their actions from the loaded catalog', async () => {
  await useCatalog(MADE_UP);
  expect(adapterName('zed')).toBe('Zed Agent');
  expect(adapterCli('zed')).toBe('Zed Agent');
  expect(agentLabel('zed', 'zed.acp')).toBe('Zed Agent · ACP');
  expect(actionsOf('zed')).toEqual([{ name: 'shell', description: 'Run a command' }]);
  expect(connectionInfo('missing').description).toBe(
    'This agent has no connector in this build. Choose another agent in its settings.',
  );
});

it('offers declared modes and cycles only the modes that ask, using the adapter’s own classifications', async () => {
  await useCatalog(MADE_UP);
  expect(modesOf('zed').map(({ mode }) => mode)).toEqual(['plan', 'auto']);
  expect(cycledModes('zed')).toEqual(['plan']);
});

it('keeps a transcript before a terminal in Start and the chip', async () => {
  await useCatalog(TWO_MADE_UP);
  const core = fakeCore();
  core.install();
  core.respond('templates.list', { items: [] });
  core.snapshot('canvases', { items: [] });
  try {
    render(
      <StartSession
        canvas={newCanvasId()}
        mirror={core.topics}
        project={null}
        installed={{ yak: true }}
        onStart={vi.fn()}
        onChooseProject={vi.fn()}
        onTemplate={vi.fn()}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Yak Agent connection',
    });
    expect(Array.from(select.options).map((one) => one.value)).toEqual([
      'yak.free',
      'yak.terminal',
    ]);
    expect(select.value).toBe('yak.free');
    expect(connectionsOf('yak')).toEqual(['yak.free', 'yak.terminal']);
    render(
      <AgentChip adapter="yak" connection="yak.free" onChange={vi.fn()} onContinue={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent: Yak Agent · Free' }));
    expect(
      screen
        .getAllByRole('option')
        .slice(-2)
        .map((one) => one.textContent.trim()),
    ).toEqual(['Yak Agent · Free', 'Yak Agent · Terminal']);
  } finally {
    core.dispose();
  }
});

it.each([
  ['zed', 'zed.acp', 'The agent’s own default'],
  ['yak', 'yak.terminal', 'From your Yak preferences'],
])(
  'uses %s’s defaults wording and only its declared startup modes',
  async (adapter, connection, detail) => {
    await useCatalog(TWO_MADE_UP);
    render(
      <SettingsMenu
        inline
        adapter={adapter}
        connection={connection}
        settings={{}}
        options={() =>
          Promise.resolve({ models: [], defaults: { model: null, effort: null, mode: null } })
        }
        running={undefined}
        working={false}
      />,
    );
    const model = await screen.findByRole('button', { name: 'Model: Default' });
    fireEvent.click(model);
    expect(screen.getByText(detail)).toBeTruthy();
    fireEvent.keyDown(model, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Mode: Default' }));
    const menu = within(screen.getByRole('menu', { name: 'Mode' }));
    expect(menu.getByRole('menuitemradio', { name: 'Plan' })).toBeTruthy();
    expect(menu.queryByRole('menuitemradio', { name: 'Auto' })).toBeNull();
  },
);

it('uses the catalog accent for a newly declared adapter’s chip', async () => {
  await useCatalog(TWO_MADE_UP);
  render(<AgentChip adapter="yak" connection="yak.free" onChange={vi.fn()} onContinue={vi.fn()} />);
  expect(
    screen.getByRole('button', { name: 'Agent: Yak Agent · Free' }).getAttribute('data-accent'),
  ).toBe('1');
});

it('continues nowhere when the declared target is missing from the loaded catalog', async () => {
  const made = structuredClone(TWO_MADE_UP);
  const yak = made.adapters[1]?.connections[0];
  if (!yak) throw new Error('No connection');
  yak.continueIn = { connection: 'yak.terminal', commands: [], shell: false, mcpSignIn: false };
  await useCatalog(made);
  expect(continuesIn('yak.free')).toBe('yak.terminal');
  yak.continueIn.connection = 'yak.gone';
  await useCatalog(made);
  expect(continuesIn('yak.free')).toBeUndefined();
});
