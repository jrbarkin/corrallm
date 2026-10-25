import type { SessionBackend } from '../../shared/engine/transcript/receive';
import type { FilesRewind, RewindResult } from '../../shared/session';
import type { MirrorStates } from '../api/topic-wire';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import { isOpen, NEW_SESSION } from '../../shared/model/session';
import type { Entry, Session } from '../../shared/model/session';
import type { EntryView, MessageView, SessionSummary, SessionView } from '../../shared/model/views';
import { orderedEntries } from '../api/runtime';
import type { TopicMirror } from '../api/topics';
import { fromMain } from '../ipc-error';
import type { AdapterId } from '../../shared/adapter';
import type { SessionControls } from '../agent/AgentView';

/** Read queries still on the transitional channels; X13 replaces these session panels. */
export type SessionQueries = Pick<
  SessionBackend,
  'options' | 'files' | 'sessions' | 'resume' | 'mcp' | 'changeMcp'
>;
export const nativeQueries: SessionQueries = {
  options: (adapter) => fromMain(window.api.settingsOptions(adapter)),
  files: (query) =>
    import('../agent/completion').then(({ findProjectFiles }) => findProjectFiles(query)),
  sessions: (agent) => fromMain(window.api.listSessions(agent)),
  resume: (agent, conversation) => fromMain(window.api.resumeSession(agent, conversation)),
  mcp: (agent) => fromMain(window.api.mcpServers(agent)),
  changeMcp: (agent, server, change) => fromMain(window.api.changeMcpServer(agent, server, change)),
};

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const copy = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
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
): Session {
  if (!summary) return NEW_SESSION;
  const shown = orderedEntries(view).map(entryOf);
  const { running, usage, modes, ...top } = copy(summary);
  return {
    ...top,
    ...(running === undefined ? {} : { running }),
    ...(usage === undefined ? {} : { usage }),
    ...(modes === undefined ? {} : { modes }),
    entries: shown,
    prompts: shown.filter(isOpen),
    queued: messages
      .filter(
        (message) =>
          message.kind === 'text' && message.state === 'pending' && message.origin !== 'run',
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
    open: () => {
      act(api.sessionOpen({ canvas, agent }));
    },
    send: (text, images) => {
      act(api.message({ canvas, to: agent, body: text, ...(images ? { images } : {}) }));
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
): Session {
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
        agent === undefined
          ? []
          : Object.values(messages?.items ?? {}).filter(
              (message) => message.to === `agent:${agent}`,
            ),
      ),
    [agent, summaries, view, messages],
  );
}
