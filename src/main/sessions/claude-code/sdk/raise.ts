import path from 'node:path';

import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';

import {
  MAX_ANSWER_LENGTH,
  MAX_ID_LENGTH,
  MAX_PROMPT_INPUT_BYTES,
  MAX_PROMPT_INPUT_DEPTH,
  MAX_PROMPT_LABEL_LENGTH,
  MAX_PROMPT_TEXT_LENGTH,
} from '../../../../shared/api/limits';
import { boundedPromptJson } from '../../../../shared/model/prompt-data';
import type { PromptJson } from '../../../../shared/model/prompt-data';
import { ChoiceEffects, formContent, parseForm } from '../../../../shared/model/prompts';
import type {
  AdapterPrompt,
  Choice,
  PromptAnswer,
  PromptSignals,
  Question,
} from '../../../../shared/model/prompts';
import { mcpRequestTitle, mcpServerWords } from '../../../../shared/model/words';
import type { FormField, PermissionMode, ToolDetail } from '../../../../shared/session';
import { preview } from '../../transcript';
import { displayPath, property, proposedDetail, text, toolSummary } from './tools';
import type { Places } from './tools';
import { corrallmMode, sdkMode } from './translate';

/*
 * B13 C4 and C5's maps for the Agent SDK (B13 Design §9.2): what the CLI asks (a canUseTool call,
 * an MCP server's elicitation) as one of the core's prompt kinds, with the facts its classifier
 * reads (a subject, each choice's hint and effects, native signals: never the prompt's words), and
 * what the CLI is told for each answer. Pure: the session's Prompts raises and answers them.
 *
 * - A permission is an approval: Yes (`allow`), the request's own suggestions kept, all of them,
 *   verbatim (`always`: only where it suggests any and doesn't say always would allow too much;
 *   its label words every one, or it is left out), No, which stops the turn (`deny`), and No with
 *   what to do instead, which goes on (`deny-feedback`), as Claude Code offers them. Its effects
 *   map rules (session and cliArg kept for the session, local and project settings for the
 *   project, the user's for the user), folders and a session mode; a change the label words but
 *   the effects can't say (rules replaced or removed, folders removed, a mode kept beyond the
 *   session) leaves them unknown, and one it can't word leaves always out (`omitted`).
 * - AskUserQuestion (the built-in, no MCP server's) is a question prompt: each question an id of
 *   corrallm's (`q1`…), a pick or own words; answered keyed by its text, picks joined with ", ",
 *   as the CLI's own UI does. Questions it can't key that way (two the same) are declined.
 * - ExitPlanMode (the built-in) is a plan: Yes into auto (where the session lists it), Accept
 *   edits or Manual, each allowed with that mode for the session (recorded: the CLI goes into it at
 *   once), or keep planning, with words or none.
 * - An elicitation is a form, in the flat schema the core re-serialized (`parseForm`), or a link to
 *   open (only in `form.url`, never in its words), naming its server; one corrallm can't show is
 *   declined, the user told.
 * - Signals: an ask rule (`matchedAskRule`, or the reason `rule` or `hook`), a safety check
 *   (`safetyCheck`, or `subcommandResults`, which can hide one only a person may approve), or a
 *   person's (`classifier`, `serverPolicyAskOnly`, `requiresUserInteraction` but on the built-in
 *   question and plan, `other`, or any reason it doesn't know).
 */

/** What the CLI is told when the user says no: what it says itself, stopping to wait for them. */
export const DENIED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/** What it is told when the user says no and what to do instead (their words follow), going on. */
export const DENIED_WITH_FEEDBACK =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";

/** The options canUseTool is given, with the fields its runtime passes but its types leave out. */
export type ToolOptions = Parameters<CanUseTool>[2] & {
  decisionReasonType?: unknown;
  serverPolicyAskOnly?: unknown;
  requiresUserInteraction?: unknown;
};

/** What a request is raised with: its session's place and the modes it offers. */
export interface RaiseContext {
  places: Places;
  /** The modes the session offers (corrallm's names): a plan goes into auto only where it's one. */
  modes: readonly string[];
}

