import type { OpError, OpErrorCode, OpResult } from '../../shared/api/errors';
import { GUI_OPS } from '../../shared/api/surface';
import { guiFunction } from '../../shared/gui-link';
import type { GuiApi, GuiBridge } from '../../shared/gui-link';

/** An operation's failure, created after its plain data crossed contextBridge. */
export class ApiError extends Error implements OpError {
  readonly code: OpErrorCode;
  readonly sentence: string;

  constructor({ code, sentence }: OpError) {
    super(sentence);
    this.name = 'ApiError';
    this.code = code;
    this.sentence = sentence;
  }
}

/** Unwrapping alone: the mirror's transport must not wait for drafts or its own revisions. */
export function fromBridge(get: () => GuiBridge): GuiApi {
  return {
    ...Object.fromEntries(
      GUI_OPS.map((op) => {
        const name = guiFunction(op);
        return [
          name,
          async (args?: unknown) => {
            const call = get()[name] as (args?: unknown) => Promise<OpResult<unknown>>;
            const result = await call(args);
            if (!result.ok) throw new ApiError(result.error);
            return result.value;
          },
        ];
      }),
    ),
    terminalOnEvent: (listener) => get().terminalOnEvent(listener),
    topicsOnChange: (listener) => get().topicsOnChange(listener),
    topicsOnEpoch: (listener) => get().topicsOnEpoch(listener),
  } as GuiApi;
}

export const bridge = fromBridge(() => window.api);
