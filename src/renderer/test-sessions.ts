import { vi } from 'vitest';

import type { ConnectionId, AdapterId } from '../shared/adapter';
import type {
  SessionEvent,
  SessionMode,
  SessionOptions,
  UserMessage,
  SessionAnswer,
  SettingsOptions,
  InstalledClis,
  PastSession,
  McpServer,
  McpChange,
  FilesRewind,
  RewindRestore,
  RewindResult,
} from '../shared/session';
/** Mock answers used by topic fixtures; no engine, driver, queue execution or persistence. */
export interface SessionReplies {
  start(agent: string, options: SessionOptions): Promise<null>;
  installed(): Promise<InstalledClis>;
  send(agent: string, message: UserMessage): Promise<null>;
  answer(agent: string, prompt: string, answer: SessionAnswer): Promise<null>;
  interrupt(agent: string): Promise<null>;
  setMode(agent: string, mode: SessionMode): Promise<null>;
  setModel(agent: string, model: string): Promise<null>;
  setEffort(agent: string, effort: string | null): Promise<null>;
  stopTask(agent: string, task: string): Promise<null>;
  close(agent: string): Promise<null>;
  fresh(agent: string, adapter: AdapterId): Promise<null>;
  files(query: string, agent?: string): Promise<string[]>;
  options(adapter: AdapterId, agent?: string): Promise<SettingsOptions>;
  sessions(agent: string): Promise<PastSession[]>;
  resume(agent: string, id: string): Promise<null>;
  mcp(agent: string): Promise<McpServer[]>;
  previewRewind(agent: string, id: string): Promise<FilesRewind>;
  rewind(agent: string, id: string, restore: RewindRestore): Promise<RewindResult>;
  changeMcp(agent: string, server: string, change: McpChange): Promise<McpServer[]>;
  onEvent(
    listener: (agent: string, connection: ConnectionId, event: SessionEvent) => void,
  ): () => void;
}

/** Scripted operation answers and topic inputs for a window's session widgets. */
export function fakeSessions() {
  let listener:
    ((agentId: string, connection: ConnectionId, event: SessionEvent) => void) | undefined;
  const replies = {
    start: vi.fn<SessionReplies['start']>().mockResolvedValue(null),
    installed: vi
      .fn<SessionReplies['installed']>()
      .mockResolvedValue({ 'claude-code': false, codex: false }),
    send: vi.fn<SessionReplies['send']>().mockResolvedValue(null),
    answer: vi.fn<SessionReplies['answer']>().mockResolvedValue(null),
    interrupt: vi.fn<SessionReplies['interrupt']>().mockResolvedValue(null),
    setMode: vi.fn<SessionReplies['setMode']>().mockResolvedValue(null),
    setModel: vi.fn<SessionReplies['setModel']>().mockResolvedValue(null),
    setEffort: vi.fn<SessionReplies['setEffort']>().mockResolvedValue(null),
    stopTask: vi.fn<SessionReplies['stopTask']>().mockResolvedValue(null),
    close: vi.fn<SessionReplies['close']>().mockResolvedValue(null),
    fresh: vi.fn<SessionReplies['fresh']>().mockResolvedValue(null),
    files: vi.fn<SessionReplies['files']>().mockResolvedValue([]),
    options: vi.fn<SessionReplies['options']>().mockResolvedValue({
      models: [],
      defaults: { model: null, effort: null, mode: null },
    }),
    sessions: vi.fn<SessionReplies['sessions']>().mockResolvedValue([]),
    resume: vi.fn<SessionReplies['resume']>().mockResolvedValue(null),
    mcp: vi.fn<SessionReplies['mcp']>().mockResolvedValue([]),
    previewRewind: vi
      .fn<SessionReplies['previewRewind']>()
      .mockResolvedValue({ possible: true, files: [], added: 0, removed: 0 }),
    rewind: vi.fn<SessionReplies['rewind']>().mockResolvedValue({ conversation: false }),
    changeMcp: vi.fn<SessionReplies['changeMcp']>().mockResolvedValue([]),
    onEvent: vi.fn<SessionReplies['onEvent']>((given) => {
      listener = given;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    replies,
    /** Main says `events` happened in agent `agentId`'s session, connected through `connection`. */
    emit: (agentId: string, connection: ConnectionId, ...events: SessionEvent[]) => {
      for (const event of events) listener?.(agentId, connection, event);
    },
    /** Whether a topic fixture is attached. */
    listening: () => listener !== undefined,
    /** The id of the message last sent. */
    sent: (): string => {
      const message = replies.send.mock.calls.at(-1)?.[1];
      if (!message) throw new Error('nothing was sent');
      return message.id;
    },
  };
}

/**
 * Explicit test-only native events for UI tests that do not need to script every replies turn.
 * Production sessions never import this module. Special cases can override the returned mocks.
 */
export function automaticSessions() {
  const fake = fakeSessions();
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
  fake.replies.start.mockImplementation((agentId, options) => {
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
  fake.replies.send.mockImplementation((agentId, message) => {
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
  fake.replies.interrupt.mockImplementation((agentId) => {
    finish(agentId, true);
    return Promise.resolve(null);
  });
  fake.replies.close.mockImplementation((agentId) => {
    finish(agentId, true);
    sessions.delete(agentId);
    return Promise.resolve(null);
  });
  fake.replies.setMode.mockImplementation((agentId, mode) => {
    const session = sessions.get(agentId);
    if (session) {
      session.mode = mode;
      fake.emit(agentId, session.connection, { type: 'mode', mode });
    }
    return Promise.resolve(null);
  });
  fake.replies.setModel.mockImplementation((agentId, model) => {
    const session = sessions.get(agentId);
    if (session) fake.emit(agentId, session.connection, { type: 'model', model });
    return Promise.resolve(null);
  });
  fake.replies.setEffort.mockImplementation((agentId, effort) => {
    const session = sessions.get(agentId);
    if (session) fake.emit(agentId, session.connection, { type: 'effort', effort });
    return Promise.resolve(null);
  });
  return fake;
}
