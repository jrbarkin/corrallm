import type { SessionBackend } from '../../shared/engine/transcript/receive';
import type { MessageImage, UserMessage, FilesRewind, RewindResult } from '../../shared/session';
import type { MirrorStates } from '../api/topic-wire';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import { isOpen, NEW_SESSION } from '../../shared/model/session';
import type { Entry, Session } from '../../shared/model/session';
import type { EntryView, MessageView, SessionSummary, SessionView } from '../../shared/model/views';
import { submissionOf } from '../queues/messages';
import { orderedEntries } from '../api/runtime';
import type { TopicMirror } from '../api/topics';
import { fromMain } from '../ipc-error';
import type { AdapterId } from '../../shared/adapter';
import type { SessionControls } from '../agent/AgentView';
import { viewWrite } from '../useDraft';

/** Read queries still on the transitional channels; X13 replaces these session panels. */
export interface ManualSubmissions {
  send(agent: string, message: UserMessage): Promise<unknown>;
  record(agent: string, message: UserMessage): Promise<null>;
  unqueue(agent: string, id: string): Promise<null>;
}

/** X13 removes this fixed-channel bridge; execution and queue ownership stay in the core. */
const nativeManual: ManualSubmissions = {
  send: (agent, message) => viewWrite(() => fromMain(window.api.sendToSession(agent, message))),
  record: (agent, message) =>
    viewWrite(() => fromMain(window.api.recordSessionCommand(agent, message))),
  unqueue: (agent, id) => viewWrite(() => fromMain(window.api.unqueueSession(agent, id))),
};

export type SessionQueries = Pick<
  SessionBackend,
  'options' | 'files' | 'sessions' | 'resume' | 'mcp' | 'changeMcp' | 'installed'
> & { manual?: ManualSubmissions; presentation?: SessionPresentation };

export interface Presentation {
  suggestion?: string;
  asking?: Session['asking'];
  images?: ReadonlyMap<string, MessageImage[]>;
}
export interface SessionPresentation {
  snapshot(agent: string): Presentation | undefined;
  subscribe(listener: () => void): () => void;
}
/** X13 removes this view-only supplement for fields absent from the frozen summary DTO. */
const presentations = new Map<CanvasId, Map<string, Presentation>>();
const presentationListeners = new Set<() => void>();
const publishPresentation = () => {
  for (const listener of presentationListeners) listener();
};
const updatePresentation = (canvas: CanvasId, agent: string, change: Presentation) => {
  let byAgent = presentations.get(canvas);
  if (!byAgent) presentations.set(canvas, (byAgent = new Map<string, Presentation>()));
  byAgent.set(agent, { ...byAgent.get(agent), ...change });
  publishPresentation();
};
function nativePresentation(canvas: CanvasId): SessionPresentation {
  return {
    snapshot: (agent) => presentations.get(canvas)?.get(agent),
    subscribe: (listener) => {
      presentationListeners.add(listener);
      const stop = window.api.onSessionEvent((agent, _connection, event) => {
        if (event.type === 'suggestion')
          updatePresentation(canvas, agent, { suggestion: event.text });
        if (event.type === 'asking') updatePresentation(canvas, agent, { asking: event.asks });
        if (event.type === 'user' || event.type === 'closed' || event.type === 'cleared')
          updatePresentation(canvas, agent, { suggestion: '', asking: [] });
      });
      return () => {
        stop();
        presentationListeners.delete(listener);
      };
    },
  };
}
export const nativeQueries: SessionQueries = {
  installed: () => import('../api/client').then(({ api }) => api.catalogInstalled()),
  options: (adapter) => fromMain(window.api.settingsOptions(adapter)),
  files: (query) =>
    import('../agent/completion').then(({ findProjectFiles }) => findProjectFiles(query)),
  sessions: (agent) => fromMain(window.api.listSessions(agent)),
  resume: (agent, conversation) => fromMain(window.api.resumeSession(agent, conversation)),
  mcp: (agent) => fromMain(window.api.mcpServers(agent)),
  changeMcp: (agent, server, change) => fromMain(window.api.changeMcpServer(agent, server, change)),
};

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function copy<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}
const entries = new WeakMap<EntryView, Entry>();
function entryOf(value: EntryView): Entry {
  let entry = entries.get(value);
  if (!entry) {
    if (value.kind === 'user') {
      const { images, ...text } = value;
      entry = { ...text, ...(images === undefined ? {} : { imageCount: images }) };
    } else entry = copy(value);
    entries.set(value, entry);
  }
  return entry;
}

