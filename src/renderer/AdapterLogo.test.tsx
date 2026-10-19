import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { MADE_UP } from '../shared/test-made-up';
import { catalog, loadCatalog } from './catalog';
import { AdapterLogo } from './AdapterLogo';
import css from './AdapterLogo.css?raw';

const shipped = catalog();
const rules = document.createElement('style');
afterEach(async () => {
  rules.remove();
  await loadCatalog(() => Promise.resolve(shipped));
});

it.each(shipped.adapters)('draws $name’s catalog logo only as a data image', (adapter) => {
  const { container } = render(<AdapterLogo adapter={adapter.id} size={30} />);
  const logo = screen.getByRole<HTMLImageElement>('img', { name: adapter.name });
  expect(logo.tagName).toBe('IMG');
  expect(logo.src).toMatch(/^data:image\/svg\+xml,/);
  expect(decodeURIComponent(logo.src.slice(logo.src.indexOf(',') + 1))).toBe(adapter.logo);
  expect(logo.width).toBe(30);
  expect(logo.height).toBe(30);
  expect(container.querySelector('svg')).toBeNull();
});

it('shows a logo-less adapter’s first letter on its catalog accent', async () => {
  await loadCatalog(() => Promise.resolve(MADE_UP));
  rules.textContent = css;
  document.head.append(rules);
  render(<AdapterLogo adapter="zed" size={18} />);
  const logo = screen.getByRole('img', { name: 'Zed Agent' });
  expect(logo.textContent).toBe('Z');
  expect(logo.getAttribute('data-accent')).toBe(String(MADE_UP.adapters[0]?.accent));
  expect(getComputedStyle(logo).backgroundColor).toBe('rgb(193, 95, 60)');
  expect(getComputedStyle(logo).width).toBe('18px');
  expect(getComputedStyle(logo).height).toBe('18px');
  expect(logo.querySelector('img, svg')).toBeNull();
});

it('uses an unavailable adapter’s id as its name and first letter', () => {
  render(<AdapterLogo adapter="missing" size={16} />);
  const logo = screen.getByRole('img', { name: 'missing' });
  expect(logo.textContent).toBe('M');
  expect(logo.getAttribute('data-accent')).toBe('0');
});

it('takes the fallback colour from the adapter’s accent rather than its identity', async () => {
  await loadCatalog(() =>
    Promise.resolve({
      ...MADE_UP,
      adapters: MADE_UP.adapters.map((adapter) => ({ ...adapter, accent: 1 })),
    }),
  );
  rules.textContent = css;
  document.head.append(rules);
  render(<AdapterLogo adapter="zed" size={30} />);
  expect(getComputedStyle(screen.getByRole('img', { name: 'Zed Agent' })).backgroundColor).toBe(
    'rgb(14, 138, 107)',
  );
});
