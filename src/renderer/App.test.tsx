import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { AppApi } from '../shared/ipc';
import { App } from './App';
import { topics } from './api/topics';

vi.mock('./terminal/screen', async () => {
  const { fakeScreens } = await import('./terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

/** Stubs window.api: the usage functions the canvas reads at once, and `api`. */
function stubApi(api: Partial<AppApi>) {
  const canvas = newCanvasId();
  const usage: Partial<AppApi> = {
    windowGet: vi.fn<AppApi['windowGet']>().mockResolvedValue({ ok: true, value: { canvas } }),
    getRun: vi
      .fn<AppApi['getRun']>()
      .mockResolvedValue({ id: canvas, token: 'test', checkpoint: null }),
    saveRun: vi.fn<AppApi['saveRun']>().mockResolvedValue(null),
    runReady: vi.fn<AppApi['runReady']>().mockResolvedValue(null),
    onRunStopping: vi.fn<AppApi['onRunStopping']>(() => () => undefined),
    topicsSubscribe: vi.fn<AppApi['topicsSubscribe']>().mockResolvedValue({
      ok: true,
      value: { epoch: 'one', rev: 0, state: { readings: [], rules: {} }, revs: {} },
    }),
    topicsUnsubscribe: vi
      .fn<AppApi['topicsUnsubscribe']>()
      .mockResolvedValue({ ok: true, value: { revs: {} } }),
    topicsOnChange: vi.fn<AppApi['topicsOnChange']>(() => () => undefined),
    topicsOnEpoch: vi.fn<AppApi['topicsOnEpoch']>((listener) => {
      listener('one');
      return () => undefined;
    }),
  };
  const subscribe = api.topicsSubscribe ?? usage.topicsSubscribe;
  if (!subscribe) throw new Error('No fixture subscriber');
  const topicsSubscribe: AppApi['topicsSubscribe'] = (args) =>
    args.topic === 'canvas'
      ? Promise.resolve({
          ok: true,
          value: {
            epoch: 'one',
            rev: 0,
            revs: {},
            state: {
              meta: { arrange: false, name: null, edited: false, project: null, rev: 0, by: 'you' },
            },
          },
        })
      : subscribe(args);
  Object.defineProperty(window, 'api', {
    value: { ...usage, ...api, topicsSubscribe },
    configurable: true,
  });
}

describe('App', () => {
  afterEach(async () => {
    // Unmount and finish subscription cleanup while its transport still exists.
    cleanup();
    topics.dispose();
    await Promise.resolve();
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

  it('subscribes to the core’s usage topic and its changes', async () => {
    const topicsSubscribe = vi.fn<AppApi['topicsSubscribe']>().mockResolvedValue({
      ok: true,
      value: { epoch: 'one', rev: 0, state: { readings: [], rules: {} }, revs: {} },
    });
    const topicsOnChange = vi.fn<AppApi['topicsOnChange']>(() => () => undefined);
    stubApi({
      appInfo: vi
        .fn<AppApi['appInfo']>()
        .mockResolvedValue({ ok: true, value: { name: 'corrallm', version: '0.1.0' } }),
      topicsSubscribe,
      topicsOnChange,
    });

    render(<App />);

    await waitFor(() => {
      expect(topicsSubscribe).toHaveBeenCalledWith({ topic: 'usage' });
    });
    expect(topicsOnChange).toHaveBeenCalled();
  });

  it('learns the canvas id from window.get when it restores run progress', async () => {
    const c = newCanvasId();
    const windowGet = vi
      .fn<AppApi['windowGet']>()
      .mockResolvedValue({ ok: true, value: { canvas: c } });
    const saveRun = vi.fn<AppApi['saveRun']>().mockResolvedValue(null);
    stubApi({
      appInfo: vi
        .fn<AppApi['appInfo']>()
        .mockResolvedValue({ ok: true, value: { name: 'corrallm', version: '0.1.0' } }),
      windowGet,
      getRun: vi
        .fn<AppApi['getRun']>()
        .mockResolvedValue({ id: c, token: 'test', checkpoint: null }),
      saveRun,
    });
    render(<App />);
    await waitFor(() => {
      expect(windowGet).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(saveRun).toHaveBeenCalledWith('test', expect.any(Object));
      // A token and a checkpoint, never a document beside them.
      for (const call of saveRun.mock.calls) expect(call).toHaveLength(2);
    });
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
