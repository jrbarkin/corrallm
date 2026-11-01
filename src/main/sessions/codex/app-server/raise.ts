import {
  MAX_ID_LENGTH,
  MAX_PROMPT_DIFF_BYTES,
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
  PromptSubject,
  Question,
} from '../../../../shared/model/prompts';
import { mcpRequestTitle, mcpServerWords } from '../../../../shared/model/words';
import type { FormField, SessionEvent, ToolDetail } from '../../../../shared/session';
import { displayPath, firstLine, output, preview, property, text } from '../../transcript';
import type { Places } from '../../transcript';
import { planConsent } from '../login';
import type { CodexLogin } from '../login';
import { argumentsSummary, commandLine, unwrapShell } from './translate';
import type { McpCall, Patch } from './translate';

/*
 * B13 C4 and C5's maps for Codex's app server (B13 Design §9.2): what Codex asks (a command's, a
 * file change's or more permissions' approval, its questions, an MCP server's elicitation, and the
 * session's own asks: implementing a plan, consent to use the user's ChatGPT plan) as one of the
 * core's prompt kinds, with the facts its classifier reads (a subject, each choice's hint and
 * effects: never the prompt's words), and what Codex is told for each answer, as its TUI tells it
 * (codex-rs/tui/src/bottom_pane/approval_overlay.rs, mcp_server_elicitation.rs, rust-v0.162.1). Pure:
 * the session's Prompts raises and answers them. Pinned by the recordings in fixtures/.
 *
 * - A command's approval offers each decision Codex lists (`availableDecisions`), in its order and
 *   its TUI's words: Yes (`accept`), this command or host for the session (`acceptForSession`),
 *   commands that start alike for good (`acceptWithExecpolicyAmendment`), a host allowed or
 *   blocked for good (`applyNetworkPolicyAmendment`), No and go on (`decline`), No and stop
 *   (`cancel`); with none listed, Yes and No (stop) only. One it can't word is left out
 *   (`omitted`). A host's approval names the host, input to a running command (`writeStdin`) its
 *   own approval, and extra permissions a command asks for are worded whole, or it is declined.
 * - A file change's: Yes, these files (or the folder it asks to write in) for the session, No.
 * - More permissions': this turn, this turn with strict auto review, this session, No.
 * - Questions keep Codex's ids, its own-words answer (`isOther`) and secrecy (`isSecret`); an
 *   answer is a label picked or the words given, one string each, by id. Questions it can't key
 *   faithfully are declined.
 * - An MCP tool call's approval (F13), which Codex asks as an elicitation marked
 *   `codex_approval_kind: mcp_tool_call` or (its elicitations off) as a question of its own, is an
 *   approval of that tool and its input: Allow, for this session or for good where Codex offers
 *   to keep it (`persist`), or Cancel. The tool is the one of its server running with those
 *   arguments; one it can't tell is declined.
 * - An elicitation's form is a form in the flat schema the core re-serialized (`parseForm`), a link
 *   only in `form.url` (worded by the core, with its host); a user verification, or a form it
 *   can't show, is declined naming its server, never quoting it.
 * - Implementing a plan: Yes into Codex's Default, or No, staying in Plan mode (with what to change,
 *   or none). Consent to use the ChatGPT plan: a consent, the user's alone.
 */

/** How a raised prompt's answer becomes what Codex is told: private to the session. */
export type Native =
  /** A command's or a file change's approval: each choice's decision, as Codex offered it. */
  | { kind: 'decision'; decisions: ReadonlyMap<string, unknown> }
  /** More permissions: what Codex asked for, granted as asked. */
  | { kind: 'permissions'; requested: unknown }
  /** Questions, by Codex's ids. */
  | { kind: 'questions'; ids: readonly string[] }
  /** An MCP tool call's approval asked as a question: its id, and each choice's label. */
  | { kind: 'mcpQuestion'; id: string; labels: ReadonlyMap<string, string> }
  /** An MCP tool call's approval asked as an elicitation: the choices offered. */
  | { kind: 'mcpElicitation'; offered: ReadonlySet<string> }
  | { kind: 'form'; fields: readonly FormField[] }
  | { kind: 'link' }
  /** The session's own: implementing a plan, and consent to use the ChatGPT plan. */
  | { kind: 'plan' }
  | { kind: 'consent' };

/** How the events B13 replaces show a prompt (until X10 converts the renderer; X11 removes it). */
export type Shown =
  | Omit<Extract<SessionEvent, { type: 'permission' }>, 'id'>
  | Omit<Extract<SessionEvent, { type: 'question' }>, 'id'>
  | Omit<Extract<SessionEvent, { type: 'plan' }>, 'id'>
  | Omit<Extract<SessionEvent, { type: 'elicitation' }>, 'id'>;

/**
 * A request raised (its prompt, how its answer goes, how it is shown until X10), or declined at
 * once: what to tell the user, and what Codex is told.
 */
export type Raised =
  { prompt: AdapterPrompt; native: Native; shown: Shown } | { declined: string; result: unknown };

