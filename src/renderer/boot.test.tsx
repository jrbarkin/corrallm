import { act } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MADE_UP } from '../shared/test-made-up';
import { useCatalog } from './test-catalog';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import type { Catalog } from '../shared/adapter';
import { boot } from './boot';
import { catalog } from './catalog';

describe('boot', () => {
  it('mounts the app only once the catalog has loaded', async () => {
    await useCatalog(catalog());
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let give: (catalog: Catalog) => void = () => undefined;
    const loading = new Promise<Catalog>((resolve) => {
      give = resolve;
    });
    let booted = false;
    void boot(root, () => loading, <p>mounted</p>).then(() => {
      booted = true;
    });

    await act(() => Promise.resolve());
    expect(container.textContent).toBe('');
    expect(booted).toBe(false);

    const loaded: Catalog = { adapters: [], usageBackends: [] };
    await act(async () => {
      give(loaded);
      await loading;
    });
    expect(container.textContent).toBe('mounted');
    expect(booted).toBe(true);
    expect(catalog()).toBe(loaded);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

it('shows only a retryable catalog error and mounts using the successful retry’s catalog', async () => {
  await useCatalog(catalog());
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let calls = 0;
  function App() {
    return <p>{catalog().adapters[0]?.name}</p>;
  }
  await act(async () => {
    await boot(
      root,
      () =>
        ++calls === 1 ? Promise.reject(new Error('catalog offline')) : Promise.resolve(MADE_UP),
      <App />,
    );
  });
  expect(screen.getByRole('alert').textContent).toContain('catalog');
  expect(screen.queryByText('Zed Agent')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => {
    expect(screen.getByText('Zed Agent')).toBeTruthy();
  });
  expect(calls).toBe(2);
  expect(screen.queryByRole('alert')).toBeNull();
  act(() => {
    root.unmount();
  });
  container.remove();
});
