import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentId } from '../../shared/api/ids';
import { newCanvasId } from '../../shared/canvas';
import type { AgentNode } from '../../shared/model/canvas';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import { TWO_MADE_UP } from '../../shared/test-made-up';
import { expectOneOp, expectOneRead, fakeCore } from '../test-api';
import { useCatalog as loadTestCatalog } from '../test-catalog';
import { ChainControl, FallbackMark, FallbackProvider, HandoffTile } from './Fallback';

const cores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});
const node: AgentNode = {
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'Writer', adapter: 'zed' },
};
async function show(data: Partial<AgentNode['data']> = {}, view = {}) {
  await loadTestCatalog(TWO_MADE_UP);
  const core = fakeCore();
  cores.push(core);
  const canvas = newCanvasId();
  core.snapshot(`sessions:${canvas}`, {
    agents: {
      [AgentId.parse('a')]: {
        ...sessionView(AgentId.parse('a'), 'zed.acp', NEW_SESSION).summary,
        ...view,
      },
    },
  });
  core.respond('session.options', {
    models: [{ value: 'small', label: 'Small', efforts: [{ value: 'careful', label: 'Careful' }] }],
    defaults: { model: null, effort: null, mode: null },
  });
  const dataOf = { ...node.data, ...data };
  if (dataOf.adapter === '') delete dataOf.adapter;
  const mounted = render(
    <FallbackProvider
      canvas={canvas}
      client={core.api}
      mirror={core.topics}
      nodes={[{ ...node, data: dataOf }]}
    >
      <ChainControl agent="a" />
      <HandoffTile agent="a" />
      <FallbackMark agent="a" />
    </FallbackProvider>,
  );
  return { core, canvas, ...mounted };
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing element');
  return value;
}
const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Fallback chain' }));
  return within(screen.getByRole('dialog', { name: 'Fallback chain' }));
};

it('saves an ordered chain of catalog endpoints and native model settings in one operation', async () => {
  const { core, canvas } = await show();
  const panel = open();
  expect(panel.getByText(/first turn.*consent/i)).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'Add step' }));
  fireEvent.change(panel.getByRole('combobox', { name: 'Step 1 agent' }), {
    target: { value: 'yak' },
  });
  expect(panel.getByText(/never falls back on its own/)).toBeTruthy();
  fireEvent.change(panel.getByRole('combobox', { name: 'Step 1 connection' }), {
    target: { value: 'yak.terminal' },
  });
  const model = await panel.findByRole('option', { name: 'Small' });
  fireEvent.change(required(model.closest('select')), { target: { value: 'small' } });
  fireEvent.change(panel.getByRole('combobox', { name: 'Step 1 effort' }), {
    target: { value: 'careful' },
  });
  fireEvent.click(panel.getByRole('checkbox', { name: 'Return when its own usage resets' }));
  fireEvent.click(panel.getByRole('button', { name: 'Save chain' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setFallback', {
      canvas,
      agent: 'a',
      fallback: {
        to: [{ adapter: 'yak', connection: 'yak.terminal', model: 'small', effort: 'careful' }],
        back: 'return',
      },
    });
  });
});