/** What a request is raised with: the session's places, and what the translator saw before it. */
export interface RaiseContext {
  places: Places;
  /** A file change's patch, by its item's id. */
  patch(itemId: string): Patch | undefined;
  /** An MCP tool call still running, by its item's id. */
  mcpCall(itemId: string): McpCall | undefined;
  /** Every MCP tool call still running. */
  mcpCalls(): readonly McpCall[];
}

/** Codex's nonapprovals (C3): a command or change cancelled, no permissions, no answers. */
const CANCEL = { decision: 'cancel' };
const NO_PERMISSIONS = { permissions: {}, scope: 'turn' };
const NO_ANSWERS = { answers: {} };
const elicited = (action: 'accept' | 'decline' | 'cancel') => ({
  action,
  content: null,
  _meta: null,
});

/** The longest line of a detail shown, and how many lines (the last saying how many more). */
const DETAIL_LINE = 2000;
const DETAIL_LINES = 11;
/** How much of an input too big to show whole its preview shows. */
const INPUT_PREVIEW = 4000;

/** Codex's own approval of an MCP tool call, asked as a question: its id names the call's item. */
const MCP_QUESTION = 'mcp_tool_call_approval_';
/** What a request's approval is, as its elicitation's `_meta` marks it. */
const APPROVAL_KIND = 'codex_approval_kind';
const MCP_TOOL_CALL = 'mcp_tool_call';

/** What Codex asks of its client, raised: undefined for a request that isn't a prompt. */
export function raised(method: string, params: unknown, context: RaiseContext): Raised | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return commandPrompt(params, context);
    case 'item/fileChange/requestApproval':
      return fileChangePrompt(params, context);
    case 'item/permissions/requestApproval':
      return permissionsPrompt(params, context);
    case 'item/tool/requestUserInput':
      return questionsPrompt(params, context);
    case 'mcpServer/elicitation/request':
      return elicitationPrompt(params, context);
    default:
      return undefined;
  }
}

/** Yes, once, changing nothing more. */
function once(value: string, label: string, description?: string): Choice {
  return {
    value,
    label,
    ...(description === undefined ? {} : { description }),
    hint: 'allow_once',
    effects: {},
    feedback: 'none',
    endsTurn: false,
  };
}

/** No, and tell Codex what to do differently: stops the turn. */
const STOP: Choice = {
  value: 'cancel',
  label: 'No, and tell Codex what to do differently',
  hint: 'reject_once',
  effects: {},
  feedback: 'none',
  endsTurn: true,
};

/** Effects, if `ChoiceEffects` can say them within its bounds: absent (unknown) otherwise. */
function effects(value: ChoiceEffects): { effects: ChoiceEffects } | Record<string, never> {
  const parsed = ChoiceEffects.safeParse(value);
  return parsed.success ? { effects: parsed.data } : {};
}

/** A rule for each of `rules`, kept as `scope` says. */
function rules(rules: readonly string[], scope: 'session' | 'user') {
  return effects({ rules: rules.map((rule) => ({ behavior: 'allow' as const, rule, scope })) });
}

function commandPrompt(params: unknown, { places }: RaiseContext): Raised {
  const cuts = new Cuts();
  const stdin = property(params, 'kind') === 'writeStdin';
  const command = text(property(params, 'command'));
  const cwd = text(property(params, 'cwd'));
  const reason = text(property(params, 'reason'));
  const network = hostOf(property(params, 'networkApprovalContext'));
  const additional = property(params, 'additionalPermissions');
  const asked = additional === null || additional === undefined ? null : askedOf(additional);
  if (asked === undefined)
    return {
      declined: 'Codex asked for permissions corrallm can’t show whole, so it was declined.',
      result: CANCEL,
    };
  let subject: PromptSubject;
  if (network !== undefined) subject = { type: 'network', ...network };
  else if (command !== undefined && cwd !== undefined) subject = { type: 'command', command, cwd };
  else
    return {
      declined: 'Codex asked to run a command corrallm couldn’t see, so it was declined.',
      result: CANCEL,
    };
  const shownCommand = command === undefined ? '' : stdin ? command : unwrapShell(command);
  const head = cuts.text(network?.host ?? firstLine(shownCommand));
  // The permissions it asks for besides are said whole, or not at all.
  const extra = asked === null ? '' : permissionWords(asked, places);
  const summary = extra === '' ? head : `${head}, with ${extra}`;
  if (summary.length > MAX_PROMPT_TEXT_LENGTH)
    return {
      declined: 'Codex asked for permissions corrallm can’t show whole, so it was declined.',
      result: CANCEL,
    };
  const listed = property(params, 'availableDecisions');
  const decisions: unknown[] =
    Array.isArray(listed) && listed.length > 0 ? listed : ['accept', 'cancel'];
  const choices: Choice[] = [];
  const native = new Map<string, unknown>();
  let omitted = false;
  for (const decision of decisions) {
    const choice = commandChoice(decision, {
      ...(network === undefined ? {} : { host: network.host }),
      more: asked !== null,
      command: shownCommand,
    });
    if (choice === undefined || choice.label.length > MAX_PROMPT_LABEL_LENGTH) {
      omitted = true;
      continue;
    }
    let { value } = choice;
    for (let n = 2; native.has(value); n += 1) value = `${choice.value}:${String(n)}`;
    choices.push({ ...choice, value });
    native.set(value, decision);
  }
  const detail =
    network === undefined && shownCommand.includes('\n')
      ? shownDetail(output(shownCommand), cuts)
      : undefined;
  const title =
    network !== undefined
      ? `Codex wants to reach ${network.host}`
      : stdin
        ? 'Codex wants to send input to a running command'
        : 'Codex wants to run a command';
  return {
    prompt: {
      kind: 'approval',
      title: cuts.text(title),
      ...(summary === '' ? {} : { summary }),
      ...(reason === undefined || reason === '' ? {} : { reason: cuts.text(reason) }),
      ...(detail === undefined ? {} : { detail }),
      subject,
      answerIn: 'api',
      choices,
      ...(omitted ? { omitted: true as const } : {}),
      ...cuts.mark(),
    },
    native: { kind: 'decision', decisions: native },
    shown: {
      type: 'permission',
      tool: stdin ? 'write_stdin' : 'exec_command',
      summary,
      always: choices.find(({ hint }) => hint === 'allow_always')?.label ?? null,
      ...(network === undefined && shownCommand.includes('\n')
        ? { detail: output(shownCommand) }
        : {}),
      ...(network !== undefined
        ? {
            title: `Codex wants to reach ${network.host}${reason === undefined ? '' : `: ${reason}`}`,
          }
        : reason === undefined
          ? {}
          : { title: reason }),
    },
  };
}

