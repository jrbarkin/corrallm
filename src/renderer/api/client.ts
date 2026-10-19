import type { OpError, OpErrorCode, OpResult } from '../../shared/api/errors';
import { GUI_OPS } from '../../shared/api/surface';
import { guiFunction } from '../../shared/gui-link';
import type { GuiApi } from '../../shared/gui-link';

/** An operation's failure, created in the renderer after its plain data crossed contextBridge. */
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

/** The GUI operations, one function each: the preload keeps their port and returns plain results. */
export const api = {
  ...Object.fromEntries(
    GUI_OPS.map((op) => {
      const name = guiFunction(op);
      return [
        name,
        async (args?: unknown) => {
          const call = window.api[name] as (args?: unknown) => Promise<OpResult<unknown>>;
          const result = await call(args);
          if (!result.ok) throw new ApiError(result.error);
          return result.value;
        },
      ];
    }),
  ),
  terminalOnEvent: (listener) => window.api.terminalOnEvent(listener),
} as GuiApi;