/** How a raised prompt's answer becomes what its CLI is told: private to the session. */
export type Native =
  | { kind: 'tool'; input: Record<string, unknown>; suggestions?: PermissionUpdate[] }
  | {
      kind: 'question';
      input: Record<string, unknown>;
      /** Each question's text by its id: what the CLI keys answers by. */
      texts: ReadonlyMap<string, string>;
    }
  | { kind: 'plan'; input: Record<string, unknown>; modes: ReadonlyMap<string, PermissionMode> }
  | { kind: 'form'; fields: readonly FormField[] }
  | { kind: 'link' };

/** A request raised (the prompt and how its answer goes), or declined, with what to tell the user. */
export type Raised = { prompt: AdapterPrompt; native: Native } | { declined: string };

/** Tools whose input is a command, which a prompt shows whole or not at all. */
const COMMANDS = new Set(['Bash', 'PowerShell']);
/** The longest line of a detail shown, and how many lines (the last saying how many more). */
const DETAIL_LINE = 2000;
const DETAIL_LINES = 11;
/** How much of an input too big to show whole its preview shows. */
const INPUT_PREVIEW = 4000;

/** What the CLI's question and plan tools are called; an MCP server's tool may say so too. */
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';

/** The reasons the runtime gives that make a request no one's but a person's, or ordinary. */
const ASK_RULE = new Set(['rule', 'hook']);
const SAFETY_CHECK = new Set(['safetyCheck', 'subcommandResults']);
const ORDINARY = new Set([
  'mode',
  'workingDir',
  'sandboxOverride',
  'permissionPromptTool',
  'asyncAgent',
]);

/** The native facts that make a request a person's to answer, if any (never its words). */
export function signalsOf(tool: string, options: ToolOptions): PromptSignals | undefined {
  const signals: PromptSignals = {};
  const reason = options.decisionReasonType;
  const builtIn = (tool === QUESTION_TOOL || tool === PLAN_TOOL) && options.mcpServer === undefined;
  if (options.matchedAskRule !== undefined || (typeof reason === 'string' && ASK_RULE.has(reason)))
    signals.askRule = true;
  if (typeof reason === 'string' && SAFETY_CHECK.has(reason)) signals.safetyCheck = true;
  if (
    (reason !== undefined &&
      !(
        typeof reason === 'string' &&
        (ASK_RULE.has(reason) || SAFETY_CHECK.has(reason) || ORDINARY.has(reason))
      )) ||
    options.serverPolicyAskOnly === true ||
    (options.requiresUserInteraction === true && !builtIn)
  )
    signals.requiresUser = true;
  return Object.keys(signals).length === 0 ? undefined : signals;
}

/** What canUseTool asks, as one of the core's prompts. */
export function toolPrompt(
  tool: string,
  input: Record<string, unknown>,
  options: ToolOptions,
  context: RaiseContext,
): Raised {
  const builtIn = options.mcpServer === undefined;
  if (builtIn && tool === QUESTION_TOOL) return questionPrompt(input, options);
  if (builtIn && tool === PLAN_TOOL) return planPrompt(input, options, context);
  return approvalPrompt(tool, input, options, context);
}

