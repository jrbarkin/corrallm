import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handle } = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void>(),
}));
vi.mock('electron', () => ({ ipcMain: { handle } }));

import { registerIpcHandlers } from './ipc';

const TRUSTED_ORIGIN = 'app://main_window';
const services = { core: { connect: vi.fn() } };
const frame = (origin: string, overrides: Record<string, unknown> = {}) => ({
  origin,
  detached: false,
  parent: null,
  ...overrides,
});
function listenerFor(name: string) {
  registerIpcHandlers(TRUSTED_ORIGIN, services.core);
  const call = handle.mock.calls.find(([channel]) => channel === name);
  if (!call) throw new Error(`${name} was not registered`);
  return call[1];
}
function invoke(name: string, args: unknown[], sender: unknown = { id: 7 }) {
  return listenerFor(name)({ senderFrame: frame(TRUSTED_ORIGIN), sender }, ...args);
}
beforeEach(() => {
  handle.mockReset();
  services.core.connect.mockReset();
});

describe('core:connect handler', () => {
  it('hands the trusted window that asks a port to the core', () => {
    const sender = { id: 7 };
    expect(invoke('core:connect', [], sender)).toBeNull();
    expect(services.core.connect).toHaveBeenCalledExactlyOnceWith(sender);
  });

  it.each([
    ['a null sender frame', null],
    ['another origin', frame('https://evil.example')],
    ['a subframe', frame(TRUSTED_ORIGIN, { parent: {} })],
    ['a detached frame', frame(TRUSTED_ORIGIN, { detached: true })],
  ])('refuses %s, handing it no port', (_label, senderFrame) => {
    const listener = listenerFor('core:connect');
    expect(() => listener({ senderFrame, sender: { id: 7 } })).toThrow(/untrusted sender/);
    expect(services.core.connect).not.toHaveBeenCalled();
  });

  it('takes no arguments', () => {
    expect(() => invoke('core:connect', ['window 1'])).toThrow(/Expected no arguments/);
    expect(services.core.connect).not.toHaveBeenCalled();
  });
});

it('registers only the port handshake in main', () => {
  registerIpcHandlers(TRUSTED_ORIGIN, services.core);
  expect(handle.mock.calls.map(([name]) => name)).toEqual(['core:connect']);
});
