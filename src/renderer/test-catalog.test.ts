import { expect, it } from 'vitest';

import { MADE_UP, TWO_MADE_UP } from '../shared/test-made-up';
import { catalog } from './catalog';
import { useCatalog } from './test-catalog';

it('loads a case’s catalog and restores the catalog it replaced', async () => {
  const previous = catalog();
  const restore = await useCatalog(MADE_UP);
  expect(catalog()).toBe(MADE_UP);
  await restore();
  expect(catalog()).toBe(previous);
});

it('offers a second unfamiliar adapter with a transcript before a shell-capable terminal', () => {
  expect(TWO_MADE_UP.adapters).toHaveLength(2);
  expect(
    TWO_MADE_UP.adapters[1]?.connections.map(({ view, shellPrefix }) => ({ view, shellPrefix })),
  ).toEqual([
    { view: 'transcript', shellPrefix: undefined },
    { view: 'terminal', shellPrefix: '$' },
  ]);
});
