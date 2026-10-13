import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppApi } from '../shared/ipc';
import { App } from './App';

/** Stubs window.api: the usage functions the canvas reads at once, and `api`. */
function stubApi(api: Partial<AppApi>) {
  const usage: Partial<AppApi> = {
    getUsage: vi.fn<AppApi['getUsage']>().mockResolvedValue({ readings: [], rules: {} }),
    onUsageChanged: vi.fn<AppApi['onUsageChanged']>(() => () => undefined),
  };
  Object.defineProperty(window, 'api', { value: { ...usage, ...api }, configurable: true });
}

describe('App', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('shows the version returned by window.api.ping()', async () => {
    const ping = vi.fn<AppApi['ping']>().mockResolvedValue('corrallm 0.1.0');
    stubApi({ ping });

    render(<App />);

    const result = screen.getByTestId('ping-result');
    await waitFor(() => {
      expect(result.dataset.status).toBe('ok');
    });
    expect(result.textContent).toBe('corrallm 0.1.0');
    expect(ping).toHaveBeenCalled();
  });

  it('reads the usage readings and rules main keeps, and hears their changes', async () => {
    const getUsage = vi.fn<AppApi['getUsage']>().mockResolvedValue({ readings: [], rules: {} });
    const onUsageChanged = vi.fn<AppApi['onUsageChanged']>(() => () => undefined);
    stubApi({
      ping: vi.fn<AppApi['ping']>().mockResolvedValue('corrallm 0.1.0'),
      getUsage,
      onUsageChanged,
    });

    render(<App />);

    await waitFor(() => {
      expect(getUsage).toHaveBeenCalled();
    });
    expect(onUsageChanged).toHaveBeenCalled();
  });

  it('shows an error when the ping fails', async () => {
    stubApi({ ping: vi.fn<AppApi['ping']>().mockRejectedValue(new Error('boom')) });

    render(<App />);

    const result = screen.getByTestId('ping-result');
    await waitFor(() => {
      expect(result.dataset.status).toBe('error');
    });
    expect(result.textContent).toBe('Ping failed: boom');
  });
});