/** Display data only: no sends, queue ownership, timers, restore or native event receiver. */
export function sessionDisplay(
  summary: SessionSummary | undefined,
  view?: SessionView,
  messages: readonly MessageView[] = [],
  presentation?: Presentation,
): Session {
  if (!summary) return NEW_SESSION;
  const shown = orderedEntries(view).map(entryOf);
  const { running, usage, modes, ...top } = copy(summary);
  return {
    ...top,
    ...(running === undefined ? {} : { running }),
    ...(usage === undefined ? {} : { usage }),
    ...(modes === undefined ? {} : { modes }),
    ...(presentation?.suggestion ? { suggestion: presentation.suggestion } : {}),
    ...(presentation?.asking?.length ? { asking: presentation.asking } : {}),
    entries: shown.map((entry) => {
      if (entry.kind !== 'user') return entry;
      const message = messages.find(
        (message) => message.delivery?.as === entry.id || message.id === entry.id,
      );
      const images = presentation?.images?.get(message?.id ?? entry.id);
      return images ? { ...entry, images } : entry;
    }),
    submissions: messages
      .filter(
        (message) =>
          message.to === `agent:${summary.agent}` &&
          message.kind === 'text' &&
          message.origin !== 'run',
      )
      .map((message) => submissionOf(message, messages)),
    prompts: shown.filter(isOpen),
    queued: messages
      .filter(
        (message) =>
          message.to === `agent:${summary.agent}` &&
          message.kind === 'text' &&
          message.state === 'pending',
      )
      .map((message) => ({ id: message.id, text: message.display?.text ?? message.body })),
  };
}

