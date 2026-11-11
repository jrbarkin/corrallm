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

it.each(shipped.adapters)('draws shipped $name as its first letter, not a mark', (adapter) => {
  expect(adapter.logo).toBeUndefined();
  const { container } = render(<AdapterLogo adapter={adapter.id} size={30} />);
  const logo = screen.getByRole('img', { name: adapter.name });
  expect(logo.tagName).toBe('SPAN');
  expect(logo.textContent).toBe(Array.from(adapter.name)[0]?.toLocaleUpperCase());
  expect(container.querySelector('img, svg')).toBeNull();
});

it('draws a catalog logo only as a data image', async () => {
  const logo = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  await loadCatalog(() =>
    Promise.resolve({
      ...MADE_UP,
      adapters: MADE_UP.adapters.map((adapter) => ({ ...adapter, logo })),
    }),
  );
  const { container } = render(<AdapterLogo adapter="zed" size={30} />);
  const image = screen.getByRole<HTMLImageElement>('img', { name: 'Zed Agent' });
  expect(image.tagName).toBe('IMG');
  expect(image.src).toMatch(/^data:image\/svg\+xml,/);
  expect(decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1))).toBe(logo);
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
  expect(getComputedStyle(logo).getPropertyValue('--agent-color')).toBe('#c15f3c');
  expect(getComputedStyle(logo).width).toBe('18px');
  expect(getComputedStyle(logo).height).toBe('18px');
  expect(logo.querySelector('img, svg')).toBeNull();
  // jsdom does not resolve background colours expressed with CSS custom properties.
  expect(css).toContain('background: var(--agent-color)');
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
  expect(
    getComputedStyle(screen.getByRole('img', { name: 'Zed Agent' })).getPropertyValue(
      '--agent-color',
    ),
  ).toBe('#0e8a6b');
});
