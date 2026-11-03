import { act, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MADE_UP } from '../../shared/test-made-up';
import { AgentId } from '../../shared/api/ids';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import { UsageGauges } from '../usage/UsageGauge';
import { expectOneOp, fakeCore } from '../test-api';
import { useCatalog as loadTestCatalog } from '../test-catalog';
import { GraphEditor } from '../test-graph';
import { events, renderReady } from '../test-render';
import type { FakeCanvas } from '../test-canvas';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing element');
  return value;
}
async function show() {
  await loadTestCatalog(MADE_UP);
  let canvas: FakeCanvas | undefined;
  const view = await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [
          {
            id: 'a',
            type: 'agent',
            position: { x: 0, y: 0 },
            data: {
              label: 'Writer',
              adapter: 'zed',
              fallback: { to: [{ adapter: 'zed', connection: 'zed.free' }] },
              queue: [{ id: 'work', action: 'missing' }],
            },
          },
        ],
        edges: [],
      }}
      onCanvas={(made) => {
        canvas = made;
      }}
    />,
  );
  if (!canvas) throw new Error('No canvas');
  return { ...view, canvas };
}
it('opens one shared chain picker from the agent chip and Agent settings', async () => {
  const { container, canvas } = await show();
  const card = required(container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]'));
  await events.doubleClick(card);
  const window = within(screen.getByRole('dialog', { name: 'Writer' }));
  await events.click(window.getByRole('button', { name: 'Fallback chain' }));
  expect(screen.getByRole('dialog', { name: 'Fallback chain' })).toBeTruthy();
  await events.click(screen.getByRole('button', { name: 'Cancel' }));
  await events.click(window.getByRole('button', { name: 'Agent settings: Writer' }));
  const settings = within(screen.getByRole('dialog', { name: 'Agent settings: Writer' }));
  await events.click(settings.getByRole('button', { name: 'Fallback chain' }));
  canvas.core.operations.length = 0;
  await events.click(screen.getByRole('button', { name: 'Save chain' }));
  expectOneOp(canvas.core, 'agent.setFallback', {
    canvas: canvas.document.id,
    agent: 'a',
    fallback: { to: [{ adapter: 'zed', connection: 'zed.free' }] },
  });
});
it('marks the card and All queues lane from the core chain position and keeps the card dimensions', async () => {
  const { container, canvas } = await show();
  const topic = `sessions:${canvas.document.id}` as const;
  act(() => {
    canvas.core.change({
      topic,
      rev: (canvas.core.state(topic)?.rev ?? 0) + 1,
      agents: {
        set: {
          [AgentId.parse('a')]: {
            ...sessionView(AgentId.parse('a'), 'zed.free', NEW_SESSION).summary,
            fallback: { step: 0, steps: 1, back: 'stay' },
          },
        },
        remove: [],
      },
    });
  });
  const card = required(container.querySelector<HTMLElement>('.graph-card'));
  expect(within(card).getByLabelText('Fallback status').textContent).toContain(
    'Zed Agent · Free · 0 next',
  );
  expect(card.getAttribute('title')).toBe('Agent: Zed Agent · ACP');
  await events.doubleClick(
    required(container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')),
  );
  await events.click(screen.getByRole('button', { name: 'All queues' }));
  act(() => {
    canvas.core.change({
      topic,
      rev: (canvas.core.state(topic)?.rev ?? 0) + 1,
      agents: {
        set: {
          [AgentId.parse('a')]: {
            ...sessionView(AgentId.parse('a'), 'zed.free', NEW_SESSION).summary,
            fallback: { step: 0, steps: 1, back: 'stay' },
          },
        },
        remove: [],
      },
    });
  });
  expect(
    within(required(container.querySelector<HTMLElement>('.queues-head'))).getByLabelText(
      'Fallback status',
    ).textContent,
  ).toBe('Zed Agent · Free · 0 next');
});
it('sets Carry on with the next backend as one global usage-rule operation', async () => {
  await loadTestCatalog(MADE_UP);
  const core = fakeCore();
  render(
    <UsageGauges
      backends={['zed']}
      usage={{ readings: [], rules: {} }}
      onRule={(backend, rule) => {
        void core.api.usageSetRule({ backend, rule });
      }}
      onSimulate={() => undefined}
    />,
  );
  await events.click(screen.getByRole('button', { name: /^Zed usage:/ }));
  await events.click(screen.getByRole('button', { name: 'Add a rule…' }));
  await events.click(screen.getByRole('option', { name: /Carry on with the next backend/ }));
  expectOneOp(core, 'usage.setRule', {
    backend: 'zed',
    rule: { window: 'fiveHour', percent: 80, action: 'fallback' },
  });
  core.dispose();
});
it.each([
  ['Skip', 'skip'],
  ['Stop here', 'stop'],
] as const)(
  'answers an unknown-action refusal through %s with one reply and no retry choice',
  async (label, choice) => {
    const { canvas } = await show();
    await act(() =>
      canvas.run({
        running: true,
        agents: {
          a: {
            status: 'asking',
            current: 'work',
            outcomes: {},
            refused: {
              agent: 'a',
              text: 'This action is unavailable on this endpoint.',
              kind: 'unknown-action',
              connection: 'zed.acp',
            },
          },
        },
      }),
    );
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const need = canvas.core
      .state(`needs:${canvas.document.id}`)
      ?.state.items.find((item) => item.id.startsWith('hold/'));
    if (!need) throw new Error('Missing hold');
    expect(screen.getByText('This action is unavailable on this endpoint.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go on' })).toBeNull();
    canvas.core.operations.length = 0;
    await events.click(screen.getByRole('button', { name: label }));
    expectOneOp(canvas.core, 'reply', {
      canvas: canvas.document.id,
      to: need.id,
      answer: { choice },
    });
  },
);