/** Native controls delegate to C services; the component's retained local state is view state. */
export function sessionCommands(
  api: GuiApi,
  canvas: CanvasId,
  agent: string,
  mirror: TopicMirror,
  failed: (error: unknown) => void,
  queries: SessionQueries = nativeQueries,
): SessionControls {
  const act = (call: Promise<unknown>) => {
    void call.catch(failed);
  };
  const prompt = (id: string) => {
    const need = mirror
      .snapshot(`needs:${canvas}`)
      ?.items.find(
        (need) =>
          need.agent === agent &&
          need.id.startsWith(`prompt/${encodeURIComponent(agent)}/`) &&
          need.id.endsWith(`/${id}`),
      );
    if (!need) throw new Error('That prompt is no longer current.');
    return need;
  };
  return {
    recordSubmission: (text, images) => {
      act(
        (queries.manual ?? nativeManual).record(agent, {
          id: crypto.randomUUID(),
          text,
          ...(images ? { images } : {}),
        }),
      );
    },
    open: () => {
      act(api.sessionOpen({ canvas, agent }));
    },
    send: (text, images) => {
      act(
        (queries.manual ?? nativeManual)
          .send(agent, { id: crypto.randomUUID(), text, ...(images ? { images } : {}) })
          .then((result) => {
            if (
              images &&
              result &&
              typeof result === 'object' &&
              'id' in result &&
              typeof result.id === 'string'
            ) {
              const pasted = new Map(presentations.get(canvas)?.get(agent)?.images);
              pasted.set(result.id, images);
              updatePresentation(canvas, agent, { images: pasted });
            }
          }),
      );
    },
    stop: () => {
      act(api.sessionInterrupt({ canvas, agent }));
    },
    unqueue: (id) => {
      act((queries.manual ?? nativeManual).unqueue(agent, id));
    },
    setMode: (mode) => {
      act(api.sessionSetMode({ canvas, agent, mode }));
    },
    setModel: (model) => {
      act(api.sessionSetModel({ canvas, agent, model }));
    },
    setEffort: (effort) => {
      act(api.sessionSetEffort({ canvas, agent, effort }));
    },
    stopTask: (task) => {
      act(api.sessionStopTask({ canvas, agent, task }));
    },
    restart: () => {
      act(api.sessionRestart({ canvas, agent }));
    },
    settingsOptions: (adapter: AdapterId) => queries.options(adapter),
    findFiles: (query) => queries.files(query),
    pastSessions: () => queries.sessions(agent),
    resume: (conversation) => queries.resume(agent, conversation).then(() => undefined),
    previewRewind: (message) =>
      api.sessionRewindPreview({ canvas, agent, message }).then(
        (result) =>
          ({
            ...result,
            ...(result.error === undefined ? {} : { error: result.error }),
          }) as FilesRewind,
      ),
    rewind: (message, restore) =>
      api.sessionRewind({ canvas, agent, message, restore }).then((result) => {
        if ('proposed' in result) throw new Error('Rewind needs approval.');
        return copy(result) as RewindResult;
      }),
    mcpServers: () => queries.mcp(agent),
    changeMcpServer: async (server, change) => {
      return queries.changeMcp(agent, server, change);
    },
    answer: (id, permission, feedback) => {
      act(
        api.reply({
          canvas,
          to: prompt(id).id,
          answer: { permission, ...(feedback === undefined ? {} : { feedback }) },
        }),
      );
    },
    answerQuestion: (id, index, answer) => {
      const need = prompt(id),
        question = need.questions?.[index];
      if (!question) throw new Error('That question is no longer current.');
      act(api.reply({ canvas, to: need.id, answer: { answers: { [question.id]: answer } } }));
    },
    answerPlan: (id, plan) => {
      act(api.reply({ canvas, to: prompt(id).id, answer: { plan } }));
    },
    answerElicitation: (id, action, values) => {
      act(
        api.reply({
          canvas,
          to: prompt(id).id,
          answer: { form: { action, ...(values === undefined ? {} : { values }) } },
        }),
      );
    },
  };
}

export function useDisplayedSession(
  canvas: CanvasId,
  agent: string | undefined,
  mirror: TopicMirror,
  summaries: Readonly<Record<string, SessionSummary>> | undefined,
  messages: MirrorStates[`messages:${CanvasId}`] | undefined,
  queries: SessionQueries = nativeQueries,
): Session {
  const presentation = useMemo(
    () => queries.presentation ?? nativePresentation(canvas),
    [queries, canvas],
  );
  const extras = useSyncExternalStore(
    useCallback(
      (listener) => (agent === undefined ? () => undefined : presentation.subscribe(listener)),
      [agent, presentation],
    ),
    useCallback(
      () => (agent === undefined ? undefined : presentation.snapshot(agent)),
      [agent, presentation],
    ),
  );
  const topic =
    agent === undefined ? undefined : (`session:${canvas}:${encodeURIComponent(agent)}` as const);
  const view = useSyncExternalStore(
    useCallback(
      (listener) => (topic === undefined ? () => undefined : mirror.subscribe(topic, listener)),
      [mirror, topic],
    ),
    useCallback(() => (topic === undefined ? undefined : mirror.snapshot(topic)), [mirror, topic]),
  );
  return useMemo(
    () =>
      sessionDisplay(
        agent === undefined ? undefined : summaries?.[agent],
        view,
        agent === undefined ? [] : Object.values(messages?.items ?? {}),
        extras,
      ),
    [agent, summaries, view, messages, extras],
  );
}