function approvalPrompt(
  tool: string,
  input: Record<string, unknown>,
  options: ToolOptions,
  { places }: RaiseContext,
): Raised {
  const cuts = new Cuts();
  const summary = toolSummary(tool, input, places);
  const blocked =
    options.blockedPath === undefined
      ? undefined
      : `Claude wants to access ${displayPath(options.blockedPath, places)}`;
  const title = options.title ?? blocked ?? `Claude wants to use ${options.displayName ?? tool}`;
  const shown = shownInput(tool, input, cuts);
  const subject =
    options.mcpServer === undefined
      ? { type: 'tool' as const, tool, input: shown }
      : { type: 'mcpTool' as const, server: options.mcpServer.name, tool, input: shown };
  const suggestions = options.suggestions ?? [];
  const always =
    options.suppressAlwaysAllowRule === true ? null : alwaysChoice(suggestions, places);
  const detail = shownDetail(proposedDetail(tool, input), cuts);
  const signals = signalsOf(tool, options);
  const choices: Choice[] = [
    once('allow', 'Yes'),
    ...(always === null || always === undefined ? [] : [always]),
    {
      value: 'deny',
      label: 'No',
      hint: 'reject_once',
      effects: {},
      feedback: 'none',
      endsTurn: true,
    },
    {
      value: 'deny-feedback',
      label: 'No, and tell Claude what to do differently',
      hint: 'reject_once',
      effects: {},
      feedback: 'required',
      endsTurn: false,
    },
  ];
  const prompt: AdapterPrompt = {
    kind: 'approval',
    title: cuts.text(title),
    ...(summary === '' ? {} : { summary: cuts.text(summary) }),
    ...(typeof options.decisionReason === 'string' && options.decisionReason !== ''
      ? { reason: cuts.text(options.decisionReason) }
      : {}),
    ...(detail === undefined ? {} : { detail }),
    subject,
    answerIn: 'api',
    choices,
    ...(signals === undefined ? {} : { signals }),
    ...(always === undefined ? { omitted: true as const } : {}),
    ...cuts.mark(),
  };
  return {
    prompt,
    native: {
      kind: 'tool',
      input,
      ...(always === null || always === undefined ? {} : { suggestions }),
    },
  };
}

/** Yes, once, changing nothing more. */
function once(value: string, label: string): Choice {
  return { value, label, hint: 'allow_once', effects: {}, feedback: 'none', endsTurn: false };
}

/**
 * The always choice: the request's own suggestions, all of them, with a label that words every
 * one. Null if there is nothing to keep; undefined if it can't be worded (it is left out).
 */
function alwaysChoice(
  suggestions: readonly PermissionUpdate[],
  places: Places,
): Choice | null | undefined {
  if (suggestions.length === 0) return null;
  const label = alwaysWording(suggestions, places);
  if (label === null) return null;
  if (label === undefined || label.length > MAX_PROMPT_LABEL_LENGTH) return undefined;
  const effects = effectsOf(suggestions);
  return {
    value: 'always',
    label,
    hint: 'allow_always',
    ...(effects === undefined ? {} : { effects }),
    feedback: 'none',
    endsTurn: false,
  };
}

/**
 * What answering always does, as Claude Code words it: every suggestion, or undefined if one can't
 * be worded; null if they keep nothing.
 */
export function alwaysWording(
  suggestions: readonly PermissionUpdate[],
  places: Places,
): string | null | undefined {
  const project = path.basename(places.cwd);
  const parts: string[] = [];
  for (const suggestion of suggestions as readonly unknown[]) {
    const part = suggestionWords(suggestion, project, places);
    if (part === undefined) return undefined;
    if (part !== null) parts.push(part);
  }
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  return first === EDITS && rest.length === 0
    ? `Yes, ${EDITS}`
    : `Yes, and ${parts.join(', and ')}`;
}

const EDITS = 'allow all edits during this session';
const MODE_WORDS: Readonly<Record<string, string>> = {
  default: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass permissions',
  auto: 'Auto',
  dontAsk: 'Don’t ask',
};