/** One of a command's decisions as its choice, in Codex's TUI's words; undefined if it can't be. */
function commandChoice(
  decision: unknown,
  { host, more, command }: { host?: string; more: boolean; command: string },
): Choice | undefined {
  const keep = { hint: 'allow_always' as const, feedback: 'none' as const, endsTurn: false };
  switch (decision) {
    case 'accept':
      return once('accept', host === undefined ? 'Yes, proceed' : 'Yes, just this once');
    case 'acceptForSession':
      return {
        value: 'acceptForSession',
        label:
          host !== undefined
            ? 'Yes, and allow this host for this conversation'
            : more
              ? 'Yes, and allow these permissions for this session'
              : "Yes, and don't ask again for this command in this session",
        ...keep,
        ...(host !== undefined
          ? effects({ network: { host, allow: true, scope: 'session' } })
          : more
            ? {}
            : rules([`exec_command(${command})`], 'session')),
      };
    case 'decline':
      return {
        value: 'decline',
        label: 'No, continue without running it',
        hint: 'reject_once',
        effects: {},
        feedback: 'none',
        endsTurn: false,
      };
    case 'cancel':
      return STOP;
  }
  const prefix = property(
    property(decision, 'acceptWithExecpolicyAmendment'),
    'execpolicy_amendment',
  );
  if (Array.isArray(prefix)) {
    if (!prefix.every((part) => typeof part === 'string')) return undefined;
    const line = commandLine(prefix);
    // Codex's TUI hides a prefix it can't show on one line.
    if (line.includes('\n') || line.includes('\r')) return undefined;
    return {
      value: 'acceptWithExecpolicyAmendment',
      label: `Yes, and don't ask again for commands that start with \`${line}\``,
      ...keep,
      ...rules([`exec_command(${line} *)`], 'user'),
    };
  }
  const amendment = property(
    property(decision, 'applyNetworkPolicyAmendment'),
    'network_policy_amendment',
  );
  const amended = text(property(amendment, 'host'));
  const action = property(amendment, 'action');
  if (amended === undefined || amended === '' || (action !== 'allow' && action !== 'deny'))
    return undefined;
  return {
    value: `applyNetworkPolicyAmendment:${action}`,
    label:
      action === 'allow'
        ? `Yes, and allow ${amended === host ? 'this host' : `host \`${amended}\``} in the future`
        : `No, and block ${amended === host ? 'this host' : `host \`${amended}\``} in the future`,
    hint: action === 'allow' ? 'allow_always' : 'reject_always',
    ...effects({ network: { host: amended, allow: action === 'allow', scope: 'user' } }),
    feedback: 'none',
    endsTurn: false,
  };
}

/** The host a network approval names: none if it names none. */
function hostOf(context: unknown): { host: string; protocol?: string } | undefined {
  const host = text(property(context, 'host'));
  if (host === undefined || host === '') return undefined;
  const protocol = text(property(context, 'protocol'));
  return { host, ...(protocol === undefined || protocol === '' ? {} : { protocol }) };
}

function fileChangePrompt(params: unknown, context: RaiseContext): Raised {
  const { places } = context;
  const itemId = text(property(params, 'itemId'));
  const found = itemId === undefined ? undefined : context.patch(itemId);
  if (found === undefined || found.files.length === 0)
    return {
      declined: 'Codex asked to change files corrallm couldn’t see, so it was declined.',
      result: CANCEL,
    };
  const cuts = new Cuts();
  const root = text(property(params, 'grantRoot'));
  const reason = text(property(params, 'reason'));
  const detail = found.detail === undefined ? undefined : shownDetail(found.detail, cuts);
  // Each file's whole diff while they fit, together with the preview: the paths always.
  let room = MAX_PROMPT_DIFF_BYTES - detailBytes(detail);
  const files = found.files.map(({ path, diff = '' }) => {
    const size = utf8(diff);
    if (diff !== '' && size <= room) {
      room -= size;
      return { path, diff };
    }
    if (diff !== '') cuts.cut = true;
    return { path };
  });
  const session =
    root === undefined || root === ''
      ? rules(
          found.files.map(({ path }) => `apply_patch(${path})`),
          'session',
        )
      : effects({ directories: [root] });
  const label =
    root === undefined || root === ''
      ? "Yes, and don't ask again for these files"
      : `Yes, and allow edits in \`${root}\` for this session`;
  const keeping: Choice[] =
    label.length > MAX_PROMPT_LABEL_LENGTH
      ? []
      : [
          {
            value: 'acceptForSession',
            label,
            hint: 'allow_always',
            ...session,
            feedback: 'none',
            endsTurn: false,
          },
        ];
  const choices = [once('accept', 'Yes, proceed'), ...keeping, STOP];
  return {
    prompt: {
      kind: 'approval',
      title: 'Codex wants to make these edits',
      ...(found.summary === '' ? {} : { summary: cuts.text(found.summary) }),
      ...(reason === undefined || reason === '' ? {} : { reason: cuts.text(reason) }),
      ...(detail === undefined ? {} : { detail }),
      subject: { type: 'fileChange', files },
      answerIn: 'api',
      choices,
      ...(keeping.length === 0 ? { omitted: true as const } : {}),
      ...cuts.mark(),
    },
    native: {
      kind: 'decision',
      decisions: new Map(choices.map(({ value }) => [value, value])),
    },
    shown: {
      type: 'permission',
      tool: 'apply_patch',
      summary: found.summary,
      always: keeping[0]?.label ?? null,
      ...(found.detail === undefined ? {} : { detail: found.detail }),
      ...(reason !== undefined
        ? { title: reason }
        : root === undefined
          ? {}
          : { title: `Codex wants to write in ${displayPath(root, places)}` }),
    },
  };
}

