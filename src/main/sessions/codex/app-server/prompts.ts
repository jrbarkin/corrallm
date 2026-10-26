import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { MAX_QUESTIONS } from '../../../../shared/session';
import type {
  AskedQuestion,
  SessionAnswer,
  SessionEvent,
  ToolDetail,
} from '../../../../shared/session';
import { displayPath, firstLine, notice, output, property, text } from '../../transcript';
import type { Places } from '../../transcript';
import { RPC_ERRORS, RpcFailure } from '../rpc';
import type { RequestId } from '../rpc';
import type { CommandDecision, FileChangeDecision } from './protocol';
import { commandLine, unwrapShell } from './translate';

/*
 * What Codex asks the user, through its app server's requests: to run a command (or reach a host
 * on the network), to apply a patch, for more permissions, its questions (request_user_input), and
 * an MCP server's elicitations. Each becomes a prompt event; the renderer's answer
 * (the core reply operation) becomes the request's result, as Codex's own TUI answers it
 * (codex-rs/tui/src/bottom_pane/approval_overlay.rs, rust-v0.160.1): Yes is `accept`; "always" is
 * the decision it offers to keep (for this session, or an exec policy rule for commands that start
 * alike); No is `cancel` ("No, and tell Codex what to do differently"), which stops the turn as
 * Claude Code's No does. Codex keeps what "always" allowed itself: corrallm never answers for the
 * user. A request Codex stops waiting for (serverRequest/resolved) is withdrawn; every request is
 * answered, even then.
 */

/** Where prompts go, and the session's say on what they show. */
export interface PromptHost {
  emit(event: SessionEvent): void;
  /** A prompt no longer waits on the user, and none other does: the session works on. */
  settled(): void;
  /** What a patch would do (from its item, which came first): its files and their diffs. */
  patch(itemId: string): { summary: string; detail: ToolDetail | undefined } | undefined;
}

/** A prompt waiting for the user: its request's id, and how its answer reaches the request. */
interface Waiting {
  request: RequestId;
  answered: (answer: SessionAnswer | undefined) => void;
}

