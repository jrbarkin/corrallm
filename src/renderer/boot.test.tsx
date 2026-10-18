import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import type { Catalog } from '../shared/adapter';
import { boot } from './boot';
import { catalog } from './catalog';

describe('boot', () => {
  it('mounts the app only once the catalog has loaded', async () => {
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
