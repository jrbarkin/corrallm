import { beforeEach, expect, it } from 'vitest';

import { MADE_UP, TWO_MADE_UP } from '../shared/test-made-up';
import { catalog } from './catalog';
import { useCatalog } from './test-catalog';
import { FEATURE_CATALOG } from '../shared/test-features';

const original = catalog();
beforeEach(() => {
  expect(catalog()).toBe(original);
});

it('loads feature fixtures for a case with automatic catalog restoration', async () => {
  await useCatalog(FEATURE_CATALOG);
  expect(catalog()).toBe(FEATURE_CATALOG);
});

it('restores nested case catalogs in reverse order, including an already restored inner load', async () => {
  const outer = await useCatalog(FEATURE_CATALOG);
  const inner = await useCatalog(MADE_UP);
  await inner();
  expect(catalog()).toBe(FEATURE_CATALOG);
  await outer();
  expect(catalog()).toBe(original);
});

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
