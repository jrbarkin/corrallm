import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  CanUseTool,
  ElicitationResult,
  OnElicitation,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AskedQuestion,
  PlanMode,
  SessionAnswer,
  SessionEvent,
} from '../../../../shared/session';
import { formContent, formFields } from './mcp';
import type { Places } from './tools';
import { displayPath, property, proposedDetail, text, toolSummary } from './tools';

/*
 * What Claude Code asks the user, through the Agent SDK's canUseTool: permission to run a tool
 * (allow once, always, or deny, as the CLI offers them; denied with what to do instead, Claude goes
 * on with that), the questions of AskUserQuestion, and
 * plan mode's plan to approve (ExitPlanMode). Each becomes a prompt event; the renderer's answer
 * (session:answer) becomes the CLI's permission result. A prompt the CLI stops waiting for (the
 * turn was interrupted) is withdrawn. MCP servers' requests (elicitations, through onElicitation)
 * are prompts too: a form to fill in (checked against the form before it goes back), or a link
 * to open.
 */

/** What the CLI is told when the user says no: what it says itself, stopping to wait for them. */
export const DENIED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/** What it is told when the user says no and what to do instead (their words follow), going on. */
export const DENIED_WITH_FEEDBACK =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";

/** What happens around prompts: events to the renderer, and a plan approved in a mode. */
export interface PromptHost {
  emit(event: SessionEvent): void;
  /** A plan was approved, to be carried out in `mode`. */
  planApproved(mode: PlanMode): void;
}

/**
 * A prompt waiting for the user: how its answer reaches the CLI, and what checks the answer first
 * (throwing, it is refused and the prompt still waits).
 */
interface Waiting {
  settle: (answer: SessionAnswer | undefined) => void;
  check?: (answer: SessionAnswer) => void;
}

export class Prompts {
  readonly #host: PromptHost;
  readonly #places: Places;
  readonly #open = new Map<string, Waiting>();

  constructor(host: PromptHost, places: Places) {
    this.#host = host;
    this.#places = places;
  }

  /** Whether any prompt waits for the user. */
  get waiting(): boolean {
    return this.#open.size > 0;
  }

  /** The SDK's canUseTool: asks the user, and answers the CLI as they did. */
  readonly canUseTool: CanUseTool = async (tool, input, options) => {
    const { signal, toolUseID } = options;
    // Its own entry, apart from the tool call's (which has the call's id).
    const id = promptId(toolUseID);
    if (tool === 'AskUserQuestion') {
      const questions = askedQuestions(property(input, 'questions'));
      if (questions === undefined)
        return { behavior: 'deny', message: 'The questions could not be shown.' };
      const answer = await this.#ask(id, signal, { type: 'question', id, questions });
      if (answer?.kind !== 'question') return withdrawn();
      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: Object.fromEntries(questions.map((q, i) => [q.text, answer.answers[i] ?? ''])),
        },
      };
    }
    if (tool === 'ExitPlanMode') {
      const plan = text(property(input, 'plan')) ?? '';
      const answer = await this.#ask(id, signal, { type: 'plan', id, plan });
      if (answer?.kind !== 'plan') return withdrawn();
      if (!answer.answer.approve) {
        const feedback = answer.answer.feedback.trim();
        return {
          behavior: 'deny',
          message:
            feedback === ''
              ? 'The user wants you to keep planning.'
              : `The user wants you to keep planning. Their feedback: ${feedback}`,
        };
      }
      this.#host.planApproved(answer.answer.mode);
      return { behavior: 'allow', updatedInput: input };
    }

    const suggestions = options.suggestions ?? [];
    const always =
      options.suppressAlwaysAllowRule === true ? null : alwaysWording(suggestions, this.#places);
    const detail = proposedDetail(tool, input);
    const title =
      options.title ??
      (options.blockedPath === undefined
        ? undefined
        : `Claude wants to access ${displayPath(options.blockedPath, this.#places)}`);
    const answer = await this.#ask(id, signal, {
      type: 'permission',
      id,
      tool,
      summary: toolSummary(tool, input, this.#places),
      always,
      ...(detail === undefined ? {} : { detail }),
      ...(title === undefined ? {} : { title }),
    });
    if (answer?.kind !== 'permission') return withdrawn();
    switch (answer.answer) {
      case 'once':
        return { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' };
      case 'always':
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: always === null ? [] : suggestions,
          decisionClassification: 'user_permanent',
        };
      case 'deny': {
        // "No, and tell Claude what to do differently": it goes on with what they said.
        const feedback = answer.feedback?.trim() ?? '';
        return feedback === ''
          ? {
              behavior: 'deny',
              message: DENIED,
              interrupt: true,
              decisionClassification: 'user_reject',
            }
          : {
              behavior: 'deny',
              message: `${DENIED_WITH_FEEDBACK}${feedback}`,
              decisionClassification: 'user_reject',
            };
      }
    }
  };

  /**
   * The SDK's onElicitation: an MCP server asks the user to fill in a form, or to open a link.
   * A form corrallm can't show is declined, and the user told.
   */
  readonly onElicitation: OnElicitation = async (request, { signal }) => {
    const id = `elicitation:${randomUUID()}`;
    const { serverName: server, message } = request;
    if (request.mode === 'url') {
      if (request.url === undefined) return { action: 'decline' };
      const answer = await this.#ask(id, signal, {
        type: 'elicitation',
        id,
        server,
        message,
        url: request.url,
      });
      return answer?.kind === 'elicitation' ? { action: answer.action } : { action: 'cancel' };
    }
    const fields = formFields(request.requestedSchema);
    if (fields === undefined) {
      this.#host.emit({
        type: 'notice',
        id: randomUUID(),
        level: 'warning',
        text: `${server} asked for something corrallm can’t show, so it was declined: ${message}`,
      });
      return { action: 'decline' };
    }
    const answer = await this.#ask(
      id,
      signal,
      { type: 'elicitation', id, server, message, fields },
      (given) => {
        if (given.kind === 'elicitation' && given.action === 'accept') {
          formContent(fields, given.values ?? {});
        }
      },
    );
    if (answer?.kind !== 'elicitation') return { action: 'cancel' };
    if (answer.action !== 'accept') return { action: answer.action };
    const result: ElicitationResult = {
      action: 'accept',
      content: formContent(fields, answer.values ?? {}),
    };
    return result;
  };

  /**
   * Passes on the user's answer to prompt `id`; rejects if it no longer waits for one, or if the
   * answer is not what it asks (it still waits then).
   */
  answer(id: string, answer: SessionAnswer): void {
    const waiting = this.#open.get(id);
    if (!waiting) throw new Error('That question is no longer asked.');
    waiting.check?.(answer);
    this.#open.delete(id);
    this.#settle();
    waiting.settle(answer);
  }

  /** Stops waiting for every prompt, as the session closes. */
  withdrawAll(): void {
    for (const [id, waiting] of [...this.#open]) {
      this.#open.delete(id);
      waiting.settle(undefined);
    }
  }

  /** Shows a prompt and waits for its answer: undefined if the CLI withdraws it first. */
  #ask(
    id: string,
    signal: AbortSignal,
    prompt: SessionEvent,
    check?: (answer: SessionAnswer) => void,
  ): Promise<SessionAnswer | undefined> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      this.#open.set(id, { settle: resolve, ...(check === undefined ? {} : { check }) });
      this.#host.emit(prompt);
      this.#host.emit({ type: 'status', status: 'waiting' });
      signal.addEventListener(
        'abort',
        () => {
          if (!this.#open.delete(id)) return;
          this.#host.emit({ type: 'withdrawn', id });
          this.#settle();
          resolve(undefined);
        },
        { once: true },
      );
    });
  }

  /** A prompt no longer waits: the session works again once none does. */
  #settle(): void {
    if (this.#open.size === 0) this.#host.emit({ type: 'status', status: 'working' });
  }
}