/** One suggestion in words: null if it does nothing, undefined if it can't be worded. */
function suggestionWords(
  suggestion: unknown,
  project: string,
  places: Places,
): string | null | undefined {
  const type = property(suggestion, 'type');
  const where = whereWords(property(suggestion, 'destination'), project);
  if (where === undefined) return undefined;
  const rules = () => {
    const listed = property(suggestion, 'rules');
    if (!Array.isArray(listed)) return undefined;
    const worded = listed.map((rule) => {
      const tool = text(property(rule, 'toolName'));
      const content = property(rule, 'ruleContent');
      if (tool === undefined || (content !== undefined && typeof content !== 'string'))
        return undefined;
      return ruleWording({
        toolName: tool,
        ...(content === undefined ? {} : { ruleContent: content }),
      });
    });
    return worded.every((one) => one !== undefined) ? worded : undefined;
  };
  const folders = () => {
    const listed = property(suggestion, 'directories');
    if (!Array.isArray(listed) || !listed.every((one) => typeof one === 'string')) return undefined;
    return listed.map((one) => displayPath(one, places));
  };
  const behavior = property(suggestion, 'behavior');
  switch (type) {
    case 'addRules': {
      const worded = rules();
      if (worded === undefined) return undefined;
      if (worded.length === 0) return null;
      switch (behavior) {
        case 'allow':
          return `don't ask again for ${worded.join(', ')} ${where}`;
        case 'deny':
          return `always refuse ${worded.join(', ')} ${where}`;
        case 'ask':
          return `always ask before ${worded.join(', ')} ${where}`;
        default:
          return undefined;
      }
    }
    case 'replaceRules':
    case 'removeRules': {
      const worded = rules();
      if (
        worded === undefined ||
        typeof behavior !== 'string' ||
        !['allow', 'deny', 'ask'].includes(behavior)
      )
        return undefined;
      return type === 'replaceRules'
        ? `replace the ${behavior} rules ${where} with ${worded.length === 0 ? 'none' : worded.join(', ')}`
        : worded.length === 0
          ? null
          : `remove the ${behavior} rules for ${worded.join(', ')} ${where}`;
    }
    case 'setMode': {
      const mode = text(property(suggestion, 'mode'));
      if (mode === undefined) return undefined;
      const named = MODE_WORDS[mode] ?? mode;
      if (property(suggestion, 'destination') === 'session')
        return mode === 'acceptEdits' ? EDITS : `switch to ${named} mode during this session`;
      return `switch to ${named} mode and keep it ${where}`;
    }
    case 'addDirectories':
    case 'removeDirectories': {
      const worded = folders();
      if (worded === undefined) return undefined;
      if (worded.length === 0) return null;
      return type === 'addDirectories'
        ? `allow access to ${worded.join(', ')} ${where}`
        : `stop allowing access to ${worded.join(', ')} ${where}`;
    }
    default:
      return undefined;
  }
}

/** Where a suggestion keeps what it changes, in words; undefined for a place corrallm doesn't know. */
function whereWords(destination: unknown, project: string): string | undefined {
  switch (destination) {
    case 'session':
    case 'cliArg':
      return 'during this session';
    case 'localSettings':
      return `in ${project}`;
    case 'projectSettings':
      return `in ${project}’s shared settings`;
    case 'userSettings':
      return 'anywhere';
    default:
      return undefined;
  }
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
  const domain = toolName === 'WebFetch' ? /^domain:(.+)$/.exec(ruleContent)?.[1] : undefined;
  if (domain !== undefined) return `fetches from ${domain}`;
  return `${toolName}(${ruleContent})`;
}

/**
 * What keeping the suggestions does, as the core's effects; undefined where one can't be said
 * (rules replaced or removed, folders removed, a mode kept beyond the session, or past the
 * effects' bounds), so only you may choose it. Read only once they are worded, which checks the
 * shapes of their rules, folders and mode.
 */
function effectsOf(suggestions: readonly PermissionUpdate[]): ChoiceEffects | undefined {
  const rules: NonNullable<ChoiceEffects['rules']> = [];
  const directories: string[] = [];
  let mode: string | undefined;
  for (const suggestion of suggestions) {
    switch (suggestion.type) {
      case 'addRules': {
        // As the CLI gave it, which its types can't promise.
        if (!BEHAVIORS.has(suggestion.behavior)) return undefined;
        const { behavior } = suggestion;
        const scope = scopeOf(suggestion.destination);
        for (const { toolName, ruleContent } of suggestion.rules) {
          rules.push({
            behavior,
            rule:
              ruleContent === undefined || ruleContent === ''
                ? toolName
                : `${toolName}(${ruleContent})`,
            scope,
          });
        }
        break;
      }
      case 'addDirectories':
        directories.push(...suggestion.directories);
        break;
      case 'setMode': {
        const named = corrallmMode(suggestion.mode);
        if (suggestion.destination !== 'session' || mode !== undefined || named === undefined)
          return undefined;
        mode = named;
        break;
      }
      default:
        return undefined;
    }
  }
  const effects = ChoiceEffects.safeParse({
    ...(rules.length === 0 ? {} : { rules }),
    ...(directories.length === 0 ? {} : { directories }),
    ...(mode === undefined ? {} : { mode }),
  });
  return effects.success ? effects.data : undefined;
}

