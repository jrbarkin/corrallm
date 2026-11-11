import {
  MAX_ID_LENGTH,
  MAX_PROMPT_COMMAND_BYTES,
  MAX_PROMPT_INPUT_BYTES,
  MAX_PROMPT_INPUT_DEPTH,
  MAX_PROMPT_PATH_LENGTH,
  MAX_PROMPT_TEXT_LENGTH,
} from '../../../../shared/api/limits';
import { boundedPromptJson } from '../../../../shared/model/prompt-data';
import type { PromptJson } from '../../../../shared/model/prompt-data';
import type { AdapterPrompt, Choice, PromptAnswer } from '../../../../shared/model/prompts';
import { mcpToolTitle } from '../../../../shared/model/words';
import type { TerminalHold } from '../../terminal/cli';
import type { HookEvent } from '../../terminal/hooks';

/*
 * What Codex · Terminal's PermissionRequest hook is held for (B23 C2), and what it is told (C4).
 * Held, Codex hides its approval ("Running hook", recorded on 0.162.1), so only corrallm answers
 * (`answerIn: 'api'`) until the request is let go of with no decision, when Codex shows it:
 *
 * - a command (`Bash`), with its command and folder, shown whole or not held;
 * - an MCP tool's call (`mcp__<server>__<tool>`), as the App Server card words it.
 *
 * Anything else (a patch, a network request, extra permissions, a subagent's request) is answered
 * `{}` at once and stays Codex's terminal's. The reply is the recorded shape only:
 * `hookSpecificOutput.decision` with a behavior and a message. Never `updatedInput`,
 * `updatedPermissions` or `interrupt`, which its documentation says fail closed. Another party's
 * words are framed as theirs.
 */

const accept: Choice = {
  value: 'accept',
  label: 'Yes, proceed',
  hint: 'allow_once',
  effects: {},
  feedback: 'none',
  endsTurn: false,
};
const decline: Choice = {
  value: 'decline',
  label: 'No, continue without running it',
  hint: 'reject_once',
  effects: {},
  feedback: 'none',
  endsTurn: false,
};
const declineFeedback: Choice = {
  value: 'decline-feedback',
  label: 'No, and tell Codex what to do differently',
  hint: 'reject_once',
  effects: {},
  feedback: 'required',
  endsTurn: false,
};

/** The hold a PermissionRequest hook event is for; none for what is not held. */
export function codexHold(event: HookEvent): TerminalHold | undefined {
  if (event.hook_event_name !== 'PermissionRequest') return undefined;
  // A subagent's thread has its own: not the session's to answer.
  if (event.agent_id !== undefined && event.agent_id !== null) return undefined;
  const tool = event.tool_name;
  if (typeof tool !== 'string') return undefined;
  const input =
    typeof event.tool_input === 'object' &&
    event.tool_input !== null &&
    !Array.isArray(event.tool_input)
      ? (event.tool_input as Record<string, unknown>)
      : undefined;
  const prompt = tool === 'Bash' ? commandPrompt(event, input) : mcpPrompt(tool, input);
  return prompt === undefined ? undefined : { prompt, reply: decide };
}

function commandPrompt(
  event: HookEvent,
  input: Record<string, unknown> | undefined,
): AdapterPrompt | undefined {
  const command = input?.command;
  const { cwd } = event;
  if (
    typeof command !== 'string' ||
    command === '' ||
    new TextEncoder().encode(command).length > MAX_PROMPT_COMMAND_BYTES ||
    typeof cwd !== 'string' ||
    cwd === '' ||
    cwd.length > MAX_PROMPT_PATH_LENGTH
  )
    return undefined;
  const why = input?.description;
  return {
    kind: 'approval',
    title: 'Codex wants to run a command',
    ...(typeof why === 'string' && why !== '' && why.length <= MAX_PROMPT_TEXT_LENGTH
      ? { reason: why }
      : {}),
    subject: { type: 'command', command, cwd },
    answerIn: 'api',
    choices: [accept, decline, declineFeedback],
    // Its terminal also offers to stop asking: corrallm passes none of that on.
    omitted: true,
  };
}

function mcpPrompt(
  tool: string,
  input: Record<string, unknown> | undefined,
): AdapterPrompt | undefined {
  if (!tool.startsWith('mcp__') || tool.length > MAX_ID_LENGTH) return undefined;
  const shown = input ?? {};
  if (!boundedPromptJson(shown, MAX_PROMPT_INPUT_BYTES, MAX_PROMPT_INPUT_DEPTH)) return undefined;
  const parts = tool.slice('mcp__'.length).split('__');
  const named = parts.length === 2 && parts.every((part) => part !== '');
  const [server, name] = parts;
  const subject =
    named && server !== undefined && name !== undefined
      ? { type: 'mcpTool' as const, server, tool: name, input: shown as PromptJson }
      : { type: 'tool' as const, tool, input: shown as PromptJson };
  return {
    kind: 'approval',
    title:
      subject.type === 'mcpTool'
        ? mcpToolTitle(subject.server, subject.tool)
        : `Codex wants to use ${tool}`,
    subject,
    answerIn: 'api',
    choices: [accept, decline, declineFeedback],
    omitted: true,
  };
}

/** The hook's reply for an answer; throws, saying why, for one it cannot be told. */
function decide(answer: PromptAnswer): unknown {
  if (answer.kind !== 'choice') throw new Error('Choose one of the offered decisions.');
  const who =
    answer.decider === undefined
      ? 'The user'
      : `${answer.decider.name} (another party in corrallm, not the user)`;
  switch (answer.value) {
    case 'accept':
      return reply({ behavior: 'allow' });
    case 'decline':
      return reply({
        behavior: 'deny',
        message: `${who} declined this; don't run it, and go on without it.`,
      });
    case 'decline-feedback': {
      const words = answer.feedback?.trim();
      if (words === undefined || words === '') throw new Error('Say what to do instead.');
      return reply({ behavior: 'deny', message: `${who} declined this and said: ${words}` });
    }
  }
  throw new Error(`That decision is not offered by this prompt: ${answer.value}.`);
}

function reply(decision: Record<string, unknown>): unknown {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}
