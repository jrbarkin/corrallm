import { GUI_OPS, SURFACE } from '../../shared/api/surface';
import { guiFunction } from '../../shared/gui-link';
import type { GuiApi } from '../../shared/gui-link';
import type { TopicKey } from '../../shared/api/topics';
import { draftCall, flushDrafts } from '../useDraft';
import { bridge } from './bridge';
import { topics } from './topics';
import type { TopicMirror } from './topics';

/** An operation's failure, created in the renderer after its plain data crossed contextBridge. */
export { ApiError } from './bridge';

/** The GUI operations, one function each: the preload keeps their port and returns plain results. */
export function createClient(source: GuiApi, mirror: Pick<TopicMirror, 'whenAt'>): GuiApi {
  return {
    ...Object.fromEntries(
      GUI_OPS.map((op) => {
        const name = guiFunction(op);
        return [
          name,
          (args?: unknown) =>
            draftCall(async () => {
              await flushDrafts();
              const call = source[name] as (args?: unknown) => Promise<unknown>;
              const result = await call(args);
              if (
                SURFACE[op].kind !== 'read' &&
                typeof result === 'object' &&
                result !== null &&
                'revs' in result
              ) {
                const revs = result.revs as Record<TopicKey, number>;
                await Promise.all(
                  Object.entries(revs).map(([topic, rev]) => mirror.whenAt(topic as TopicKey, rev)),
                );
              }
              return result;
            }),
        ];
      }),
    ),
    windowOnShow: (listener) => source.windowOnShow(listener),
    terminalOnEvent: (listener) => source.terminalOnEvent(listener),
    topicsOnChange: (listener) => source.topicsOnChange(listener),
    topicsOnEpoch: (listener) => source.topicsOnEpoch(listener),
  } as GuiApi;
}

export const api = createClient(bridge, topics);