/** How a request is answered when the user does not (the turn ended, the session closed). */
const NOT_ANSWERED = 'cancel';

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

  /** Answers a request the app server made: asks the user, if it is one corrallm asks. */
  readonly request = async (method: string, params: unknown, id: RequestId): Promise<unknown> => {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.#command(params, id);
      case 'item/fileChange/requestApproval':
        return this.#fileChange(params, id);
      case 'item/permissions/requestApproval':
        return this.#permissions(params, id);
      case 'item/tool/requestUserInput':
        return this.#questions(params, id);
      case 'mcpServer/elicitation/request':
        return this.#elicitation(params, id);
      case 'currentTime/read':
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      default:
        throw new RpcFailure(RPC_ERRORS.methodNotFound, `corrallm does not handle ${method}`);
    }
  };

  /** Passes on the user's answer to prompt `id`; rejects if it no longer waits for one. */
  answer(id: string, answer: SessionAnswer): void {
    const waiting = this.#open.get(id);
    if (!waiting) throw new Error('That question is no longer asked.');
    this.#open.delete(id);
    if (this.#open.size === 0) this.#host.settled();
    waiting.answered(answer);
  }

  /** Codex stopped waiting for request `id` (answered elsewhere, or its turn ended): withdrawn. */
  resolved(id: RequestId): void {
    for (const [promptId, waiting] of this.#open) {
      if (waiting.request !== id) continue;
      this.#open.delete(promptId);
      this.#host.emit({ type: 'withdrawn', id: promptId });
      if (this.#open.size === 0) this.#host.settled();
      waiting.answered(undefined);
    }
  }

  /** Stops waiting for every prompt, as the session closes. */
  withdrawAll(): void {
    for (const [id, waiting] of [...this.#open]) {
      this.#open.delete(id);
      waiting.answered(undefined);
    }
  }

  /** Shows a prompt and waits for its answer: undefined if Codex stopped asking first. */
  #ask(id: string, request: RequestId, prompt: SessionEvent): Promise<SessionAnswer | undefined> {
    return new Promise((resolve) => {
      this.#open.set(id, { request, answered: resolve });
      this.#host.emit(prompt);
      this.#host.emit({ type: 'status', status: 'waiting' });
    });
  }

  /** A prompt's id: the item it asks about's, made unique. */
  #id(itemId: string | undefined): string {
    const base = itemId === undefined || itemId === '' ? randomUUID() : `${itemId}:prompt`;
    let id = base;
    for (let n = 2; this.#open.has(id); n += 1) id = `${base}:${String(n)}`;
    return id;
  }

  async #command(params: unknown, request: RequestId): Promise<{ decision: CommandDecision }> {
    const id = this.#id(text(property(params, 'itemId')));
    const command = unwrapShell(text(property(params, 'command')) ?? '');
    const reason = text(property(params, 'reason'));
    const network = property(params, 'networkApprovalContext');
    const host = text(property(network, 'host'));
    const decisions = availableDecisions(params);
    const always = alwaysDecision(decisions, host !== undefined);
    const summary =
      host === undefined
        ? firstLine(command)
        : `${text(property(network, 'protocol')) ?? 'https'}://${host}`;
    const answer = await this.#ask(id, request, {
      type: 'permission',
      id,
      tool: 'exec_command',
      summary,
      always: always?.wording ?? null,
      ...(host === undefined && command.includes('\n') ? { detail: output(command) } : {}),
      ...(host !== undefined
        ? { title: `Codex wants to reach ${host}${reason === undefined ? '' : `: ${reason}`}` }
        : reason === undefined
          ? {}
          : { title: reason }),
    });
    if (answer?.kind !== 'permission') return { decision: NOT_ANSWERED };
    switch (answer.answer) {
      case 'once':
        return { decision: 'accept' };
      case 'always':
        return { decision: always?.decision ?? 'accept' };
      case 'deny':
        return { decision: denial(decisions) };
    }
  }

  async #fileChange(
    params: unknown,
    request: RequestId,
  ): Promise<{ decision: FileChangeDecision }> {
    const itemId = text(property(params, 'itemId'));
    const id = this.#id(itemId);
    const patch = itemId === undefined ? undefined : this.#host.patch(itemId);
    const reason = text(property(params, 'reason'));
    const root = text(property(params, 'grantRoot'));
    const title =
      reason ?? (root === undefined ? undefined : `Codex wants to write in ${this.#path(root)}`);
    const answer = await this.#ask(id, request, {
      type: 'permission',
      id,
      tool: 'apply_patch',
      summary: patch?.summary ?? '',
      always: "Yes, and don't ask again for these files",
      ...(patch?.detail === undefined ? {} : { detail: patch.detail }),
      ...(title === undefined ? {} : { title }),
    });
    if (answer?.kind !== 'permission') return { decision: NOT_ANSWERED };
    return {
      decision:
        answer.answer === 'once'
          ? 'accept'
          : answer.answer === 'always'
            ? 'acceptForSession'
            : 'cancel',
    };
  }

  async #permissions(params: unknown, request: RequestId): Promise<unknown> {
    const id = this.#id(text(property(params, 'itemId')));
    const asked = property(params, 'permissions');
    const network = property(asked, 'network');
    const files = property(asked, 'fileSystem');
    const paths = (name: string) => {
      const list = property(files, name);
      return Array.isArray(list)
        ? list.flatMap((file) => (typeof file === 'string' ? [this.#path(file)] : []))
        : [];
    };
    const wanted = [
      ...(property(network, 'enabled') === true ? ['network access'] : []),
      ...(paths('write').length > 0 ? [`write ${paths('write').join(', ')}`] : []),
      ...(paths('read').length > 0 ? [`read ${paths('read').join(', ')}`] : []),
    ];
    const reason = text(property(params, 'reason'));
    const answer = await this.#ask(id, request, {
      type: 'permission',
      id,
      tool: 'permissions',
      summary: wanted.join('; '),
      always: 'Yes, grant these permissions for this session',
      title: `Codex wants more permissions${reason === undefined ? '' : `: ${reason}`}`,
    });
    const granted = {
      ...(network === null || network === undefined ? {} : { network }),
      ...(files === null || files === undefined ? {} : { fileSystem: files }),
    };
    if (answer?.kind !== 'permission' || answer.answer === 'deny') {
      return { permissions: {}, scope: 'turn' };
    }
    return { permissions: granted, scope: answer.answer === 'always' ? 'session' : 'turn' };
  }

  async #questions(params: unknown, request: RequestId): Promise<unknown> {
    const asked = property(params, 'questions');
    const list = Array.isArray(asked) ? asked.slice(0, MAX_QUESTIONS) : [];
    const questions = list.map((question): AskedQuestion => ({
      header: text(property(question, 'header')) ?? '',
      text: text(property(question, 'question')) ?? '',
      options: optionsOf(property(question, 'options')),
      multiple: false,
    }));
    if (questions.length === 0) return { answers: {} };
    const id = this.#id(text(property(params, 'itemId')));
    const answer = await this.#ask(id, request, { type: 'question', id, questions });
    if (answer?.kind !== 'question') return { answers: {} };
    return {
      answers: Object.fromEntries(
        list.map((question, i) => [
          text(property(question, 'id')) ?? String(i),
          { answers: [answer.answers[i] ?? ''] },
        ]),
      ),
    };
  }

  /**
   * An MCP server asks the user for something: a form (a question per field, up to the four
   * corrallm asks at once), or to open a link and say when done. Others are declined.
   */
  async #elicitation(params: unknown, request: RequestId): Promise<unknown> {
    const server = text(property(params, 'serverName')) ?? 'An MCP server';
    const message = text(property(params, 'message')) ?? '';
    const mode = property(params, 'mode');
    const id = this.#id(undefined);
    const respond = (action: 'accept' | 'decline' | 'cancel', content: unknown = null) => ({
      action,
      content,
      _meta: null,
    });
    if (mode === 'url') {
      const url = text(property(params, 'url')) ?? '';
      const answer = await this.#ask(id, request, {
        type: 'question',
        id,
        questions: [
          {
            header: server,
            text: `${message} ${url}`.trim(),
            options: [
              { label: 'Done', description: 'I opened the link and did what it asks' },
              { label: 'Cancel', description: 'Cancel this request' },
            ],
            multiple: false,
          },
        ],
      });
      return respond(
        answer?.kind === 'question' && answer.answers[0] === 'Done' ? 'accept' : 'cancel',
      );
    }
    if (mode !== 'form' && mode !== 'openai/form' && mode !== 'openaiForm') {
      this.#host.emit(
        notice('warning', `${server} asked for something corrallm can't show: it was declined.`),
      );
      return respond('decline');
    }
    const fields = formFields(property(params, 'requestedSchema'));
    if (fields === undefined || fields.length > MAX_QUESTIONS) {
      this.#host.emit(
        notice(
          'warning',
          `${server} asked for more than corrallm can show at once: it was declined.`,
        ),
      );
      return respond('decline');
    }
    const questions: AskedQuestion[] =
      fields.length === 0
        ? [
            {
              header: server,
              text: message,
              options: [
                { label: 'Yes', description: 'Yes, provide the requested info' },
                { label: 'No', description: 'No, but continue without it' },
              ],
              multiple: false,
            },
          ]
        : fields.map((field, i) => ({
            header: field.title,
            text: i === 0 && message !== '' ? `${message} ${field.text}`.trim() : field.text,
            options: field.options.map(({ label }) => ({ label, description: '' })),
            multiple: field.multiple,
          }));
    const answer = await this.#ask(id, request, { type: 'question', id, questions });
    if (answer?.kind !== 'question') return respond('cancel');
    if (fields.length === 0) return respond(answer.answers[0] === 'Yes' ? 'accept' : 'decline', {});
    return respond(
      'accept',
      Object.fromEntries(
        fields.map((field, i) => [field.key, field.value(answer.answers[i] ?? '')]),
      ),
    );
  }

  #path(file: string): string {
    return path.isAbsolute(file) ? displayPath(file, this.#places) : file;
  }
}