/** What a permissions request asks for: undefined if it asks for what corrallm can't show whole. */
interface Asked {
  network: boolean;
  read: string[];
  write: string[];
}

function askedOf(value: unknown): Asked | undefined {
  const asked: Asked = {
    network: property(property(value, 'network'), 'enabled') === true,
    read: [],
    write: [],
  };
  const files = property(value, 'fileSystem');
  if (files === null || files === undefined) return asked;
  for (const access of ['read', 'write'] as const) {
    const listed = property(files, access);
    if (listed === null || listed === undefined) continue;
    if (!Array.isArray(listed) || !listed.every((one) => typeof one === 'string')) return undefined;
    asked[access].push(...listed);
  }
  const entries = property(files, 'entries');
  if (entries === null || entries === undefined) return asked;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    // A pattern, a special place or a denial: not a folder the core can name.
    const access = property(entry, 'access');
    const where = property(entry, 'path');
    const path = text(property(where, 'path'));
    if (
      (access !== 'read' && access !== 'write') ||
      property(where, 'type') !== 'path' ||
      path === undefined ||
      path === ''
    )
      return undefined;
    asked[access].push(path);
  }
  return asked;
}

/** What it asks for, in words: "network access; write ~/.npm; read /data". */
function permissionWords({ network, read, write }: Asked, places: Places): string {
  const shown = (files: readonly string[]) =>
    files.map((file) => (file.startsWith('/') ? displayPath(file, places) : file)).join(', ');
  return [
    ...(network ? ['network access'] : []),
    ...(write.length > 0 ? [`write ${shown(write)}`] : []),
    ...(read.length > 0 ? [`read ${shown(read)}`] : []),
  ].join('; ');
}