/** The rules' behaviors the core's effects say. */
const BEHAVIORS: ReadonlySet<unknown> = new Set(['allow', 'deny', 'ask']);

/** Where a rule is kept, as the core scopes it. */
function scopeOf(destination: unknown): 'session' | 'project' | 'user' {
  switch (destination) {
    case 'session':
    case 'cliArg':
      return 'session';
    case 'localSettings':
    case 'projectSettings':
      return 'project';
    default:
      return 'user';
  }
}

function questionPrompt(input: Record<string, unknown>, options: ToolOptions): Raised {
  const cuts = new Cuts();
  const listed = property(input, 'questions');
  const cant = (why: string) => ({
    declined: `Claude asked something corrallm can’t pass on faithfully (${why}), so it was declined.`,
  });
  if (!Array.isArray(listed) || listed.length === 0) return cant('it isn’t a list of questions');
  const texts = new Map<string, string>();
  const questions: Question[] = [];
  for (const [index, item] of listed.entries()) {
    const asked = text(property(item, 'question'));
    const offered = property(item, 'options');
    if (asked === undefined || !Array.isArray(offered))
      return cant('a question has no text or answers');
    if ([...texts.values()].includes(asked))
      return cant('two questions the same, which it answers by their words');
    const id = `q${String(index + 1)}`;
    texts.set(id, asked);
    questions.push({
      id,
      header: cuts.text(text(property(item, 'header')) ?? '', MAX_ID_LENGTH),
      text: asked,
      options: offered.map((option) => {
        const description = text(property(option, 'description'));
        const shown = text(property(option, 'preview'));
        return {
          label: text(property(option, 'label')) ?? '',
          ...(description === undefined || description === ''
            ? {}
            : { description: cuts.text(description) }),
          ...(shown === undefined || shown === ''
            ? {}
            : { preview: cuts.text(shown, MAX_ANSWER_LENGTH) }),
        };
      }),
      multiple: property(item, 'multiSelect') === true,
      other: true,
    });
  }
  const [only] = questions;
  const signals = signalsOf(QUESTION_TOOL, options);
  return {
    prompt: {
      kind: 'question',
      title: cuts.text(
        questions.length === 1 && only
          ? only.text
          : `Claude asks ${String(questions.length)} questions`,
      ),
      answerIn: 'api',
      questions,
      ...(signals === undefined ? {} : { signals }),
      ...cuts.mark(),
    },
    native: { kind: 'question', input, texts },
  };
}

/** The modes a plan may be carried out in, as Claude Code offers them, in its order. */
const PLAN_CHOICES = [
  { mode: 'auto', label: 'Yes, and use auto mode' },
  { mode: 'acceptEdits', label: 'Yes, and auto-accept edits' },
  { mode: 'manual', label: 'Yes, and manually approve edits' },
] as const;

function planPrompt(
  input: Record<string, unknown>,
  options: ToolOptions,
  { modes }: RaiseContext,
): Raised {
  const plan = text(property(input, 'plan'));
  if (plan === undefined || plan.trim() === '')
    return { declined: 'Claude asked to approve a plan corrallm can’t read, so it was declined.' };
  const offered = PLAN_CHOICES.filter(({ mode }) => mode !== 'auto' || modes.includes('auto'));
  const signals = signalsOf(PLAN_TOOL, options);
  return {
    prompt: {
      kind: 'plan',
      title: 'Approve Claude’s plan?',
      plan,
      answerIn: 'api',
      choices: [
        ...offered.map(({ mode, label }): Choice => ({ ...once(mode, label), effects: { mode } })),
        {
          value: 'keep-planning',
          label: 'No, keep planning',
          hint: 'reject_once',
          effects: {},
          feedback: 'optional',
          endsTurn: false,
        },
      ],
      ...(signals === undefined ? {} : { signals }),
    },
    native: {
      kind: 'plan',
      input,
      modes: new Map(offered.map(({ mode }): [string, PermissionMode] => [mode, mode])),
    },
  };
}