/** The decisions a command's approval offers, as Codex lists them (or its usual ones). */
function availableDecisions(params: unknown): unknown[] {
  const listed = property(params, 'availableDecisions');
  if (Array.isArray(listed) && listed.length > 0) return listed;
  const prefix = property(params, 'proposedExecpolicyAmendment');
  return [
    'accept',
    ...(Array.isArray(prefix)
      ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } }]
      : ['acceptForSession']),
    'cancel',
  ];
}

/** What "always" is for a command, as Codex words it: the first decision it offers to keep. */
function alwaysDecision(
  decisions: readonly unknown[],
  network: boolean,
): { decision: CommandDecision; wording: string } | undefined {
  for (const decision of decisions) {
    if (decision === 'acceptForSession') {
      return {
        decision,
        wording: network
          ? 'Yes, and allow this host for this conversation'
          : "Yes, and don't ask again for this command in this session",
      };
    }
    const prefix = property(
      property(decision, 'acceptWithExecpolicyAmendment'),
      'execpolicy_amendment',
    );
    if (Array.isArray(prefix) && prefix.every((part) => typeof part === 'string')) {
      const line = commandLine(prefix);
      if (line.includes('\n') || line.includes('\r')) continue;
      return {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } },
        wording: `Yes, and don't ask again for commands that start with \`${line}\``,
      };
    }
  }
  return undefined;
}