function permissionsPrompt(params: unknown, { places }: RaiseContext): Raised {
  const requested = property(params, 'permissions');
  const asked = askedOf(requested);
  if (asked === undefined)
    return {
      declined: 'Codex asked for permissions corrallm can’t show whole, so it was declined.',
      result: NO_PERMISSIONS,
    };
  const cuts = new Cuts();
  const reason = text(property(params, 'reason'));
  const words = permissionWords(asked, places);
  const granted = (scope: 'turn' | 'session') => {
    const directories = [...asked.read, ...asked.write];
    return effects({
      ...(directories.length === 0 ? {} : { directories }),
      ...(asked.network ? { network: { host: '*', allow: true, scope } } : {}),
    });
  };
  const turn = granted('turn');
  return {
    prompt: {
      kind: 'approval',
      title: 'Codex wants more permissions',
      ...(words === '' ? {} : { summary: cuts.text(words) }),
      ...(reason === undefined || reason === '' ? {} : { reason: cuts.text(reason) }),
      subject: {
        type: 'permissions',
        ...(asked.network ? { network: true } : {}),
        ...(asked.read.length === 0 ? {} : { read: asked.read }),
        ...(asked.write.length === 0 ? {} : { write: asked.write }),
      },
      answerIn: 'api',
      choices: [
        {
          value: 'turn',
          label: 'Yes, grant these permissions for this turn',
          hint: 'allow_once',
          ...turn,
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'strict',
          label: 'Yes, grant for this turn with strict auto review',
          hint: 'allow_once',
          ...turn,
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'session',
          label: 'Yes, grant these permissions for this session',
          hint: 'allow_always',
          ...granted('session'),
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'deny',
          label: 'No, continue without permissions',
          hint: 'reject_once',
          effects: {},
          feedback: 'none',
          endsTurn: false,
        },
      ],
      ...cuts.mark(),
    },
    native: { kind: 'permissions', requested },
    shown: {
      type: 'permission',
      tool: 'permissions',
      summary: words,
      always: 'Yes, grant these permissions for this session',
      title: `Codex wants more permissions${reason === undefined ? '' : `: ${reason}`}`,
    },
  };
}

function questionsPrompt(params: unknown, context: RaiseContext): Raised {
  const itemId = text(property(params, 'itemId'));
  const listed = property(params, 'questions');
  const cant = (why: string): Raised => ({
    declined: `Codex asked something corrallm can’t pass on faithfully (${why}), so it was declined.`,
    result: NO_ANSWERS,
  });
  if (!Array.isArray(listed) || listed.length === 0) return cant('it isn’t a list of questions');
  // Codex's own approval of an MCP tool call (its elicitations off): one question, its id naming
  // the call's item. Codex marks every question its model asks isOther: this one never is.
  const [only] = listed as unknown[];
  if (listed.length === 1 && itemId !== undefined && property(only, 'isOther') === false) {
    const call = context.mcpCall(itemId);
    if (call !== undefined && property(only, 'id') === `${MCP_QUESTION}${itemId}`)
      return mcpQuestionPrompt(only, call);
  }
  const cuts = new Cuts();
  const questions: Question[] = [];
  for (const item of listed as unknown[]) {
    const id = text(property(item, 'id'));
    const asked = text(property(item, 'question'));
    if (id === undefined || id === '' || asked === undefined)
      return cant('a question has no id or text');
    if (questions.some((question) => question.id === id)) return cant('two questions under one id');
    const header = text(property(item, 'header')) ?? '';
    if (header.length > MAX_ID_LENGTH) return cant('a question’s header is too long');
    const options = property(item, 'options');
    const offered: unknown[] | undefined =
      options === null || options === undefined ? [] : Array.isArray(options) ? options : undefined;
    if (offered === undefined) return cant('a question’s answers aren’t a list');
    const labels = offered.map((option) => text(property(option, 'label')) ?? '');
    if (labels.some((label) => label === '')) return cant('an answer has no label');
    if (new Set(labels).size !== labels.length) return cant('two answers the same');
    questions.push({
      id,
      header,
      text: asked,
      options: offered.map((option, i) => {
        const description = text(property(option, 'description'));
        return {
          label: labels[i] ?? '',
          ...(description === undefined || description === ''
            ? {}
            : { description: cuts.text(description) }),
        };
      }),
      multiple: false,
      other: property(item, 'isOther') === true,
      ...(property(item, 'isSecret') === true ? { secret: true } : {}),
    });
  }
  const [first] = questions;
  return {
    prompt: {
      kind: 'question',
      title: cuts.text(
        questions.length === 1 && first !== undefined
          ? first.text
          : `Codex asks ${String(questions.length)} questions`,
      ),
      answerIn: 'api',
      questions,
      ...cuts.mark(),
    },
    native: { kind: 'questions', ids: questions.map(({ id }) => id) },
    shown: {
      type: 'question',
      questions: questions.map((question) => ({
        header: question.header,
        text: question.text,
        options: question.options.map(({ label, description }) => ({
          label,
          description: description ?? '',
        })),
        multiple: false,
      })),
    },
  };
}

/** The choices of Codex's approval of an MCP tool call, by its labels, as it words them. */
const MCP_CHOICES: Readonly<Record<string, { value: string; keep?: 'session' | 'user' }>> = {
  Allow: { value: 'allow' },
  'Allow for this session': { value: 'session', keep: 'session' },
  "Allow and don't ask me again": { value: 'always', keep: 'user' },
  Cancel: { value: 'cancel' },
};

