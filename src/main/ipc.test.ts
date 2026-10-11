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

import { MAX_CANVAS_BYTES } from '../shared/ipc';
import { registerIpcHandlers } from './ipc';

const TRUSTED_ORIGIN = 'app://main_window';

function frame(origin: string, overrides: Record<string, unknown> = {}) {
  return { origin, detached: false, parent: null, ...overrides };
}

function listenerFor(name: string) {
  registerIpcHandlers(TRUSTED_ORIGIN);
  const call = handle.mock.calls.find(([channel]) => channel === name);
  if (call === undefined) throw new Error(`${name} was not registered`);
  return call[1];
}

const pingListener = () => listenerFor('app:ping');

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

describe('canvas:save handler', () => {
  beforeEach(() => {
    handle.mockReset();
  });

  it.each([
    ['no arguments', [], /Expected the canvas text/],
    ['text that is not a string', [42, false], /Expected the canvas text/],
    ['a choice that is not a boolean', ['{}', 'yes'], /Expected the canvas text/],
    ['an extra argument', ['{}', false, 'more'], /Expected the canvas text/],
    ['a canvas too large to save', ['x'.repeat(MAX_CANVAS_BYTES + 1), false], /too large/],
  ])('rejects %s', (_label, args, message) => {
    const listener = listenerFor('canvas:save');
    expect(() => listener({ senderFrame: frame(TRUSTED_ORIGIN) }, ...args)).toThrow(message);
  });
});
