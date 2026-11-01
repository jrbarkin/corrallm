import { events, renderReady } from '../test-render';
import { afterEach, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';

import { CARD_SIZE } from '../../shared/model/geometry';
import { GraphEditor } from '../test-graph';
import css from './GraphEditor.css?raw';
import { expectOneOp } from '../test-api';
import type { FakeCanvas } from '../test-canvas';

vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

const rules = document.createElement('style');
afterEach(() => {
  rules.remove();
});

it('shows topic workspace attention beside Idle, glows the dock, and opens the exact setup card', async () => {
  let core: FakeCanvas | undefined;
  const need = 'setup/11111111-1111-4111-8111-111111111111/1';
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } }],
        edges: [],
      }}
      onCanvas={(canvas) => {
        core = canvas;
      }}
    />,
  );
  const canvas = core;
  if (!canvas) throw new Error('No canvas');
  const fake = canvas.core;
  const worktrees = `worktrees:${canvas.document.id}` as const;
  const needs = `needs:${canvas.document.id}` as const;
  // The editor has subscribed by the time onCanvas runs, so the core says the workspace and its
  // card as it would, rather than the test replacing a snapshot the mirror already holds.
  act(() => {
    fake.change({
      topic: worktrees,
      rev: (fake.state(worktrees)?.rev ?? 0) + 1,
      replace: {
        items: [
          {
            agent: 'a',
            mode: 'own',
            workspace: '11111111-1111-4111-8111-111111111111',
            generation: 1,
            branch: 'corral/Builder',
            base: null,
            state: 'setup',
            merge: { merged: null, uncommitted: null },
            need,
            setup: {
              state: 'pending',
              command: 'pnpm install',
              source: 'detected',
              exitCode: null,
            },
          },
        ],
        kept: [],
        into: null,
      },
    });
    fake.change({
      topic: needs,
      rev: (fake.state(needs)?.rev ?? 0) + 1,
      replace: {
        items: [
          {
            id: need,
            canvas: canvas.document.id,
            kind: 'worktree',
            for: 'you',
            by: ['you'],
            answerIn: 'api',
            title: 'Set up Builder’s worktree?',
            detail: 'Runs: pnpm install',
            choices: [{ value: 'skip', label: 'Skip' }],
          },
        ],
      },
    });
  });
  const card = container.querySelector<HTMLElement>('.graph-card');
  if (!card || !core) throw new Error('No card or canvas');
  expect(within(card).getByText('corral/Builder')).toBeTruthy();
  expect(card.dataset.status).toBe('Idle');
  const dock = screen.getByRole('navigation', { name: 'Canvas agents' });
  const icon = within(dock).getByRole('button', { name: /^Builder,/ });
  expect(icon.hasAttribute('data-needs')).toBe(true);
  expect(icon.dataset.status).toBe('Idle');
  expect(within(card).getByRole('button', { name: 'Review setup' }).textContent).toBe('Setup');
  await events.click(within(card).getByRole('button', { name: 'Review setup' }));
  const decision = await screen.findByRole('article', { name: 'Set up Builder’s worktree?' });
  expect(decision).toBe(document.activeElement);
  core.core.operations.length = 0;
  await events.click(within(decision).getByRole('button', { name: 'Skip' }));
  expectOneOp(core.core, 'reply', {
    canvas: core.document.id,
    to: need,
    answer: { choice: 'skip' },
  });
});

/** Only the card and label rules: jsdom checks their constraints; e2e measures the actual layout. */
function cardRules() {
  expect(css).toContain('.graph-card {');
  const card = /\n\.graph-card \{([^}]+)\}/.exec(css)?.[1] ?? '';
  const label = /\n\.graph-card-top > \.graph-label[^{]*\{([^}]+)\}/.exec(css)?.[1] ?? '';
  rules.textContent = `.graph-card { ${card} } .graph-card-top > .graph-label { ${label} }`;
  document.head.append(rules);
}

it('keeps the fixed card dimensions equal to the model’s CARD_SIZE', async () => {
  cardRules();
  const { container } = await renderReady(<GraphEditor />);
  const card = document.createElement('div');
  card.className = 'graph-card';
  container.append(card);
  const style = getComputedStyle(card);
  expect(style.width).toBe(`${String(CARD_SIZE.width)}px`);
  expect(style.height).toBe(`${String(CARD_SIZE.height)}px`);
  expect(style.boxSizing).toBe('border-box');
  expect(style.borderRadius).toBe('10px');
  expect(style.padding).toBe('10px 12px');
  const parent = /\.react-flow__node-agent\.parent::before \{([^}]+)\}/.exec(css)?.[1] ?? '';
  expect(Number(/inset: ([\d.]+)px/.exec(parent)?.[1])).toBe(CARD_SIZE.height / 2);
});

it('constrains a long name and full queue to the same card, clipping the label with an ellipsis', async () => {
  cardRules();
  const name = 'A very long agent name '.repeat(30);
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [
          {
            id: 'a',
            type: 'agent',
            position: { x: 0, y: 0 },
            data: {
              label: name,
              queue: Array.from({ length: 100 }, (_, i) => ({
                id: `m${String(i)}`,
                message: 'Queued work',
              })),
            },
          },
        ],
        edges: [],
      }}
    />,
  );
  const card = container.querySelector('.graph-card');
  const label = card?.querySelector('.graph-label');
  if (!card || !label) throw new Error('No card or label');
  expect(getComputedStyle(card).height).toBe(`${String(CARD_SIZE.height)}px`);
  expect(getComputedStyle(label)).toMatchObject({
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  expect(label.getAttribute('title')).toBe(name);
  expect(card.querySelector('.graph-queue-count')?.getAttribute('data-count')).toBe('100');
});

it('uses the guide’s 186 by 73 card, with a catalog image, name, status and queue progress', async () => {
  expect(CARD_SIZE).toEqual({ width: 186, height: 73 });
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [
          {
            id: 'a',
            type: 'agent',
            position: { x: 0, y: 0 },
            data: { label: 'Writer', queue: [{ id: 'one', message: 'Work' }] },
          },
        ],
        edges: [],
      }}
    />,
  );
  const card = container.querySelector<HTMLElement>('.graph-card');
  if (!card) throw new Error('No card');
  const view = within(card);
  const logo = view.getByRole('img', { name: 'Claude Code' });
  expect(logo.tagName).toBe('IMG');
  expect(logo.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
  expect(card.querySelector('svg')).toBeNull();
  expect(card.querySelector('.graph-agent')).toBeNull();
  expect(view.getByText('Writer')).toBeTruthy();
  expect(view.getByText('Idle')).toBeTruthy();
  expect(card.getAttribute('data-status')).toBe('Idle');
  expect(
    view.getByRole('progressbar', { name: 'Writer queue progress' }).getAttribute('aria-valuenow'),
  ).toBe('0');
  expect(card.querySelectorAll('.react-flow__handle')).toHaveLength(2);
  expect(card.querySelector('.graph-queue-count')?.getAttribute('data-count')).toBe('1');
});
it('a card gives an adapter without a logo its first letter', async () => {
  await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [
          {
            id: 'zed',
            type: 'agent',
            position: { x: 0, y: 0 },
            data: { label: 'Zed', adapter: 'zed' },
          },
        ],
        edges: [],
      }}
    />,
  );
  const logo = screen
    .getAllByRole('img', { name: 'zed' })
    .find((image) => image.closest('.graph-card'));
  expect(logo?.tagName).toBe('SPAN');
  expect(logo?.textContent).toBe('Z');
});