/** An MCP tool call's choice: once, kept (for the session, or the user's for good), or cancelled. */
function mcpChoice(
  value: string,
  label: string,
  description: string | undefined,
  call: McpCall,
  keep?: 'session' | 'user',
): Choice {
  const said = description === undefined || description === '' ? {} : { description };
  if (value === 'cancel')
    return {
      value,
      label,
      ...said,
      hint: 'reject_once',
      effects: {},
      feedback: 'none',
      endsTurn: false,
    };
  if (keep === undefined) return once(value, label, description === '' ? undefined : description);
  return {
    value,
    label,
    ...said,
    hint: 'allow_always',
    ...rules([`mcp__${call.server}__${call.tool}`], keep),
    feedback: 'none',
    endsTurn: false,
  };
}

/** An MCP tool call's approval as an approval prompt of that tool and its input. */
function mcpApproval(
  call: McpCall,
  title: string,
  choices: Choice[],
  omitted: boolean,
  cuts: Cuts,
): { prompt: AdapterPrompt; shown: Shown } {
  const summary = argumentsSummary(call.arguments);
  return {
    prompt: {
      kind: 'approval',
      title: cuts.text(title),
      ...(summary === '' ? {} : { summary: cuts.text(summary) }),
      subject: {
        type: 'mcpTool',
        // Its identity whole, or the core declines it.
        server: call.server,
        tool: call.tool,
        input: shownInput(call.arguments ?? {}, cuts),
      },
      answerIn: 'api',
      choices,
      ...(omitted ? { omitted: true as const } : {}),
      ...cuts.mark(),
    },
    shown: {
      type: 'permission',
      tool: `mcp__${call.server}__${call.tool}`,
      summary,
      always: choices.find(({ hint }) => hint === 'allow_always')?.label ?? null,
      title,
    },
  };
}

function mcpQuestionPrompt(question: unknown, call: McpCall): Raised {
  const cuts = new Cuts();
  const id = text(property(question, 'id')) ?? '';
  const options = property(question, 'options');
  const labels = new Map<string, string>();
  const choices: Choice[] = [];
  let omitted = false;
  for (const option of Array.isArray(options) ? options : []) {
    const label = text(property(option, 'label')) ?? '';
    const known = Object.hasOwn(MCP_CHOICES, label) ? MCP_CHOICES[label] : undefined;
    if (known === undefined || labels.has(known.value)) {
      omitted = true;
      continue;
    }
    const description = text(property(option, 'description'));
    labels.set(known.value, label);
    choices.push(
      mcpChoice(
        known.value,
        label,
        description === undefined ? undefined : cuts.text(description),
        call,
        known.keep,
      ),
    );
  }
  const title = text(property(question, 'question')) ?? `Codex asks to run ${call.tool}`;
  return {
    ...mcpApproval(call, title, choices, omitted, cuts),
    native: { kind: 'mcpQuestion', id, labels },
  };
}

/** Whether two JSON values are the same, whatever the order of their keys. */
function sameJson(one: unknown, other: unknown): boolean {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, sorted(item)]),
          )
        : value;
  try {
    return JSON.stringify(sorted(one)) === JSON.stringify(sorted(other));
  } catch {
    return false;
  }
}

function mcpElicitationPrompt(
  server: string,
  meta: unknown,
  message: string,
  context: RaiseContext,
): Raised {
  const args = property(meta, 'tool_params');
  // The call it approves: its server's, running with those arguments. Its tool is that call's.
  const calls = context
    .mcpCalls()
    .filter((call) => call.server === server && sameJson(call.arguments ?? {}, args ?? {}));
  const [call] = calls;
  if (call === undefined || calls.some(({ tool }) => tool !== call.tool))
    return {
      declined: `Codex asked to approve a tool call of ${mcpServerWords(server)} corrallm couldn’t tell, so it was declined.`,
      result: elicited('decline'),
    };
  const persist = property(meta, 'persist');
  const offers = (mode: string) =>
    persist === mode || (Array.isArray(persist) && persist.includes(mode));
  const cuts = new Cuts();
  const choices: Choice[] = [
    mcpChoice('allow', 'Allow', 'Run the tool and continue', call),
    ...(offers('session')
      ? [
          mcpChoice(
            'session',
            'Allow for this session',
            'Run the tool and remember this choice for this session',
            call,
            'session',
          ),
        ]
      : []),
    ...(offers('always')
      ? [
          mcpChoice(
            'always',
            'Always allow',
            'Run the tool and remember this choice for future tool calls',
            call,
            'user',
          ),
        ]
      : []),
    mcpChoice('cancel', 'Cancel', 'Cancel this tool call', call),
  ];
  return {
    ...mcpApproval(
      call,
      message.trim() === '' ? `Codex asks to run ${call.tool}` : message,
      choices,
      false,
      cuts,
    ),
    native: { kind: 'mcpElicitation', offered: new Set(choices.map(({ value }) => value)) },
  };
}

