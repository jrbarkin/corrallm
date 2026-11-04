import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TWO_MADE_UP } from '../../shared/test-made-up';
import { useCatalog } from '../test-catalog';
import { McpPanel } from './McpPanel';

it('explains an empty server list with the adapter’s own hint', async () => {
  const made = structuredClone(TWO_MADE_UP);
  const yak = made.adapters[1];
  if (!yak) throw new Error('No second adapter');
  yak.words.mcpHint = 'Add servers in Yak preferences.';
  await useCatalog(made);
  render(
    <McpPanel
      adapter="yak"
      list={() => Promise.resolve([])}
      changes={[]}
      change={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(
    await screen.findByText('No MCP servers yet. Add servers in Yak preferences.'),
  ).toBeTruthy();
});
