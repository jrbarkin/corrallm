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
    catalogInstalled: vi.fn<AppApi['catalogInstalled']>().mockResolvedValue({
      ok: true,
      value: {},
    }),
    templatesList: vi.fn<AppApi['templatesList']>().mockResolvedValue({
      ok: true,
      value: { items: [] },
    }),
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
      : args.topic === 'canvases'
        ? Promise.resolve({
            ok: true,
            value: { epoch: 'one', rev: 0, revs: {}, state: { items: [] } },
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

  it('binds all five view topics to the canvas window.get names, never restoring or saving a run', async () => {
    const c = newCanvasId();
    const subscribe = vi.fn<AppApi['topicsSubscribe']>((args) =>
      Promise.resolve({
        ok: true,
        value: {
          epoch: 'one',
          rev: 0,
          revs: {},
          state:
            args.topic === 'run'
              ? { running: false, agents: {}, groups: {}, notices: [] }
              : args.topic === 'sessions'
                ? { agents: {} }
                : args.topic === 'messages'
                  ? { items: {}, order: [], next: '' }
                  : args.topic === 'needs'
                    ? { items: [] }
                    : { readings: [], rules: {} },
        },
      } as Awaited<ReturnType<AppApi['topicsSubscribe']>>),
    );
    stubApi({
      windowGet: vi.fn().mockResolvedValue({ ok: true, value: { canvas: c } }),
      topicsSubscribe: subscribe,
      appInfo: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { name: 'corrallm', version: '0.1.0' } }),
    });
    render(<App />);
    await waitFor(() => {
      for (const topic of ['run', 'needs', 'sessions', 'messages'])
        expect(subscribe).toHaveBeenCalledWith({ topic, canvas: c });
    });
    expect(window.api).not.toHaveProperty('getRun');
    expect(window.api).not.toHaveProperty('saveRun');
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
