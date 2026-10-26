import { vi } from 'vitest';

import type { ConnectionId } from '../../../shared/adapter';
import type { SessionEvent, SessionMode } from '../../../shared/session';
import type { SessionBackend } from './transcript/receive';

/**
 * For tests: stands in for main's sessions (a SessionBackend: window.api's session functions, in the
 * app). It records what the engine asks, and `emit` plays events back as a connector would
 * (src/main/sessions/).
 */
export function fakeBackend() {
  let listener:
    ((agentId: string, connection: ConnectionId, event: SessionEvent) => void) | undefined;
  const backend = {
    start: vi.fn<SessionBackend['start']>().mockResolvedValue(null),
    installed: vi
      .fn<SessionBackend['installed']>()
      .mockResolvedValue({ 'claude-code': false, codex: false }),
    send: vi.fn<SessionBackend['send']>().mockResolvedValue(null),
    answer: vi.fn<SessionBackend['answer']>().mockResolvedValue(null),
    interrupt: vi.fn<SessionBackend['interrupt']>().mockResolvedValue(null),
    setMode: vi.fn<SessionBackend['setMode']>().mockResolvedValue(null),
    setModel: vi.fn<SessionBackend['setModel']>().mockResolvedValue(null),
    setEffort: vi.fn<SessionBackend['setEffort']>().mockResolvedValue(null),
    stopTask: vi.fn<SessionBackend['stopTask']>().mockResolvedValue(null),
    close: vi.fn<SessionBackend['close']>().mockResolvedValue(null),
    fresh: vi.fn<SessionBackend['fresh']>().mockResolvedValue(null),
    files: vi.fn<SessionBackend['files']>().mockResolvedValue([]),
    options: vi.fn<SessionBackend['options']>().mockResolvedValue({
      models: [],
      defaults: { model: null, effort: null, mode: null },
    }),
    sessions: vi.fn<SessionBackend['sessions']>().mockResolvedValue([]),
    resume: vi.fn<SessionBackend['resume']>().mockResolvedValue(null),
    mcp: vi.fn<SessionBackend['mcp']>().mockResolvedValue([]),
    previewRewind: vi
      .fn<SessionBackend['previewRewind']>()
      .mockResolvedValue({ possible: true, files: [], added: 0, removed: 0 }),
    rewind: vi.fn<SessionBackend['rewind']>().mockResolvedValue({ conversation: false }),
    changeMcp: vi.fn<SessionBackend['changeMcp']>().mockResolvedValue([]),
    onEvent: vi.fn<SessionBackend['onEvent']>((given) => {
      listener = given;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    backend,
    /** Main says `events` happened in agent `agentId`'s session, connected through `connection`. */
    emit: (agentId: string, connection: ConnectionId, ...events: SessionEvent[]) => {
      for (const event of events) listener?.(agentId, connection, event);
    },
    /** Whether the engine listens for session events. */
    listening: () => listener !== undefined,
    /** The id of the message last sent. */
    sent: (): string => {
      const message = backend.send.mock.calls.at(-1)?.[1];
      if (!message) throw new Error('nothing was sent');
      return message.id;
    },
  };
}

/**
 * Explicit test-only native events for UI tests that do not need to script every backend turn.
 * Production sessions never import this module. Special cases can override the returned mocks.
 */
export function automaticBackend() {
  const fake = fakeBackend();
  const sessions = new Map<string, { connection: ConnectionId; mode: SessionMode }>();
  const turns = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
  const finish = (agentId: string, interrupted: boolean) => {
    const session = sessions.get(agentId);
    const turn = turns.get(agentId);
    if (!session || !turn) return;
    clearTimeout(turn.timer);
    turns.delete(agentId);
    if (!interrupted)
      fake.emit(agentId, session.connection, {
        type: 'text',
        id: crypto.randomUUID(),
        text: 'SUCCEEDED',
      });
    fake.emit(agentId, session.connection, {
      type: 'end',
      messages: [turn.id],
      seconds: 1,
      result: {
        status: interrupted ? 'cancelled' : 'completed',
        reason: interrupted ? 'interrupted' : 'completed',
      },
    });
  };
  fake.backend.start.mockImplementation((agentId, options) => {
    const mode =
      options.mode ??
      (options.connection === 'codex.app-server' || options.connection === 'codex.terminal'
        ? 'auto'
        : 'manual');
    sessions.set(agentId, { connection: options.connection, mode });
    fake.emit(agentId, options.connection, {
      type: 'started',
      model: options.model,
      mode,
      models: [],
    });
    return Promise.resolve(null);
  });
  fake.backend.send.mockImplementation((agentId, message) => {
    const session = sessions.get(agentId);
    if (!session) return Promise.reject(new Error('Test session was not started'));
    fake.emit(
      agentId,
      session.connection,
      { type: 'user', id: message.id, text: message.text },
      { type: 'status', status: 'working' },
    );
    turns.set(agentId, {
      id: message.id,
      timer: setTimeout(() => {
        finish(agentId, false);
      }, 1000),
    });
    return Promise.resolve(null);
  });
  fake.backend.interrupt.mockImplementation((agentId) => {
    finish(agentId, true);
    return Promise.resolve(null);
  });
  fake.backend.close.mockImplementation((agentId) => {
    finish(agentId, true);
    sessions.delete(agentId);
    return Promise.resolve(null);
  });
  fake.backend.setMode.mockImplementation((agentId, mode) => {
    const session = sessions.get(agentId);
    if (session) {
      session.mode = mode;
      fake.emit(agentId, session.connection, { type: 'mode', mode });
    }
    return Promise.resolve(null);
  });
  fake.backend.setModel.mockImplementation((agentId, model) => {
    const session = sessions.get(agentId);
    if (session) fake.emit(agentId, session.connection, { type: 'model', model });
    return Promise.resolve(null);
  });
  fake.backend.setEffort.mockImplementation((agentId, effort) => {
    const session = sessions.get(agentId);
    if (session) fake.emit(agentId, session.connection, { type: 'effort', effort });
    return Promise.resolve(null);
  });
  return fake;
}