/** What an MCP server's elicitation asks, as one of the core's prompts. */
export function elicitationPrompt(request: ElicitationRequest): Raised {
  const { serverName: server, message } = request;
  const cuts = new Cuts();
  if (request.mode === 'url') {
    const { url } = request;
    if (url === undefined || url === '')
      return {
        declined: `${mcpServerWords(server)} asked to open a link it didn’t give, so it was declined.`,
      };
    // The link only in the form, and the server's words nowhere (they may hold the link, as it
    // is or encoded): the core's, naming the link's host as its Open does (B13 C8, C11).
    let host: string | undefined;
    try {
      host = new URL(url).host;
    } catch {
      host = undefined;
    }
    return {
      prompt: {
        kind: 'form',
        title: cuts.text(mcpRequestTitle(server, true, host === '' ? undefined : host)),
        server: cuts.text(server, MAX_ID_LENGTH),
        answerIn: 'api',
        form: { url },
        ...cuts.mark(),
      },
      native: { kind: 'link' },
    };
  }
  const parsed = parseForm(request.requestedSchema);
  // Declined naming its server, never quoting its words, which may hold a link.
  if (parsed === undefined)
    return {
      declined: `${mcpServerWords(server)} asked for a form corrallm can’t show, so it was declined.`,
    };
  return {
    prompt: {
      kind: 'form',
      title: cuts.text(message.trim() === '' ? mcpRequestTitle(server, false) : message),
      server: cuts.text(server, MAX_ID_LENGTH),
      answerIn: 'api',
      form: { schema: parsed.schema },
      ...cuts.mark(),
    },
    native: { kind: 'form', fields: parsed.fields },
  };
}

/**
 * What the CLI is told for `answer` to a permission prompt; throws, saying why, for one the prompt
 * doesn't take (it still waits). Another party's words are framed as theirs, never the user's.
 */
export function permissionResult(native: Native, answer: PromptAnswer): PermissionResult {
  switch (native.kind) {
    case 'tool': {
      const value = chosen(answer);
      switch (value) {
        case 'allow':
          return {
            behavior: 'allow',
            updatedInput: native.input,
            decisionClassification: 'user_temporary',
          };
        case 'always':
          if (native.suggestions === undefined) break;
          return {
            behavior: 'allow',
            updatedInput: native.input,
            updatedPermissions: native.suggestions,
            decisionClassification: 'user_permanent',
          };
        case 'deny':
          return {
            behavior: 'deny',
            message: DENIED,
            interrupt: true,
            decisionClassification: 'user_reject',
          };
        case 'deny-feedback': {
          const feedback = said(answer);
          if (feedback === undefined) throw new Error('Say what to do instead.');
          return {
            behavior: 'deny',
            message: `${deniedWith(answer)}${feedback}`,
            decisionClassification: 'user_reject',
          };
        }
      }
      throw new Error(`That decision is not offered by this prompt: ${value}.`);
    }
    case 'question': {
      if (answer.kind !== 'questions') throw new Error('Answer the questions.');
      if (answer.decider !== undefined) throw new Error(ONLY_THE_USER);
      const answers: Record<string, string> = {};
      for (const [id, asked] of native.texts) {
        const given = answer.answers[id];
        if (given === undefined) throw new Error(`Answer question ${id}.`);
        answers[asked] = 'picked' in given ? given.picked.join(', ') : given.text;
      }
      return { behavior: 'allow', updatedInput: { ...native.input, answers } };
    }
    case 'plan': {
      const value = chosen(answer);
      const mode = native.modes.get(value);
      if (mode !== undefined) {
        return {
          behavior: 'allow',
          updatedInput: native.input,
          updatedPermissions: [{ type: 'setMode', mode: sdkMode(mode), destination: 'session' }],
        };
      }
      if (value !== 'keep-planning')
        throw new Error(`That decision is not offered by this prompt: ${value}.`);
      const feedback = said(answer);
      const who =
        answer.decider === undefined
          ? 'The user'
          : `${answer.decider.name} (another party in corrallm, not the user)`;
      return {
        behavior: 'deny',
        message:
          feedback === undefined
            ? `${who} wants you to keep planning.`
            : `${who} wants you to keep planning. Their feedback: ${feedback}`,
      };
    }
    case 'form':
    case 'link':
      throw new Error('That is an MCP server’s request, not a permission.');
  }
}

