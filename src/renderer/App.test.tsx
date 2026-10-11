import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppApi } from '../shared/ipc';
import { App } from './App';

function stubApi(api: AppApi) {
  Object.defineProperty(window, 'api', { value: api, configurable: true });
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
