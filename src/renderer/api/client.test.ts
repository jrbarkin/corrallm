import { afterEach, describe, expect, it, vi } from 'vitest';

import { GUI_OPS } from '../../shared/api/surface';
import { guiFunction } from '../../shared/gui-link';
import type { AppApi } from '../../shared/ipc';
import { api, ApiError } from './client';
import { fakeCore, expectOneOp } from '../test-api';

afterEach(() => {
  Reflect.deleteProperty(window, 'api');
});

function stubApi(bridge: Partial<AppApi>): void {
  Object.defineProperty(window, 'api', { value: bridge, configurable: true });
}

describe('the GUI client', () => {
  it('resolves a write only after every returned topic revision has reached its mirror', async () => {
    const core = fakeCore();
    core.snapshot('usage', { readings: [], rules: {} }, 0);
    core.snapshot('settings', { defaultAdapter: 'codex', consents: {} }, 0);
    core.respond('usage.setRule', { revs: { usage: 1, settings: 2 } });
    const resolved = vi.fn();
    const called = core.api.usageSetRule({ backend: 'codex', rule: null }).then(resolved);
    await vi.waitFor(() => {
      expectOneOp(core, 'usage.setRule', { backend: 'codex', rule: null });
    });
    expect(resolved).not.toHaveBeenCalled();
    core.change({ topic: 'usage', rev: 1, replace: { readings: [], rules: {} } });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    core.change({ topic: 'settings', rev: 2, replace: { defaultAdapter: 'codex', consents: {} } });
    await called;
    expect(resolved).toHaveBeenCalledOnce();
    expect(core.topics.snapshot('settings')).toEqual({ defaultAdapter: 'codex', consents: {} });
    core.dispose();
  });

  it('exposes only the GUI operations, one function per operation', () => {
    expect(Object.keys(api).sort()).toEqual(
      [...GUI_OPS.map(guiFunction), 'terminalOnEvent', 'topicsOnChange', 'topicsOnEpoch'].sort(),
    );
    expect(Object.values(api).every((value) => typeof value === 'function')).toBe(true);
  });

  it('unwraps a value and passes each operation’s arguments to its bridge function', async () => {
    const info = { name: 'corrallm', version: '1.2.3' };
    const appInfo = vi.fn<AppApi['appInfo']>().mockResolvedValue({ ok: true, value: info });
    const usageSetRule = vi.fn<AppApi['usageSetRule']>().mockResolvedValue({ ok: true, value: {} });
    stubApi({ appInfo, usageSetRule });

    await expect(api.appInfo()).resolves.toEqual(info);
    expect(appInfo).toHaveBeenCalledExactlyOnceWith(undefined);
    const args = { backend: 'codex', rule: null };
    await expect(api.usageSetRule(args)).resolves.toEqual({});
    expect(usageSetRule).toHaveBeenCalledExactlyOnceWith(args);
  });

  it('passes File objects to the drop bridge, and subscribes to terminal events without unwrapping them as results', async () => {
    const terminalDrop = vi.fn<AppApi['terminalDrop']>().mockResolvedValue({ ok: true, value: {} });
    const stop = vi.fn();
    const terminalOnEvent = vi.fn<AppApi['terminalOnEvent']>().mockReturnValue(stop);
    stubApi({ terminalDrop, terminalOnEvent });
    const files = [new File(['png'], 'shot.png')];
    await expect(api.terminalDrop({ agent: 'a', files })).resolves.toEqual({});
    expect(terminalDrop).toHaveBeenCalledExactlyOnceWith({ agent: 'a', files });
    const listener = vi.fn();
    expect(api.terminalOnEvent(listener)).toBe(stop);
    expect(terminalOnEvent).toHaveBeenCalledExactlyOnceWith(listener);
  });

  it('throws a renderer error whose code, sentence and message survive the bridge', async () => {
    const error = {
      code: 'forbidden',
      sentence: 'That operation is not available to this caller.',
    } as const;
    stubApi({ appInfo: vi.fn<AppApi['appInfo']>().mockResolvedValue({ ok: false, error }) });

    const called = api.appInfo();
    await expect(called).rejects.toBeInstanceOf(ApiError);
    await expect(called).rejects.toMatchObject({ ...error, message: error.sentence });
  });
});
