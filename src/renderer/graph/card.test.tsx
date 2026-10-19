import { render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CARD_SIZE } from '../../shared/model/geometry';
import { GraphEditor } from './GraphEditor';
import css from './GraphEditor.css?raw';

vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

const rules = document.createElement('style');
afterEach(() => {
  rules.remove();
});

/** Only the card and label rules: jsdom checks their constraints; e2e measures the actual layout. */
function cardRules() {
  expect(css).toContain('.graph-card {');
  const card = /\n\.graph-card \{([^}]+)\}/.exec(css)?.[1] ?? '';
  const label = /\n\.graph-card > \.graph-label[^{]*\{([^}]+)\}/.exec(css)?.[1] ?? '';
  rules.textContent = `.graph-card { ${card} } .graph-card > .graph-label { ${label} }`;
  document.head.append(rules);
}

it('keeps the fixed card dimensions equal to the model’s CARD_SIZE', () => {
  cardRules();
  const { container } = render(<GraphEditor />);
  const card = document.createElement('div');
  card.className = 'graph-card';
  container.append(card);
  const style = getComputedStyle(card);
  expect(style.width).toBe(`${String(CARD_SIZE.width)}px`);
  expect(style.height).toBe(`${String(CARD_SIZE.height)}px`);
  expect(style.boxSizing).toBe('border-box');
});

it('constrains a long name and full queue to the same card, clipping the label with an ellipsis', () => {
  cardRules();
  const name = 'A very long agent name '.repeat(30);
  const { container } = render(
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