function elicitationPrompt(params: unknown, context: RaiseContext): Raised {
  const server = text(property(params, 'serverName')) ?? '';
  const message = text(property(params, 'message')) ?? '';
  const mode = property(params, 'mode');
  const meta = property(params, '_meta');
  const schema = property(params, 'requestedSchema');
  /** The server's name, as the core's title for a form uses it: cut, and marked so, if long. */
  const named = (cuts: Cuts) => (server === '' ? {} : { server: cuts.text(server, MAX_ID_LENGTH) });
  if (
    mode === 'form' &&
    property(meta, APPROVAL_KIND) === MCP_TOOL_CALL &&
    (schema === null ||
      schema === undefined ||
      (property(schema, 'type') === 'object' && isEmpty(property(schema, 'properties'))))
  )
    return mcpElicitationPrompt(server, meta, message, context);
  if (mode === 'url') {
    const url = text(property(params, 'url'));
    if (url === undefined || url === '')
      return {
        declined: `${mcpServerWords(server)} asked to open a link it didn’t give, so it was declined.`,
        result: elicited('decline'),
      };
    // The link only in the form, and the server's words nowhere (they may hold the link, as it
    // is or encoded): the core's, naming the link's host as its Open does (B13 C8, C11).
    let host: string | undefined;
    try {
      host = new URL(url).host;
    } catch {
      host = undefined;
    }
    const cuts = new Cuts();
    const title = cuts.text(mcpRequestTitle(server, true, host === '' ? undefined : host));
    return {
      prompt: {
        kind: 'form',
        title,
        ...named(cuts),
        answerIn: 'api',
        form: { url },
        ...cuts.mark(),
      },
      native: { kind: 'link' },
      shown: { type: 'elicitation', server, message: title, url },
    };
  }
  if (mode === 'form' || mode === 'openai/form' || mode === 'openaiForm') {
    const parsed = parseForm(schema);
    // Declined naming its server, never quoting its words, which may hold a link.
    if (parsed === undefined)
      return {
        declined: `${mcpServerWords(server)} asked for a form corrallm can’t show, so it was declined.`,
        result: elicited('decline'),
      };
    const cuts = new Cuts();
    const title = cuts.text(message.trim() === '' ? mcpRequestTitle(server, false) : message);
    return {
      prompt: {
        kind: 'form',
        title,
        ...named(cuts),
        answerIn: 'api',
        form: { schema: parsed.schema },
        ...cuts.mark(),
      },
      native: { kind: 'form', fields: parsed.fields },
      shown: { type: 'elicitation', server, message: title, fields: [...parsed.fields] },
    };
  }
  if (mode === 'openai/userVerification')
    return {
      declined: `${mcpServerWords(server)} asked to verify who you are, which corrallm can’t do, so it was declined.`,
      result: elicited('decline'),
    };
  return {
    declined: `${mcpServerWords(server)} asked for something corrallm can’t show, so it was declined.`,
    result: elicited('decline'),
  };
}

function isEmpty(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0;
}

/** Asking to implement the plan Codex proposed, as its TUI asks once a plan turn ends. */
export function implementPrompt(plan: string): Raised {
  return {
    prompt: {
      kind: 'plan',
      title: 'Implement this plan?',
      plan,
      answerIn: 'api',
      choices: [
        { ...once('implement', 'Yes, implement this plan'), effects: { mode: 'auto' } },
        {
          value: 'keep-planning',
          label: 'No, stay in Plan mode',
          hint: 'reject_once',
          effects: {},
          feedback: 'optional',
        },
      ],
    },
    native: { kind: 'plan' },
    shown: { type: 'plan', plan },
  };
}

/** Asking before a session first uses the user's ChatGPT plan: a consent, the user's alone. */
export function consentPrompt(login: Extract<CodexLogin, { kind: 'chatgpt' }>): Raised {
  const { plan, text: words } = planConsent(login);
  const title = 'Use your ChatGPT plan here?';
  const always = "Yes, and don't ask again on this computer";
  return {
    prompt: {
      kind: 'approval',
      title,
      summary: plan,
      subject: { type: 'consent', key: 'chatgpt-plan', text: words },
      answerIn: 'api',
      choices: [
        once('once', 'Yes'),
        // Kept in corrallm's settings, for every Codex agent: no effect the core can say.
        { value: 'always', label: always, hint: 'allow_always', feedback: 'none', endsTurn: false },
        {
          value: 'no',
          label: 'No',
          hint: 'reject_once',
          effects: {},
          feedback: 'none',
          endsTurn: true,
        },
      ],
    },
    native: { kind: 'consent' },
    shown: {
      type: 'permission',
      tool: 'ChatGPT plan',
      summary: plan,
      title,
      detail: output(words),
      always,
    },
  };
}

/**
 * What Codex is told for `answer` (a JSON-RPC result, or the session's own answer to a plan or a
 * consent); throws, saying why, for one the prompt doesn't take (it still waits). Codex would take
 * another party's words or answers as the user's: those are framed as theirs, or refused.
 */