/** How No is said: `cancel` (stop, and tell Codex what to do differently), else `decline`. */
function denial(decisions: readonly unknown[]): CommandDecision {
  return decisions.includes('cancel') || !decisions.includes('decline') ? 'cancel' : 'decline';
}

function optionsOf(value: unknown): AskedQuestion['options'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const label = text(property(option, 'label'));
    return label === undefined
      ? []
      : [{ label, description: text(property(option, 'description')) ?? '' }];
  });
}

/** A field of an MCP form, as a question asks it, and how its answer becomes its value. */
interface FormField {
  key: string;
  title: string;
  text: string;
  options: { label: string; value: string }[];
  multiple: boolean;
  value: (answer: string) => unknown;
}

/** An elicitation form's fields (a flat object of strings, numbers, booleans and choices). */
function formFields(schema: unknown): FormField[] | undefined {
  const properties = property(schema, 'properties');
  if (typeof properties !== 'object' || properties === null) return undefined;
  const fields: FormField[] = [];
  for (const [key, field] of Object.entries(properties)) {
    const title = text(property(field, 'title')) ?? key;
    const said = text(property(field, 'description')) ?? title;
    const kind = property(field, 'type');
    const choices = choicesOf(field) ?? choicesOf(property(field, 'items'));
    if (kind === 'array') {
      if (!choices) return undefined;
      fields.push({
        key,
        title,
        text: said,
        options: choices,
        multiple: true,
        value: (answer) =>
          answer
            .split(', ')
            .map((label) => choices.find((choice) => choice.label === label)?.value ?? label)
            .filter((value) => value !== ''),
      });
    } else if (kind === 'boolean') {
      fields.push({
        key,
        title,
        text: said,
        options: [
          { label: 'Yes', value: 'true' },
          { label: 'No', value: 'false' },
        ],
        multiple: false,
        value: (answer) => /^(yes|y|true)$/i.test(answer.trim()),
      });
    } else if (kind === 'number' || kind === 'integer') {
      fields.push({
        key,
        title,
        text: said,
        options: [],
        multiple: false,
        value: (answer) => {
          const number = Number(answer);
          return Number.isNaN(number) ? answer : number;
        },
      });
    } else if (kind === 'string') {
      fields.push({
        key,
        title,
        text: said,
        options: choices ?? [],
        multiple: false,
        value: (answer) => choices?.find((choice) => choice.label === answer)?.value ?? answer,
      });
    } else {
      return undefined;
    }
  }
  return fields;
}

/** A field's choices: an enum (with names, maybe), or titled constants. */
function choicesOf(field: unknown): { label: string; value: string }[] | undefined {
  const values = property(field, 'enum');
  if (Array.isArray(values)) {
    const names = property(field, 'enumNames');
    return values.flatMap((value: unknown, i) => {
      if (typeof value !== 'string') return [];
      const name: unknown = Array.isArray(names) ? names[i] : undefined;
      return [{ label: typeof name === 'string' ? name : value, value }];
    });
  }
  const consts = property(field, 'oneOf') ?? property(field, 'anyOf');
  if (Array.isArray(consts)) {
    return consts.flatMap((option) => {
      const value = text(property(option, 'const'));
      return value === undefined
        ? []
        : [{ label: text(property(option, 'title')) ?? value, value }];
    });
  }
  return undefined;
}
