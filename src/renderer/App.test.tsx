import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { AppApi } from '../shared/ipc';
import { App } from './App';

vi.mock('./terminal/screen', async () => {
  const { fakeScreens } = await import('./terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

/** Stubs window.api: the usage functions the canvas reads at once, and `api`. */
function stubApi(api: Partial<AppApi>) {
  const usage: Partial<AppApi> = {
    getRun: vi
      .fn<AppApi['getRun']>()
      .mockResolvedValue({ id: newCanvasId(), token: 'test', checkpoint: null, name: null }),
    saveRun: vi.fn<AppApi['saveRun']>().mockResolvedValue(null),
    runReady: vi.fn<AppApi['runReady']>().mockResolvedValue(null),
    onRunStopping: vi.fn<AppApi['onRunStopping']>(() => () => undefined),
    getUsage: vi.fn<AppApi['getUsage']>().mockResolvedValue({ readings: [], rules: {} }),
    onUsageChanged: vi.fn<AppApi['onUsageChanged']>(() => () => undefined),
  };
  Object.defineProperty(window, 'api', { value: { ...usage, ...api }, configurable: true });
}

describe('App', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('shows which corrallm this is, as the core says (app.info)', async () => {
    const appInfo = vi
      .fn<AppApi['appInfo']>()
      .mockResolvedValue({ ok: true, value: { name: 'corrallm', version: '0.1.0' } });
    stubApi({ appInfo });

    render(<App />);

    const result = screen.getByTestId('app-info');
    await waitFor(() => {
      expect(result.dataset.status).toBe('ok');
    });
    expect(result.textContent).toBe('corrallm 0.1.0');
    expect(appInfo).toHaveBeenCalled();
  });

  it('reads the usage readings and rules main keeps, and hears their changes', async () => {
    const getUsage = vi.fn<AppApi['getUsage']>().mockResolvedValue({ readings: [], rules: {} });
    const onUsageChanged = vi.fn<AppApi['onUsageChanged']>(() => () => undefined);
    stubApi({
      appInfo: vi
        .fn<AppApi['appInfo']>()
        .mockResolvedValue({ ok: true, value: { name: 'corrallm', version: '0.1.0' } }),
      getUsage,
      onUsageChanged,
    });

    render(<App />);

    await waitFor(() => {
      expect(getUsage).toHaveBeenCalled();
    });
    expect(onUsageChanged).toHaveBeenCalled();
  });

  it('says so when the core can’t say', async () => {
    stubApi({
      appInfo: vi
        .fn<AppApi['appInfo']>()
        .mockResolvedValue({ ok: false, error: { code: 'unavailable', sentence: 'boom' } }),
    });

    render(<App />);

    const result = screen.getByTestId('app-info');
    await waitFor(() => {
      expect(result.dataset.status).toBe('error');
    });
    expect(result.textContent).toBe('corrallm’s core didn’t answer: boom');
  });
});
