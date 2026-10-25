import { afterEach, describe, expect, it, vi } from 'vitest';

import { GUI_OPS } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import { guiFunction } from '../../shared/gui-link';
import type { AppApi } from '../../shared/ipc';
import { canvasStateOf } from '../../shared/model/state';
import type { Entities, MetaEntity, NodeEntity } from '../../shared/model/state';
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
    const settings = {
      defaultAdapter: 'codex',
      consents: {},
      api: { state: 'stopped', port: null },
    } as const;
    core.snapshot('settings', settings, 0);
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
    core.change({ topic: 'settings', rev: 2, replace: settings });
    await called;
    expect(resolved).toHaveBeenCalledOnce();
    expect(core.topics.snapshot('settings')).toEqual(settings);
    core.dispose();
  });

  it('resolves a document op only once its canvas’s copy reached the revision it committed', async () => {
    const core = fakeCore();
    const canvas = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;
    const topic = `canvas:${canvas}` as const;
    const meta: MetaEntity = {
      arrange: false,
      name: 'work.corral',
      edited: false,
      project: null,
      rev: 0,
      by: 'you',
    };
    const lead: NodeEntity = {
      id: 'lead',
      kind: 'agent',
      place: 0,
      label: 'Lead',
      x: 0,
      y: 0,
      rev: 1,
      by: 'you',
    };
    const entities: Entities = { meta, 'node/lead': lead };
    core.snapshot(topic, entities, 1);
    core.respond('canvas.rename', { revs: { [topic]: 2 } });
    const resolved = vi.fn();
    const renaming = core.api.canvasRename({ canvas, node: 'lead', label: 'Boss' }).then(resolved);
    await vi.waitFor(() => {
      expectOneOp(core, 'canvas.rename', { canvas, node: 'lead', label: 'Boss' });
    });
    // The mirror subscribed to the canvas for it, and has its snapshot, but not the commit yet.
    await vi.waitFor(() => {
      expect(core.topics.snapshot(topic)).toBeDefined();
    });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    core.change({
      topic,
      rev: 2,
      set: {
        'node/lead': { ...lead, label: 'Boss', rev: 2 },
        meta: { ...meta, edited: true, rev: 2 },
      },
    });
    await renaming;
    expect(resolved).toHaveBeenCalledExactlyOnceWith({ revs: { [topic]: 2 } });
    const state = canvasStateOf(canvas, 2, core.topics.snapshot(topic) ?? {});
    expect(state.nodes).toEqual([
      { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Boss' } },
    ]);
    expect(state).toMatchObject({ name: 'work.corral', edited: true, rev: 2 });
    expect(state.entities['node/lead']).toEqual({ rev: 2, by: 'you' });
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
    const usageSetRule = vi
      .fn<AppApi['usageSetRule']>()
      .mockResolvedValue({ ok: true, value: { revs: {} } });
    stubApi({ appInfo, usageSetRule });

    await expect(api.appInfo()).resolves.toEqual(info);
    expect(appInfo).toHaveBeenCalledExactlyOnceWith(undefined);
    const args = { backend: 'codex', rule: null };
    await expect(api.usageSetRule(args)).resolves.toEqual({ revs: {} });
    expect(usageSetRule).toHaveBeenCalledExactlyOnceWith(args);
  });

  it('passes File objects to the drop bridge, and subscribes to terminal events without unwrapping them as results', async () => {
    const terminalDrop = vi
      .fn<AppApi['terminalDrop']>()
      .mockResolvedValue({ ok: true, value: { revs: {} } });
    const stop = vi.fn();
    const terminalOnEvent = vi.fn<AppApi['terminalOnEvent']>().mockReturnValue(stop);
    stubApi({ terminalDrop, terminalOnEvent });
    const files = [new File(['png'], 'shot.png')];
    await expect(api.terminalDrop({ agent: 'a', files })).resolves.toEqual({ revs: {} });
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

  it('keeps what a conflict says the entities it is over are now', async () => {
    const error = {
      code: 'conflict',
      sentence: 'node/lead is at revision 3, not 2.',
      current: { 'node/lead': { rev: 3, value: null } },
    } as const;
    stubApi({ appInfo: vi.fn<AppApi['appInfo']>().mockResolvedValue({ ok: false, error }) });
    await expect(api.appInfo()).rejects.toMatchObject(error);
  });
});