/** What an MCP server is told for `answer`; throws, saying why, for one its form doesn't take. */
export function elicitationResult(native: Native, answer: PromptAnswer): ElicitationResult {
  if (native.kind !== 'form' && native.kind !== 'link')
    throw new Error('That is a permission, not a form.');
  if (answer.kind !== 'form') throw new Error('Answer the form.');
  if (answer.decider !== undefined) throw new Error(ONLY_THE_USER);
  if (answer.action !== 'accept') {
    if (answer.values !== undefined) throw new Error('Only an accepted form carries values.');
    return { action: answer.action };
  }
  if (native.kind === 'link') {
    if (answer.values !== undefined) throw new Error('A link takes no values.');
    return { action: 'accept' };
  }
  return { action: 'accept', content: formContent(native.fields, answer.values ?? {}) };
}

/** The CLI's nonapproval, for a request corrallm declines: never stopping the turn. */
export function declined(native: Native, why: string): PermissionResult | ElicitationResult {
  return native.kind === 'form' || native.kind === 'link'
    ? { action: 'decline' }
    : { behavior: 'deny', message: why };
}

const ONLY_THE_USER =
  'Only the user answers this: Claude Code would take another party’s answer as the user’s.';

/** The choice an answer picks; throws for one that isn't a choice. */
function chosen(answer: PromptAnswer): string {
  if (answer.kind !== 'choice') throw new Error('Choose one of the offered decisions.');
  return answer.value;
}

/** An answer's words, trimmed: none if it gave none. */
function said(answer: PromptAnswer): string | undefined {
  const feedback = answer.kind === 'choice' ? answer.feedback?.trim() : undefined;
  return feedback === undefined || feedback === '' ? undefined : feedback;
}

/** How the CLI is told whose words follow a denial: the user's, as Claude Code says, or another's. */
function deniedWith(answer: PromptAnswer): string {
  if (answer.decider === undefined) return DENIED_WITH_FEEDBACK;
  return DENIED_WITH_FEEDBACK.replace(
    'the user said:',
    `${answer.decider.name} (another party in corrallm, not the user) said:`,
  );
}

/** An input shown whole, or a marked preview of one too big; a command always whole. */
function shownInput(tool: string, input: Record<string, unknown>, cuts: Cuts): PromptJson {
  return COMMANDS.has(tool) ? (input as PromptJson) : boundedInput(input, cuts);
}

/**
 * An input shown whole, or a marked preview of one too big (what the Terminal connection, which
 * answers nothing, shows of any input, a command's too).
 */
export function boundedInput(input: unknown, cuts: Cuts): PromptJson {
  if (boundedPromptJson(input, MAX_PROMPT_INPUT_BYTES, MAX_PROMPT_INPUT_DEPTH)) return input;
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    json = undefined;
  }
  cuts.cut = true;
  return `${(json ?? '').slice(0, INPUT_PREVIEW)}…`;
}

/** What a request would do, in at most twelve lines, each of a bounded length. */
export function shownDetail(detail: ToolDetail | undefined, cuts: Cuts): ToolDetail | undefined {
  if (detail === undefined) return undefined;
  const shown = preview(detail, DETAIL_LINES);
  if (shown !== detail) cuts.cut = true;
  if (shown.kind === 'diff') {
    return {
      ...shown,
      lines: shown.lines.map((line) => ({ ...line, text: cuts.text(line.text, DETAIL_LINE) })),
    };
  }
  return {
    kind: 'output',
    text: shown.text
      .split('\n')
      .map((line) => cuts.text(line, DETAIL_LINE))
      .join('\n'),
  };
}

/** Content cut to its bound, and whether anything was. */
export class Cuts {
  cut = false;

  text(value: string, max = MAX_PROMPT_TEXT_LENGTH): string {
    if (value.length <= max) return value;
    this.cut = true;
    const end = value.charCodeAt(max - 2);
    return `${value.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 2 : max - 1)}…`;
  }

  mark(): { cut?: true } {
    return this.cut ? { cut: true } : {};
  }
}
