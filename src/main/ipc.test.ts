import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests never load the real 'electron' module (importing it would download the binary).
const { handle } = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void>(),
}));
vi.mock('electron', () => ({
  app: { getName: () => 'corrallm', getVersion: () => '0.1.0' },
  ipcMain: { handle },
}));

import { registerIpcHandlers } from './ipc';

const TRUSTED_ORIGIN = 'app://main_window';

function frame(origin: string, overrides: Record<string, unknown> = {}) {
  return { origin, detached: false, parent: null, ...overrides };
}

function pingListener() {
  registerIpcHandlers(TRUSTED_ORIGIN);
  const call = handle.mock.calls.find(([channel]) => channel === 'app:ping');
  if (call === undefined) throw new Error('app:ping was not registered');
  return call[1];
}

describe('app:ping handler', () => {
  beforeEach(() => {
    handle.mockReset();
  });

  it('returns the version string to the trusted renderer', () => {
    const listener = pingListener();
    const result = listener({ senderFrame: frame(TRUSTED_ORIGIN) });
    expect(result).toMatch(/^corrallm 0\.1\.0 \(Electron .*, Chromium .*, Node .*\)$/);
  });

  it.each([
    ['a null sender frame', null],
    ['another origin', frame('https://evil.example')],
    ['a subframe', frame(TRUSTED_ORIGIN, { parent: {} })],
    ['a detached frame', frame(TRUSTED_ORIGIN, { detached: true })],
  ])('rejects %s', (_label, senderFrame) => {
    const listener = pingListener();
    expect(() => listener({ senderFrame })).toThrow(/untrusted sender/);
  });

  it('rejects unexpected arguments', () => {
    const listener = pingListener();
    expect(() => listener({ senderFrame: frame(TRUSTED_ORIGIN) }, 'extra')).toThrow(
      /Expected no arguments/,
    );
  });
});