it('keeps chain edits local, limits them to three distinct steps and removes a chain with one save', async () => {
  const { core, canvas } = await show({
    fallback: { to: [{ adapter: 'yak', connection: 'yak.free' }] },
  });
  let panel = open();
  fireEvent.click(panel.getByRole('button', { name: 'Add step' }));
  fireEvent.click(panel.getByRole('button', { name: 'Add step' }));
  expect(panel.getByRole('button', { name: 'Add step' }).hasAttribute('disabled')).toBe(true);
  expect(panel.getByRole('button', { name: 'Save chain' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  expect(core.operations).toEqual([]);
  panel = open();
  fireEvent.click(panel.getByRole('button', { name: 'Remove step 1' }));
  fireEvent.click(panel.getByRole('button', { name: 'Save chain' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setFallback', { canvas, agent: 'a', fallback: null });
  });
});

it('offers no chain picker to an unchosen or unavailable agent', async () => {
  const { unmount } = await show({ adapter: '' });
  expect(screen.queryByRole('button', { name: 'Fallback chain' })).toBeNull();
  unmount();
  await show({ adapter: 'missing' });
  expect(screen.queryByRole('button', { name: 'Fallback chain' })).toBeNull();
});

it('keeps the core refusal on an unsaved chain and sends no second operation', async () => {
  const { core } = await show({ fallback: { to: [{ adapter: 'yak', connection: 'yak.free' }] } });
  core.reply('agent.setFallback', {
    ok: false,
    error: { code: 'invalid', sentence: 'Choose distinct endpoints.' },
  });
  fireEvent.click(open().getByRole('button', { name: 'Save chain' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Choose distinct endpoints.');
  expect(core.operations).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'Fallback chain' })).toBeTruthy();
});

it('reads the latest handoff once on opening, with its author and exact text', async () => {
  const { core, canvas } = await show(
    {},
    { handoff: { state: 'kept', at: 123, bytes: 12, export: 'done' } },
  );
  core.respond('session.handoff', {
    handoff: {
      text: '# Own words\n',
      at: 123,
      bytes: 12,
      source: { adapter: 'yak', connection: 'yak.free', model: 'small' },
    },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Read handoff' }));
  const panel = await screen.findByRole('dialog', { name: 'Latest handoff' });
  expect(panel.textContent).toContain('Yak Agent');
  expect(panel.querySelector('pre')?.textContent).toBe('# Own words\n');
  expectOneRead(core, 'session.handoff', { canvas, agent: 'a' });
  expect(core.operations).toEqual([]);
});

it('saves handoff defaults, off, threshold and relative export from a separate gear gesture', async () => {
  const { core, canvas } = await show();
  fireEvent.click(screen.getByRole('button', { name: 'Handoff settings' }));
  const panel = within(screen.getByRole('dialog', { name: 'Handoff settings' }));
  fireEvent.change(panel.getByRole('spinbutton', { name: 'Ask at context percent' }), {
    target: { value: '85' },
  });
  fireEvent.change(panel.getByRole('textbox', { name: 'Markdown export' }), {
    target: { value: 'notes/handoff.md' },
  });
  fireEvent.click(panel.getByRole('checkbox', { name: 'Write handoffs' }));
  fireEvent.click(panel.getByRole('button', { name: 'Save handoff settings' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setHandoff', {
      canvas,
      agent: 'a',
      handoff: { off: true, at: 85, file: 'notes/handoff.md' },
    });
  });
  core.operations.length = 0;
  fireEvent.click(screen.getByRole('button', { name: 'Handoff settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use handoff defaults' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setHandoff', { canvas, agent: 'a', handoff: null });
  });
});

it.each(['asking', 'failed', 'unreported', 'off'] as const)(
  'shows the core handoff state %s without quoting its text',
  async (state) => {
    const { core } = await show(
      {},
      { handoff: { state, at: null, bytes: null, export: 'refused' } },
    );
    expect((await screen.findByLabelText('Handoff')).getAttribute('data-state')).toBe(state);
    expect(screen.getByText('Export refused')).toBeTruthy();
    expect(core.reads).toEqual([]);
  },
);

it('marks the current fallback and remaining chain from core views, including switching', async () => {
  const { core, canvas } = await show(
    {
      fallback: {
        to: [
          { adapter: 'yak', connection: 'yak.free' },
          { adapter: 'zed', connection: 'zed.free' },
        ],
      },
    },
    { fallback: { step: 0, steps: 2, back: 'return', switching: true } },
  );
  expect((await screen.findByLabelText('Fallback status')).textContent).toContain('Switching…');
  act(() => {
    core.change({
      topic: `sessions:${canvas}`,
      rev: 1,
      agents: {
        set: {
          [AgentId.parse('a')]: {
            ...sessionView(AgentId.parse('a'), 'yak.free', NEW_SESSION).summary,
            fallback: { step: 0, steps: 2, back: 'return' as const },
          },
        },
        remove: [],
      },
    });
  });
  expect(screen.getByLabelText('Fallback status').textContent).toContain(
    'Yak Agent · Free · 1 next',
  );
});

it('reorders alternatives locally and saves their explicit order once', async () => {
  const { core, canvas } = await show({
    fallback: {
      to: [
        { adapter: 'yak', connection: 'yak.free' },
        { adapter: 'zed', connection: 'zed.free' },
      ],
    },
  });
  const panel = open();
  fireEvent.click(panel.getByRole('button', { name: 'Move step 2 up' }));
  expect(panel.getByRole<HTMLSelectElement>('combobox', { name: 'Step 1 agent' }).value).toBe(
    'zed',
  );
  expect(core.operations).toEqual([]);
  fireEvent.click(panel.getByRole('button', { name: 'Save chain' }));
  fireEvent.click(panel.getByRole('button', { name: 'Save chain' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setFallback', {
      canvas,
      agent: 'a',
      fallback: {
        to: [
          { adapter: 'zed', connection: 'zed.free' },
          { adapter: 'yak', connection: 'yak.free' },
        ],
      },
    });
  });
});
it('accepts another model of the same adapter without copying its saved permission mode', async () => {
  const { core, canvas } = await show({ settings: { zed: { model: 'large', mode: 'plan' } } });
  const panel = open();
  fireEvent.click(panel.getByRole('button', { name: 'Add step' }));
  fireEvent.change(panel.getByRole('combobox', { name: 'Step 1 agent' }), {
    target: { value: 'zed' },
  });
  await panel.findByRole('option', { name: 'Small' });
  fireEvent.change(panel.getByRole('combobox', { name: 'Step 1 model' }), {
    target: { value: 'small' },
  });
  fireEvent.click(panel.getByRole('button', { name: 'Save chain' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setFallback', {
      canvas,
      agent: 'a',
      fallback: { to: [{ adapter: 'zed', connection: 'zed.acp', model: 'small' }] },
    });
  });
});
it('validates handoff percentage and export shape before saving, with Cancel sending nothing', async () => {
  const { core } = await show();
  fireEvent.click(screen.getByRole('button', { name: 'Handoff settings' }));
  const panel = within(screen.getByRole('dialog', { name: 'Handoff settings' }));
  fireEvent.change(panel.getByRole('spinbutton', { name: 'Ask at context percent' }), {
    target: { value: '96' },
  });
  expect(
    panel.getByRole('button', { name: 'Save handoff settings' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(panel.getByRole('spinbutton', { name: 'Ask at context percent' }), {
    target: { value: '95' },
  });
  fireEvent.change(panel.getByRole('textbox', { name: 'Markdown export' }), {
    target: { value: '../handoff.md' },
  });
  expect(
    panel.getByRole('button', { name: 'Save handoff settings' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  expect(core.operations).toEqual([]);
});

it('validates a chain edit with the core rules when removing its current step makes that endpoint its own', async () => {
  const { core, canvas } = await show({
    adapter: 'yak',
    connection: 'yak.free',
    fallback: {
      to: [{ adapter: 'yak', connection: 'yak.free' }],
      on: { step: 0, from: { adapter: 'zed', connection: 'zed.acp' }, why: 'rule', at: 1 },
    },
  });
  const panel = open();
  fireEvent.change(panel.getByRole('combobox', { name: 'Step 1 agent' }), {
    target: { value: 'zed' },
  });
  fireEvent.click(panel.getByRole('button', { name: 'Save chain' }));
  await waitFor(() => {
    expectOneOp(core, 'agent.setFallback', {
      canvas,
      agent: 'a',
      fallback: { to: [{ adapter: 'zed', connection: 'zed.acp' }] },
    });
  });
});

it('offers efforts for the target adapter’s saved model when the step leaves its model unchanged', async () => {
  const { core } = await show({
    settings: { yak: { model: 'large' } },
    fallback: { to: [{ adapter: 'yak', connection: 'yak.free' }] },
  });
  core.respond('session.options', {
    models: [
      { value: 'small', label: 'Small', efforts: [{ value: 'low', label: 'Low' }] },
      { value: 'large', label: 'Large', efforts: [{ value: 'careful', label: 'Careful' }] },
    ],
    defaults: { model: 'small', effort: null, mode: null },
  });
  const panel = open();
  expect(await panel.findByRole('option', { name: 'Careful' })).toBeTruthy();
  expect(panel.queryByRole('option', { name: 'Low' })).toBeNull();
});