/** The id of the prompt asking about tool call `toolUseId`. */
export function promptId(toolUseId: string): string {
  return `${toolUseId}:prompt`;
}

/** The CLI stopped asking (or the session closed): it ignores the answer, but needs one. */
function withdrawn(): PermissionResult {
  return { behavior: 'deny', message: 'The user did not answer.' };
}

/** AskUserQuestion's questions, as corrallm asks them; undefined if they are not what it expects. */
export function askedQuestions(value: unknown): AskedQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const questions = value.map((item): AskedQuestion | undefined => {
    const asked = text(property(item, 'question'));
    const options = property(item, 'options');
    if (asked === undefined || !Array.isArray(options)) return undefined;
    return {
      header: text(property(item, 'header')) ?? '',
      text: asked,
      options: options.flatMap((option) => {
        const label = text(property(option, 'label'));
        return label === undefined
          ? []
          : [{ label, description: text(property(option, 'description')) ?? '' }];
      }),
      multiple: property(item, 'multiSelect') === true,
    };
  });
  return questions.every((q) => q !== undefined) ? questions : undefined;
}

/** What answering "always" does, as Claude Code words it; null if it offers nothing to keep. */
export function alwaysWording(
  suggestions: readonly PermissionUpdate[],
  places: Places,
): string | null {
  const project = path.basename(places.cwd);
  const where = (destination: PermissionUpdate['destination']) =>
    destination === 'userSettings'
      ? 'anywhere'
      : destination === 'localSettings' || destination === 'projectSettings'
        ? `in ${project}`
        : 'during this session';
  const parts = suggestions.flatMap((suggestion): string[] => {
    switch (suggestion.type) {
      case 'setMode':
        return suggestion.mode === 'acceptEdits'
          ? ['allow all edits during this session']
          : [`switch to ${suggestion.mode} mode`];
      case 'addRules':
        if (suggestion.behavior !== 'allow' || suggestion.rules.length === 0) return [];
        return [
          `don't ask again for ${suggestion.rules.map(ruleWording).join(', ')} ${where(suggestion.destination)}`,
        ];
      case 'addDirectories':
        return [
          `allow access to ${suggestion.directories.map((d) => displayPath(d, places)).join(', ')} ${where(suggestion.destination)}`,
        ];
      default:
        return [];
    }
  });
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  return first === 'allow all edits during this session' && rest.length === 0
    ? 'Yes, allow all edits during this session'
    : `Yes, and ${parts.join(', and ')}`;
}

/** A permission rule as the user reads it: "`npm test` commands", "fetches from example.com". */
function ruleWording({
  toolName,
  ruleContent,
}: {
  toolName: string;
  ruleContent?: string;
}): string {
  if (ruleContent === undefined || ruleContent === '') return toolName;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const prefix = /^(.*?):?\*$/.exec(ruleContent)?.[1];
    return prefix === undefined ? `\`${ruleContent}\`` : `\`${prefix.trim()}\` commands`;
  }
  const domain = /^domain:(.+)$/.exec(ruleContent)?.[1];
  if (domain !== undefined) return `fetches from ${domain}`;
  return `${toolName}(${ruleContent})`;
}
