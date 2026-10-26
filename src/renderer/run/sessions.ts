import type {
  MessageImage,
  UserMessage,
  FilesRewind,
  RewindResult,
  SettingsOptions,
  PastSession,
  McpServer,
  McpChange,
  InstalledClis,
} from '../../shared/session';
import { imageBytes } from '../../shared/session';
import { MAX_IMAGE_TOTAL } from '../../shared/api/limits';
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
import { viewSend, viewWrite } from '../useDraft';
import { ApiError } from '../api/client';

/** Pending C operation contracts; see renderer.md's remaining X13 dependencies. */
export interface ManualSubmissions {
  record(agent: string, message: UserMessage): Promise<null>;
}

/** Kept until C supplies the view-command record contract; never owns execution. */
const nativeManual: ManualSubmissions = {
  record: (agent, message) =>
    viewWrite(() => fromMain(window.api.recordSessionCommand(agent, message))),
};

/**
 * The most bytes of pasted images this window keeps to preview what it sent: the newest first,
 * by the message the core minted for them. View state only: no topic carries image bytes (B11 §5),
 * so another window, a reload or a restart shows how many there were, not what.
 */
export const MAX_PREVIEW_BYTES = 2 * MAX_IMAGE_TOTAL;
let previews: ReadonlyMap<string, readonly MessageImage[]> = new Map();
const previewListeners = new Set<() => void>();
/** Keeps the images sent with message `id` to preview, dropping the oldest past the budget. */
export function keepPreview(id: string, images: readonly MessageImage[]): void {
  const next = new Map(previews);
  next.delete(id);
  next.set(id, images);
  const size = (kept: readonly MessageImage[]) =>
    kept.reduce((sum, { data }) => sum + imageBytes(data), 0);
  let bytes = [...next.values()].reduce((sum, kept) => sum + size(kept), 0);
  for (const [oldest, kept] of next) {
    if (bytes <= MAX_PREVIEW_BYTES) break;
    next.delete(oldest);
    bytes -= size(kept);
  }
  previews = next;
  for (const listener of previewListeners) listener();
}
/** The previews this window keeps, by message: an immutable snapshot. */
export function imagePreviews(): ReadonlyMap<string, readonly MessageImage[]> {
  return previews;
}
function subscribePreviews(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

export interface SessionQueries {
  installed(): Promise<InstalledClis>;
  options(adapter: AdapterId, agent?: string): Promise<SettingsOptions>;
  sessions(agent: string): Promise<PastSession[]>;
  resume(agent: string, conversation: string): Promise<unknown>;
  mcp(agent: string): Promise<McpServer[]>;
  changeMcp(agent: string, server: string, change: McpChange): Promise<McpServer[]>;
  manual?: ManualSubmissions;
  presentation?: SessionPresentation;
}

export interface Presentation {
  suggestion?: string;
  asking?: Session['asking'];
  images?: ReadonlyMap<string, readonly MessageImage[]>;
}
export interface SessionPresentation {
  snapshot(agent: string): Presentation | undefined;
  subscribe(listener: () => void): () => void;
}
/** Awaiting C's bounded topic projection for these fields absent from the frozen DTO. */
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
export function nativePresentation(canvas: CanvasId): SessionPresentation {
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
  options: (adapter, agent) =>
    fromMain(window.api.settingsOptions(adapter, ...(agent === undefined ? [] : [agent]))),
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
  const received = new Set(
    shown.flatMap((entry) => (entry.kind === 'user' && entry.reached ? [entry.id] : [])),
  );
  const queued = messages.filter(
    (message) =>
      message.to === `agent:${summary.agent}` &&
      message.kind === 'text' &&
      (message.state === 'pending' ||
        (message.state === 'delivering' && !received.has(message.delivery?.as ?? message.id))),
  );
  const queuedIds = new Set(queued.map(({ id }) => id));
  const lastUser = shown.findLastIndex((entry) => entry.kind === 'user');
  const nativeTurn =
    summary.status !== 'idle' && lastUser > shown.findLastIndex((entry) => entry.kind === 'end')
      ? shown[lastUser]?.id
      : undefined;
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
      return images ? { ...entry, images: [...images] } : entry;
    }),
    submissions: messages
      .filter(
        (message) =>
          message.to === `agent:${summary.agent}` &&
          message.kind === 'text' &&
          message.origin !== 'run',
      )
      .map((message) => {
        const submission = submissionOf(message, messages);
        if (queuedIds.has(message.id)) return { ...submission, status: 'queued' as const };
        // Native Terminal submissions are durable restart records, not Delivery-owned sends.
        // Only the live transcript can establish that this exact turn is still running.
        if (message.state === 'unresolved' && message.delivery?.as === nativeTurn) {
          const live = { ...submission, status: 'running' as const };
          delete live.result;
          delete live.unresolved;
          return live;
        }
        return submission;
      }),
    prompts: shown.filter(isOpen),
    queued: queued.map((message) => ({
      id: message.id,
      text: message.display?.text ?? message.body,
    })),
  };
}

/** The core's viewed-session lease publishes startup refusals in the session itself. */
export function openViewedSession(
  api: GuiApi,
  canvas: CanvasId,
  agent: string,
  failed: (error: unknown) => void,
): void {
  void api.sessionOpen({ canvas, agent }).catch((error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== 'unavailable') failed(error);
  });
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
      openViewedSession(api, canvas, agent, failed);
    },
    // Your message, whole (B11 §16.6): its id is the core's, which its previews are kept by.
    send: (text, images) => {
      const pasted = images?.length ? images : undefined;
      act(
        viewSend(() =>
          api.message({ canvas, to: agent, body: text, ...(pasted ? { images: pasted } : {}) }),
        ).then(({ id }) => {
          if (pasted) keepPreview(id, pasted);
        }),
      );
    },
    stop: () => {
      act(api.sessionInterrupt({ canvas, agent }));
    },
    unqueue: (id) => {
      act(api.withdraw({ canvas, id }));
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
    settingsOptions: (adapter: AdapterId) => queries.options(adapter, agent),
    findFiles: (query) => api.projectFiles({ canvas, agent, query }).then(({ items }) => items),
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
  const pasted = useSyncExternalStore(subscribePreviews, imagePreviews);
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
        view?.summary ?? (agent === undefined ? undefined : summaries?.[agent]),
        view,
        agent === undefined ? [] : Object.values(messages?.items ?? {}),
        { ...extras, images: extras?.images ? new Map([...extras.images, ...pasted]) : pasted },
      ),
    [agent, summaries, view, messages, extras, pasted],
  );
}