export function nativeResult(native: Native, answer: PromptAnswer): unknown {
  switch (native.kind) {
    case 'decision': {
      const value = chosen(answer);
      if (!native.decisions.has(value)) throw notOffered(value);
      return { decision: native.decisions.get(value) };
    }
    case 'permissions':
      switch (chosen(answer)) {
        case 'turn':
          return { permissions: native.requested, scope: 'turn' };
        case 'strict':
          return { permissions: native.requested, scope: 'turn', strictAutoReview: true };
        case 'session':
          return { permissions: native.requested, scope: 'session' };
        case 'deny':
          return NO_PERMISSIONS;
        default:
          throw notOffered(chosen(answer));
      }
    case 'questions': {
      if (answer.kind !== 'questions') throw new Error('Answer the questions.');
      if (answer.decider !== undefined) throw new Error(ONLY_THE_USER);
      const answers = Object.fromEntries(
        native.ids.map((id) => {
          const given = Object.hasOwn(answer.answers, id) ? answer.answers[id] : undefined;
          if (given === undefined) throw new Error(`Answer question ${id}.`);
          return [id, { answers: 'picked' in given ? [...given.picked] : [given.text] }];
        }),
      );
      return { answers };
    }
    case 'mcpQuestion': {
      const value = chosen(answer);
      const label = native.labels.get(value);
      if (label === undefined) throw notOffered(value);
      return { answers: { [native.id]: { answers: [label] } } };
    }
    case 'mcpElicitation': {
      const value = chosen(answer);
      if (!native.offered.has(value)) throw notOffered(value);
      if (value === 'cancel') return elicited('cancel');
      if (value === 'allow') return elicited('accept');
      return {
        ...elicited('accept'),
        _meta: { persist: value === 'session' ? 'session' : 'always' },
      };
    }
    case 'form':
    case 'link': {
      if (answer.kind !== 'form') throw new Error('Answer the form.');
      if (answer.decider !== undefined) throw new Error(ONLY_THE_USER);
      if (answer.action !== 'accept') {
        if (answer.values !== undefined) throw new Error('Only an accepted form carries values.');
        return elicited(answer.action);
      }
      if (native.kind === 'link') {
        if (answer.values !== undefined) throw new Error('A link takes no values.');
        return elicited('accept');
      }
      return { ...elicited('accept'), content: formContent(native.fields, answer.values ?? {}) };
    }
    case 'plan': {
      const value = chosen(answer);
      if (value === 'implement') return { approve: true };
      if (value !== 'keep-planning') throw notOffered(value);
      const feedback = said(answer);
      if (feedback === undefined) return { approve: false };
      return {
        approve: false,
        feedback:
          answer.decider === undefined
            ? feedback
            : `${answer.decider.name} (another party in corrallm, not the user) asks you to keep planning: ${feedback}`,
      };
    }
    case 'consent': {
      if (answer.decider !== undefined) throw new Error(ONLY_THE_USER);
      switch (chosen(answer)) {
        case 'once':
          return 'once';
        case 'always':
          return 'always';
        case 'no':
          return 'deny';
        default:
          throw notOffered(chosen(answer));
      }
    }
  }
}

/**
 * What Codex is told for a request no one answers (B13 C3: the core declined it, Codex stopped
 * waiting, the session closed): a command or a change cancelled, no permissions, no answers, a form
 * cancelled. Undefined for the session's own asks: those just end.
 */
export function nonapproval(native: Native): unknown {
  switch (native.kind) {
    case 'decision':
      return CANCEL;
    case 'permissions':
      return NO_PERMISSIONS;
    case 'questions':
    case 'mcpQuestion':
      return NO_ANSWERS;
    case 'mcpElicitation':
    case 'form':
    case 'link':
      return elicited('cancel');
    case 'plan':
    case 'consent':
      return undefined;
  }
}

const ONLY_THE_USER =
  'Only the user answers this: Codex would take another party’s answer as the user’s.';

function notOffered(value: string): Error {
  return new Error(`That decision is not offered by this prompt: ${value}.`);
}

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

/** An input shown whole, or a marked preview of one too big. */
function shownInput(input: unknown, cuts: Cuts): PromptJson {
  if (boundedPromptJson(input, MAX_PROMPT_INPUT_BYTES, MAX_PROMPT_INPUT_DEPTH)) return input;
  let json = '';
  try {
    const whole: unknown = JSON.stringify(input);
    if (typeof whole === 'string') json = whole;
  } catch {
    // Shown as nothing but its mark.
  }
  cuts.cut = true;
  return `${json.slice(0, INPUT_PREVIEW)}…`;
}

/** What a request would do, in at most twelve lines, each of a bounded length. */
function shownDetail(detail: ToolDetail, cuts: Cuts): ToolDetail {
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

function detailBytes(detail: ToolDetail | undefined): number {
  return detail?.kind === 'diff'
    ? detail.lines.reduce((size, line) => size + utf8(line.text), 0)
    : 0;
}

function utf8(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Content cut to its bound, and whether anything was. */
class Cuts {
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
