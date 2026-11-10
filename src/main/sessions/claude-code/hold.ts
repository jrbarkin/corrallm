import type { AdapterPrompt, PromptAnswer } from '../../../shared/model/prompts';
import type { TerminalHold } from '../terminal/cli';
import type { HookEvent } from '../terminal/hooks';
import { DENIED, deniedWith, permissionResult, said, toolPrompt } from './sdk/raise';
import type { Native, ToolOptions } from './sdk/raise';
import type { Places } from './sdk/tools';

/*
 * What Claude Code · Terminal's PermissionRequest hook is held for (B23 C2), and what it is told
 * (C4). Held, its permission dialog stays up beside the hold (recorded: Claude Code 2.1.321 draws
 * it at once), so both places answer: `answerIn: 'both'`, the first answer winning. Held:
 *
 * - a tool's permission, as the Agent SDK's card words the same request (its tool and input, a
 *   command whole or not held at all), with Yes, No (which ends the turn) and No with what to do
 *   instead; never an "always", which was not recorded through a hook: where the dialog offers
 *   more (`permission_suggestions`), the card says it left that out;
 * - AskUserQuestion's questions, where every question's text is distinct and none was cut.
 *
 * Not held: a plan (an allow, with or without setMode, leaves its dialog up: recorded), and
 * anything else; PreToolUse is only told.
 *
 * The reply is the recorded shape and nothing more: `hookSpecificOutput.decision` with a
 * behavior, a message, and for a question the request's own input with its answers added. Never
 * `updatedPermissions`, an `updatedInput` on an approval, or a classification. Another party's
 * words are framed as theirs; a question another party answers is refused, as Claude Code would
 * take it for the user's.
 */

const PLAN_TOOL = 'ExitPlanMode';

/** The hold a PermissionRequest hook event is for; none for what is not held. */
export function claudeHold(event: HookEvent, places: Places): TerminalHold | undefined {
  if (event.hook_event_name !== 'PermissionRequest') return undefined;
  const tool = event.tool_name;
  if (typeof tool !== 'string' || tool === '' || tool === PLAN_TOOL) return undefined;
  const input =
    typeof event.tool_input === 'object' &&
    event.tool_input !== null &&
    !Array.isArray(event.tool_input)
      ? (event.tool_input as Record<string, unknown>)
      : {};
  const raised = toolPrompt(tool, input, {} as ToolOptions, { places, modes: [] });
  if ('declined' in raised || raised.prompt.cut === true) return undefined;
  const { prompt, native } = raised;
  const suggested = event.permission_suggestions;
  const held: AdapterPrompt = {
    ...prompt,
    answerIn: 'both',
    ...(Array.isArray(suggested) && suggested.length > 0 && prompt.kind === 'approval'
      ? { omitted: true as const }
      : {}),
  };
  return {
    prompt: held,
    reply: (answer) => ({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: decide(native, answer),
      },
    }),
  };
}

/** The decision for an answer; throws, saying why, for one its CLI cannot be told. */
function decide(native: Native, answer: PromptAnswer): unknown {
  if (native.kind === 'question') {
    // The SDK's own map: answers keyed by the question's text, on the request's own input.
    const result = permissionResult(native, answer);
    if (result.behavior !== 'allow') throw new Error('Answer the questions.');
    return { behavior: 'allow', updatedInput: result.updatedInput };
  }
  if (native.kind !== 'tool') throw new Error('That is not a permission.');
  if (answer.kind !== 'choice') throw new Error('Choose one of the offered decisions.');
  switch (answer.value) {
    case 'allow':
      return { behavior: 'allow' };
    case 'deny':
      return { behavior: 'deny', message: DENIED, interrupt: true };
    case 'deny-feedback': {
      const feedback = said(answer);
      if (feedback === undefined) throw new Error('Say what to do instead.');
      return { behavior: 'deny', message: `${deniedWith(answer)}${feedback}` };
    }
  }
  throw new Error(`That decision is not offered by this prompt: ${answer.value}.`);
}
