import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { Answer } from '../../shared/model/run';
import type { TopicMirror } from '../api/topics';

/** Commands target the current view binding; execution and decisions belong only to the core. */
export function runCommands(api: GuiApi, canvasOf: () => CanvasId, mirror: TopicMirror) {
  const target = (kind: 'agent' | 'group', id: string) =>
    kind === 'agent' ? { agent: id } : { group: id };
  return {
    start: () => api.runStart({ canvas: canvasOf() }),
    stop: () => api.runStop({ canvas: canvasOf() }),
    resume: () => api.runResume({ canvas: canvasOf() }),
    pauseAgent: (id: string) => api.runPause({ canvas: canvasOf(), target: target('agent', id) }),
    killAgent: (id: string) => api.runKill({ canvas: canvasOf(), target: target('agent', id) }),
    resumeAgent: (id: string) =>
      api.runUnpause({ canvas: canvasOf(), target: target('agent', id) }),
    pauseGroup: (id: string) => api.runPause({ canvas: canvasOf(), target: target('group', id) }),
    killGroup: (id: string) => api.runKill({ canvas: canvasOf(), target: target('group', id) }),
    resumeGroup: (id: string) =>
      api.runUnpause({ canvas: canvasOf(), target: target('group', id) }),
    goOn: (agent: string, item: string) => {
      const canvas = canvasOf();
      const view = mirror.snapshot(`run:${canvas}`);
      const at = Object.entries(view?.agents ?? {}).find(([id]) => id === agent)?.[1];
      if (at?.current !== item)
        return Promise.reject(new Error('That timed hold is no longer current.'));
      return api.runGoOn({
        canvas,
        agent,
        item,
        ...(at.until === undefined ? {} : { until: at.until }),
      });
    },
    decide: (agent: string, item: string, answer: Answer) => {
      const canvas = canvasOf();
      const need = mirror
        .snapshot(`needs:${canvas}`)
        ?.items.find(
          (need) =>
            need.agent === agent &&
            need.id.startsWith(`hold/${encodeURIComponent(agent)}/`) &&
            need.id.endsWith(`/${item}`),
        );
      if (!need) return Promise.reject(new Error('That question is no longer current.'));
      return api.reply({
        canvas,
        to: need.id,
        answer:
          'reply' in answer
            ? { text: answer.reply, ...(answer.images ? { images: [...answer.images] } : {}) }
            : answer,
      });
    },
  };
}
